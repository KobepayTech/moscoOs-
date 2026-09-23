/**
 * Payment rails.
 *
 * Everything the platform needs from a rail is behind one interface, so the
 * rest of the system never knows which one is in use.
 *
 *   - **manual** — the cashier records a cash or bank payment against
 *     evidence. Always available, and what a circle falls back on when a rail
 *     is down. A circle must never be unable to take money because an API is
 *     unreachable.
 *   - **palmpesa** — the USSD push. Collects the loan application fee and the
 *     monthly platform subscription, implemented against the contract KobeOS
 *     already runs in production (`server/src/creators/palmpesa.service.ts`).
 *
 * ## KobePay is not a rail
 *
 * The original brief read "KobeTech collects the fee, deducts 5%, and sends
 * the rest to the MoscoOS account at KobePay", and this file previously
 * modelled KobePay as a second collection provider. Reading KobeOS shows that
 * is not what happens. The thing that talks to a handset over USSD is
 * PalmPesa; KobePay is **where the net lands**, not something MoscoOS calls.
 * There is no payout endpoint in KobeOS, and no KobePay HTTP client.
 *
 * So KobePay is modelled as a settlement destination and reconciled, not
 * invoked — see `settlement.ts`. The distinction matters: an adapter that
 * pretended to call a KobePay API would be inventing an integration, and the
 * first real settlement would disagree with the books.
 *
 * ## Refunds
 *
 * PalmPesa exposes exactly two endpoints — initiate and order status. There is
 * no refund. The circle's application fee *is* refundable, so a refund is a
 * payout somebody makes and records, not a call. `refund()` says so plainly
 * rather than throwing a vague configuration error, because the difference
 * between "not set up yet" and "this rail cannot do that" is the difference
 * between waiting and acting.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InitiateRequest {
  intentId: string;
  /** What the member pays. */
  grossAmount: number;
  currency: string;
  /** Mobile number to push the prompt to. */
  payerPhone: string;
  /** Shown on the member's handset. */
  narrative: string;
  /** Passed back on the callback so it can be matched without a lookup table. */
  reference: string;
  /** Used by rails that require them; PalmPesa does. */
  payerName?: string;
  payerEmail?: string;
}

export interface InitiateResult {
  /** The rail's own identifier for this collection. */
  providerRef: string;
  status: 'initiated' | 'confirmed' | 'failed';
  /** Instructions to show the member, e.g. "approve the prompt on your phone". */
  instruction?: string;
  failureReason?: string;
}

export interface CallbackResult {
  providerRef: string;
  status: 'confirmed' | 'failed' | 'pending';
  /** What the rail says actually moved, which may differ from what was asked. */
  grossAmount?: number;
  /** The mobile-money receipt, which is what a member will quote in a dispute. */
  railReceipt?: string;
  /** Which network carried it. */
  channel?: string;
  failureReason?: string;
}

export interface RefundRequest {
  intentId: string;
  providerRef: string;
  amount: number;
  reason: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** False when credentials are missing. */
  readonly configured: boolean;
  /** Whether the rail can push a prompt to a handset. */
  readonly supportsPush: boolean;
  /** Whether the rail can reverse a collection itself. */
  readonly supportsRefund: boolean;

  initiate(request: InitiateRequest): Promise<InitiateResult>;

  /**
   * Authenticate a callback before believing a word of it.
   *
   * A payment callback says "this member has paid". Acting on an unverified
   * one means anyone who can reach the endpoint can credit any account.
   */
  verifyCallback(rawBody: string, signature: string | undefined): boolean;

  parseCallback(payload: unknown): CallbackResult;

  refund(request: RefundRequest): Promise<{ providerRef: string; status: 'confirmed' | 'failed' }>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: string,
    readonly missing: readonly string[],
  ) {
    super(
      `The ${provider} integration is not configured. Still needed: ${missing.join('; ')}. ` +
        'Record the payment manually in the meantime.',
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * The rail works, but cannot do this.
 *
 * Distinct from `ProviderNotConfiguredError` on purpose: one means wait for
 * credentials, the other means stop waiting and do it another way.
 */
export class ProviderCannotError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly instead: string,
  ) {
    super(`${provider} cannot ${operation}. ${instead}`);
    this.name = 'ProviderCannotError';
  }
}

export const MISSING_INTEGRATION_DETAIL: Record<string, readonly string[]> = {
  palmpesa: ['PALMPESA_API_TOKEN (the live bearer token)', 'MOSCOOS_WEBHOOK_SECRET (to verify callbacks)'],
};

// ---------------------------------------------------------------------------
// Manual — cash and bank, recorded by the cashier
// ---------------------------------------------------------------------------

/**
 * Not really a rail: a record that money changed hands in person, against
 * evidence the cashier holds. It is the only provider that is always
 * available, and it is what a circle falls back on when a rail is down.
 */
