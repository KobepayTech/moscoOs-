/**
 * A small HTTP router.
 *
 * Just enough to serve the two apps: path patterns with `:params`, JSON bodies
 * in and out, bearer auth, CORS, and errors that carry a code the client can
 * branch on rather than a string it has to match.
 */

import { type IncomingMessage, type ServerResponse } from 'node:http';

import { type Role, verifyToken } from './auth.js';

export interface Principal {
  memberId: string;
  role: Role;
  name: string;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Null on public routes. */
  principal: Principal | null;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface RouteOptions {
  /** Routes are authenticated unless marked public. */
  public?: boolean;
  /** When set, the caller's role must be one of these. */
  roles?: readonly Role[];
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  options: RouteOptions;
}

/** An error carrying an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, detail?: unknown) {
    return new ApiError(400, 'bad_request', message, detail);
  }
  static unauthorized(message = 'Sign in to continue') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message: string) {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message: string) {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string, detail?: unknown) {
    return new ApiError(409, 'conflict', message, detail);
  }
  static unprocessable(message: string, detail?: unknown) {
    return new ApiError(422, 'unprocessable', message, detail);
  }
}

export class Router {
  private readonly routes: Route[] = [];

  /**
   * Called for GET requests that match no API route.
   *
   * Used to serve the admin panel from the same origin as the API, which
   * spares the deployment a second web server and the browser a CORS dance.
   */
  fallback: ((ctx: { req: IncomingMessage; res: ServerResponse; path: string }) => boolean) | null = null;

  /**
   * Look up the caller's *current* role and standing.
   *
   * A token states a role, but roles and memberships change. Without this the
   * token claim would be the authorisation decision, so a member who had been
   * stood down as cashier — or whose membership had been closed — would keep
   * acting on it until the token expired, up to twelve hours later.
   *
   * Wired to the database by the server; left null the router simply trusts
   * the token, which is what the unit tests want.
   */
  resolvePrincipal:
    | ((memberId: string) => { role: Role; name: string; status: string } | null)
    | null = null;

  add(method: string, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    this.routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handler,
      options,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add('POST', pattern, handler, options);
  }
  patch(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add('PATCH', pattern, handler, options);
  }
  delete(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add('DELETE', pattern, handler, options);
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }

    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin ?? '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // A request line the URL parser rejects — `//` and anything else that
    // reads as protocol-relative — is a bad request, not a server fault.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      send(res, 400, { error: { code: 'bad_request', message: 'Malformed request URL' } });
      return;
    }

    try {
      const found = this.match(req.method ?? 'GET', url.pathname);

      // Routing and the static fallback sit inside the try as well: a
      // malformed request line must produce a 4xx, never an exception that
      // escapes and takes the process with it.
      if (!found) {
        if (req.method === 'GET' && this.fallback?.({ req, res, path: url.pathname })) return;
        send(res, 404, {
          error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` },
        });
        return;
      }

      let principal: Principal | null = null;

      if (!found.route.options.public) {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const payload = token ? verifyToken(token) : null;
        if (!payload) throw ApiError.unauthorized();

        principal = { memberId: payload.sub, role: payload.role, name: payload.name };

        if (this.resolvePrincipal) {
          const current = this.resolvePrincipal(payload.sub);
          if (!current) throw ApiError.unauthorized('That membership no longer exists');
          if (current.status === 'exited') {
            throw ApiError.forbidden('This membership has been closed');
          }
          // Standing as it is now, not as it was when the token was issued.
          principal = { memberId: payload.sub, role: current.role, name: current.name };
        }

        const allowed = found.route.options.roles;
        if (allowed && !allowed.includes(principal.role)) {
          throw ApiError.forbidden(
            `This action is limited to: ${allowed.join(', ')}. You are signed in as ${principal.role}.`,
          );
        }
      }

      const body = await readJsonBody(req);
      const result = await found.route.handler({
        req,
        res,
        params: found.params,
        query: url.searchParams,
        body,
        principal,
      });

      if (res.writableEnded) return;
      if (result === undefined) {
        res.writeHead(204).end();
        return;
      }
      send(res, 200, result);
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, {
          error: { code: error.code, message: error.message, detail: error.detail },
        });
        return;
      }

      // Domain errors from @mamogoro/core carry a name and a member-readable
      // message; surface them rather than swallowing them into a 500.
      const name = (error as Error)?.name ?? '';
      if (/Error$/.test(name) && name !== 'Error' && name !== 'TypeError') {
        send(res, 422, {
          error: { code: toSnakeCase(name), message: (error as Error).message },
        });
        return;
      }

      console.error('Unhandled error:', error);
      send(res, 500, {
        error: { code: 'internal_error', message: 'Something went wrong handling that request' },
      });
    }
  }
}

function toSnakeCase(name: string): string {
  return name
    .replace(/Error$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, replacer);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Maps are used throughout the core engine; render them as plain objects. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

const MAX_BODY_BYTES = 1_000_000;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw ApiError.badRequest('Request body is too large');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Input reading
// ---------------------------------------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiError.badRequest('Expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

export function str(body: unknown, field: string, options: { optional?: boolean; max?: number } = {}): string {
  const value = asRecord(body)[field];
  if (value === undefined || value === null || value === '') {
    if (options.optional) return '';
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (typeof value !== 'string') throw ApiError.badRequest(`"${field}" must be text`);
  if (options.max && value.length > options.max) {
    throw ApiError.badRequest(`"${field}" must be at most ${options.max} characters`);
  }
  return value.trim();
}

/** Read an integer amount of shillings, rejecting anything fractional. */
export function moneyField(body: unknown, field: string, options: { optional?: boolean } = {}): number {
  const value = asRecord(body)[field];
  if (value === undefined || value === null) {
    if (options.optional) return 0;
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ApiError.badRequest(`"${field}" must be a number`);
  }
  if (!Number.isInteger(value)) {
    throw ApiError.badRequest(`"${field}" must be a whole number of shillings, not ${value}`);
  }
  if (value < 0) throw ApiError.badRequest(`"${field}" must not be negative`);
  return value;
}

export function intField(
  body: unknown,
  field: string,
  options: { optional?: boolean; min?: number; max?: number; fallback?: number } = {},
): number {
  const value = asRecord(body)[field];
  if (value === undefined || value === null) {
    if (options.fallback !== undefined) return options.fallback;
    if (options.optional) return 0;
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw ApiError.badRequest(`"${field}" must be a whole number`);
  }
  if (options.min !== undefined && value < options.min) {
    throw ApiError.badRequest(`"${field}" must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw ApiError.badRequest(`"${field}" must be at most ${options.max}`);
  }
  return value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dateField(body: unknown, field: string, fallback?: string): string {
  const value = asRecord(body)[field];
  if (value === undefined || value === null || value === '') {
    if (fallback) return fallback;
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw ApiError.badRequest(`"${field}" must be a date in YYYY-MM-DD form`);
  }
  return value;
}

export function enumField<T extends string>(
  body: unknown,
  field: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = asRecord(body)[field];
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw ApiError.badRequest(`"${field}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function arrayField<T = unknown>(body: unknown, field: string, options: { optional?: boolean } = {}): T[] {
  const value = asRecord(body)[field];
  if (value === undefined || value === null) {
    if (options.optional) return [];
    throw ApiError.badRequest(`"${field}" is required`);
  }
  if (!Array.isArray(value)) throw ApiError.badRequest(`"${field}" must be a list`);
  return value as T[];
}
