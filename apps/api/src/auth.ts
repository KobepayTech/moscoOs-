/**
 * Authentication.
 *
 * Passwords are hashed with scrypt and tokens are HMAC-signed, both from
 * `node:crypto` — no dependency, and nothing here is novel cryptography. The
 * token is a signed statement of "who" and "until when"; there is no server
 * session to lose, which matters for a phone on an intermittent connection.
 *
 * Roles are thin on purpose. Every member can read everything the circle does;
 * the only privileged act is *recording money* (the cashier) and enrolling
 * members (the secretary). Deleting records is nobody's privilege — it goes to
 * a vote.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type Role = 'member' | 'cashier' | 'secretary' | 'chair';

export interface TokenPayload {
  sub: string;
  role: Role;
  name: string;
  /** Unix seconds. */
  exp: number;
}

const SCRYPT_KEYLEN = 64;
const TOKEN_TTL_SECONDS = 60 * 60 * 12;

/**
 * Ephemeral key, generated once per process when none is configured.
 *
 * There is deliberately no constant fallback. A signing key written into the
 * source is a published key: anyone who can read the repository can mint a
 * token claiming any member id and the `chair` role, and every authorisation
 * check in the system would honour it. Guarding that behind `NODE_ENV` is not
 * enough, because nothing in the documented way of running this server sets
 * `NODE_ENV` — the default path would have used the published key.
 *
 * Generating a random key instead fails closed. Sessions do not survive a
 * restart, which is a visible nuisance in development and impossible to
 * mistake for a working production setup.
 */
let ephemeralKey: string | null = null;

function secret(): string {
  const configured = process.env.MAMOGORO_SECRET;
  if (configured && configured.length >= 16) return configured;

  if (configured && configured.length < 16) {
    throw new Error(
      `MAMOGORO_SECRET is only ${configured.length} characters. Use at least 16 — a short key can be ` +
        'searched offline, and forging one token is enough to take over the circle.',
    );
  }

  if (!ephemeralKey) {
    ephemeralKey = randomBytes(32).toString('hex');
    console.warn(
      'MAMOGORO_SECRET is not set. Signing tokens with a random key generated for this process: ' +
        'everyone will be signed out when it restarts. Set MAMOGORO_SECRET before deploying.',
    );
  }

  return ephemeralKey;
}

export function hashPassword(password: string): string {
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (derived.length !== expectedBuffer.length) return false;

  return timingSafeEqual(derived, expectedBuffer);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadPart: string): string {
  return createHmac('sha256', secret()).update(payloadPart).digest('base64url');
}

export function issueToken(payload: Omit<TokenPayload, 'exp'>, ttlSeconds = TOKEN_TTL_SECONDS): string {
  const full: TokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = base64url(JSON.stringify(full));
  return `${body}.${sign(body)}`;
}

/**
 * Verify a token and return its payload, or null.
 *
 * Returns null for every failure mode rather than distinguishing them: a
 * caller that can tell "bad signature" from "expired" learns something about
 * the key it should not.
 */
export function verifyToken(token: string): TokenPayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Roles permitted to record money movements. */
export const CASHIER_ROLES: readonly Role[] = ['cashier', 'chair'];

/** Roles permitted to enrol and amend members. */
export const REGISTRAR_ROLES: readonly Role[] = ['secretary', 'chair'];

export function hasRole(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}