export class ManualProvider implements PaymentProvider {
  readonly name = 'manual';
  readonly configured = true;
  readonly supportsPush = false;
  readonly supportsRefund = true;

  async initiate(request: InitiateRequest): Promise<InitiateResult> {
    return {
      providerRef: `manual:${request.intentId}`,
      status: 'initiated',
      instruction: 'Hand the money to the cashier. They will confirm it against a receipt.',
    };
  }

  /** There is no callback: a person confirms it, and the route checks their role. */
  verifyCallback(): boolean {
    return false;
  }

  parseCallback(): CallbackResult {
    throw new Error('Manual payments are confirmed by the cashier, not by a callback');
  }

  async refund(request: RefundRequest): Promise<{ providerRef: string; status: 'confirmed' }> {
    return { providerRef: `manual-refund:${request.intentId}`, status: 'confirmed' };
  }
}

// ---------------------------------------------------------------------------
// PalmPesa
// ---------------------------------------------------------------------------

/** What `/api/palmpesa/initiate` answers with. */
interface PalmPesaInitiateResponse {
  message: string;
  order_id: string;
}

/** One row of `/api/order-status`, and of the `data` array on a callback. */
interface PalmPesaOrderData {
  order_id: string;
  creation_date: string;
  amount: string;
  payment_status: string;
  transid: string;
  channel: string;
  reference: string;
  msisdn: string;
}

interface PalmPesaOrderStatusResponse {
  reference: string;
  resultcode: string;
  result: string;
  message: string;
  data: PalmPesaOrderData[];
}

/** What PalmPesa POSTs to our callback URL. */
interface PalmPesaCallback {
  order_id?: string;
  payment_status?: string;
  reference?: string;
  resultcode?: string;
  data?: PalmPesaOrderData[];
}

const PALMPESA_BASE = 'https://palmpesa.drmlelwa.co.tz';

/**
 * The USSD push.
 *
 * A member dials nothing: the rail pushes a prompt to their handset, they
 * approve it, and a callback arrives. Written against the contract KobeOS
 * already runs, so the two can share one PalmPesa account: same base URL, same
 * two endpoints, same `transaction_id` → callback `reference` correlation, and
 * the same reference-prefix convention that lets each product recognise its
 * own callbacks and ignore everyone else's.
 */
export class PalmPesaProvider implements PaymentProvider {
  readonly name = 'palmpesa';
  readonly supportsPush = true;
  /** PalmPesa has initiate and order-status. That is the whole surface. */
  readonly supportsRefund = false;

  get configured(): boolean {
    return Boolean(this.token() && webhookSecret());
  }

  private token(): string | undefined {
    return process.env.PALMPESA_API_TOKEN || undefined;
  }

  private base(): string {
    return process.env.PALMPESA_BASE_URL || PALMPESA_BASE;
  }

  /** Where PalmPesa should send the callback. */
  private callbackUrl(): string {
    const base = process.env.MOSCOOS_PUBLIC_URL || process.env.APP_PUBLIC_URL || '';
    return `${base.replace(/\/$/, '')}/webhooks/palmpesa`;
  }

  async initiate(request: InitiateRequest): Promise<InitiateResult> {
    if (!this.configured) {
      throw new ProviderNotConfiguredError(this.name, MISSING_INTEGRATION_DETAIL.palmpesa);
    }

    const response = await this.post<PalmPesaInitiateResponse>('/api/palmpesa/initiate', {
      name: request.payerName ?? 'Member',
      email: request.payerEmail ?? 'members@mamogoro.circle',
      phone: normalisePhone(request.payerPhone),
      // The rail takes whole shillings; the engine only ever holds whole
      // shillings, so this rounds nothing in practice.
      amount: Math.round(request.grossAmount),
      // Comes back to us as the callback's `reference`. It is the intent id,
      // so a callback needs no lookup table to be matched.
      transaction_id: request.reference,
      address: 'Tanzania',
      postcode: '00000',
      callback_url: this.callbackUrl(),
    });

    return {
      providerRef: response.order_id,
      status: 'initiated',
      instruction: 'Approve the prompt on your phone. It expires in a few minutes.',
    };
  }

  /** Ask the rail what happened, for when a callback never arrives. */
  async orderStatus(orderId: string): Promise<CallbackResult | null> {
    if (!this.configured) {
      throw new ProviderNotConfiguredError(this.name, MISSING_INTEGRATION_DETAIL.palmpesa);
    }

    const response = await this.post<PalmPesaOrderStatusResponse>('/api/order-status', {
      order_id: orderId,
    });

    const row = response.data?.[0];
    if (!row) return null;

    return {
      providerRef: row.order_id || orderId,
      status: mapStatus(row.payment_status),
      grossAmount: parseAmount(row.amount),
      railReceipt: row.transid || undefined,
      channel: row.channel || undefined,
      failureReason: mapStatus(row.payment_status) === 'failed' ? response.message : undefined,
    };
  }

  /**
   * The signature scheme KobeOS uses on its own webhook endpoint, so one
   * sender can be configured once and reach either system:
   *
   *     x-webhook-signature: HMAC-SHA256(`${WEBHOOK_SECRET}:${provider}`, body).hex
   *
   * Two deliberate differences from the KobeOS implementation. It falls back
   * to a literal `'default-secret'` when the variable is unset, which makes an
   * unconfigured deployment silently forgeable — there is no fallback here, so
   * an unconfigured endpoint refuses everything. And it compares with `!==`,
   * which leaks the expected digest a byte at a time; this compares in
   * constant time.
   *
   * Verified over the **raw bytes as received** rather than a re-serialisation
   * of the parsed body, because re-serialising can reorder keys and produce a
   * different digest from the one the sender actually signed.
   */
  verifyCallback(rawBody: string, signature: string | undefined): boolean {
    const secret = webhookSecret();
    if (!secret || !signature) return false;

    const expected = createHmac('sha256', `${secret}:${this.name}`).update(rawBody).digest('hex');
    const given = Buffer.from(signature.replace(/^sha256=/, '').trim(), 'utf8');
    const want = Buffer.from(expected, 'utf8');

    return given.length === want.length && timingSafeEqual(given, want);
  }

  /**
   * Read a callback.
   *
   * The `data` array is present on some callbacks and not others, so the
   * top-level fields are the source of truth and `data[0]` only enriches. A
   * callback with no reference is not ours and is refused rather than guessed
   * at — the same PalmPesa account serves several products, and acting on
   * somebody else's callback would credit the wrong book.
   */
  parseCallback(payload: unknown): CallbackResult {
    const body = (payload ?? {}) as PalmPesaCallback;
    const row = body.data?.[0];

    const providerRef = body.reference || row?.reference || body.order_id || row?.order_id || '';
    if (!providerRef) {
      throw new Error('PalmPesa callback carried neither a reference nor an order id');
    }

    const status = mapStatus(body.payment_status ?? row?.payment_status);

    return {
      providerRef,
      status,
      grossAmount: row ? parseAmount(row.amount) : undefined,
      railReceipt: row?.transid || undefined,
      channel: row?.channel || undefined,
      failureReason: status === 'failed' ? (body.payment_status ?? 'declined') : undefined,
    };
  }

  /**
   * PalmPesa cannot reverse a collection.
   *
   * The circle still owes the money back when a loan does not go ahead, so
   * this is a payout somebody makes and records — not something to wait on a
   * rail for.
   */
  async refund(_request: RefundRequest): Promise<never> {
    throw new ProviderCannotError(
      'PalmPesa',
      'reverse a collection — the rail exposes only initiate and order-status',
      'Pay the member back over mobile money or in cash and record it as a manual refund against ' +
        'the intent, which posts the same reversal to the books.',
    );
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PalmPesa ${path} returned ${response.status}: ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`PalmPesa ${path} returned a response that is not JSON: ${text.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function webhookSecret(): string | undefined {
  return process.env.MOSCOOS_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || undefined;
}

/**
 * Tanzanian numbers, as the rail wants them: digits only, 255 prefix.
 *
 * Members write their number every way there is — +255…, 0…, 7… — and a
 * payment that fails because of a leading zero looks to them like the circle
 * losing their money.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('255')) return digits;
  if (digits.startsWith('0')) return `255${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('6')) return `255${digits}`;
  return digits;
}

/** PalmPesa sends amounts as strings. */
function parseAmount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

/**
 * PENDING is its own answer, not a failure.
 *
 * A member who has not yet approved the prompt on their handset has not
 * declined it, and treating the two alike would fail a payment that is about
 * to succeed.
 */
function mapStatus(raw: string | undefined): 'confirmed' | 'failed' | 'pending' {
  switch (String(raw ?? '').toUpperCase()) {
    case 'COMPLETED':
      return 'confirmed';
    case 'PENDING':
      return 'pending';
    default:
      return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, PaymentProvider>([
  ['manual', new ManualProvider()],
  ['palmpesa', new PalmPesaProvider()],
]);

export function providerFor(name: string): PaymentProvider {
  const provider = REGISTRY.get(name);
  if (!provider) {
    throw new Error(`No payment provider called "${name}". Known: ${[...REGISTRY.keys()].join(', ')}`);
  }
  return provider;
}

export function listProviders(): {
  name: string;
  configured: boolean;
  supportsPush: boolean;
  supportsRefund: boolean;
  missing: readonly string[];
}[] {
  return [...REGISTRY.values()].map((provider) => ({
    name: provider.name,
    configured: provider.configured,
    supportsPush: provider.supportsPush,
    supportsRefund: provider.supportsRefund,
    missing: provider.configured ? [] : (MISSING_INTEGRATION_DETAIL[provider.name] ?? []),
  }));
}
