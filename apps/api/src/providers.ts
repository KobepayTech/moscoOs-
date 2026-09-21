/**
 * Payment rails.
 *
 * Everything the platform needs from a rail is behind one interface, so the
 * rest of the system never knows which one is in use. Three exist:
 *
 *   - **manual** — the cashier records a cash or bank payment against evidence.
 *     Fully working, and the fallback whenever a rail is unreachable. A circle
 *     must never be unable to take money because an API is down.
 *   - **palmpesa** — collects the monthly platform subscription.
 *   - **kobepay** — collects the loan application fee and remits the net to
 *     the circle's account.
 *
 * PalmPesa and KobePay are declared but not wired: no API specification was
 * available when this was written, so rather than guess at request shapes and
 * signature schemes that would certainly be wrong, they fail loudly with what
 * is missing. Everything around them — intents, idempotency, the state
 * machine, the ledger postings, reconciliation — is built and tested, so
 * finishing each one is an adapter, not a project.
 *
 * What is needed to complete them is listed in `MISSING_INTEGRATION_DETAIL`.
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
}

export interface InitiateResult {
  /** The rail's own identifier for this collection. */
  providerRef: string;
  status: 'initiated' | 'confirmed' | 'failed';
  /** Instructions to show the member, e.g. "dial *150*00# and approve". */
  instruction?: string;
  failureReason?: string;
}

export interface CallbackResult {
  providerRef: string;
  status: 'confirmed' | 'failed';
  /** What the rail says actually moved, which may differ from what was asked. */
  grossAmount?: number;
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
  /** False when credentials or a specification are still missing. */
  readonly configured: boolean;
  /** Whether the rail can push a prompt to a handset. */
  readonly supportsPush: boolean;

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

export const MISSING_INTEGRATION_DETAIL: Record<string, readonly string[]> = {
  palmpesa: [
    'API base URL and environment names (sandbox, production)',
    'credentials and how they are presented (API key, OAuth client credentials, or signed request)',
    'the collection request shape, and whether a USSD push is synchronous or callback-driven',
    'the callback payload shape and its signature scheme (algorithm, which fields are signed, header name)',
    'how recurring monthly collection is expressed — mandate, standing instruction, or a push per month',
    'the refund or reversal endpoint, if one exists',
  ],
  kobepay: [
    'API base URL and environment names',
    'credentials for the circle account that receives the net settlement',
    'the collection request shape and the USSD short code members dial',
    'whether the 5% is deducted by KobePay before remittance, or invoiced separately',
    'the settlement callback: when the net lands, and how a settlement is tied back to a collection',
    'the callback signature scheme',
    'the refund endpoint, and who bears the charge on a refund',
  ],
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
// Rails awaiting their specifications
// ---------------------------------------------------------------------------

abstract class PendingProvider implements PaymentProvider {
  abstract readonly name: string;
  readonly supportsPush = true;

  get configured(): boolean {
    return Boolean(this.secret());
  }

  protected secret(): string | undefined {
    return process.env[`${this.name.toUpperCase()}_WEBHOOK_SECRET`];
  }

  protected missing(): readonly string[] {
    return MISSING_INTEGRATION_DETAIL[this.name] ?? ['an API specification'];
  }

  async initiate(): Promise<InitiateResult> {
    throw new ProviderNotConfiguredError(this.name, this.missing());
  }

  /**
   * Signature check, written against the shape these schemes almost always
   * take: HMAC-SHA256 over the raw body, hex-encoded, in a header.
   *
   * It is deliberately live rather than stubbed — if the real scheme matches
   * this, the adapter is finished; if it differs, this fails closed rather
   * than waving callbacks through. What it must never do is return true
   * without checking.
   */
  verifyCallback(rawBody: string, signature: string | undefined): boolean {
    const key = this.secret();
    if (!key || !signature) return false;

    const expected = createHmac('sha256', key).update(rawBody).digest('hex');
    const given = Buffer.from(signature.replace(/^sha256=/, ''), 'utf8');
    const want = Buffer.from(expected, 'utf8');

    return given.length === want.length && timingSafeEqual(given, want);
  }

  parseCallback(payload: unknown): CallbackResult {
    // Tolerant of the field names these payloads commonly use, so a real
    // callback is likely to parse; anything unrecognised fails closed.
    const body = (payload ?? {}) as Record<string, unknown>;

    const providerRef = String(
      body.reference ?? body.transactionId ?? body.transaction_id ?? body.id ?? '',
    );
    const rawStatus = String(body.status ?? body.result ?? '').toLowerCase();

    if (!providerRef) {
      throw new ProviderNotConfiguredError(this.name, this.missing());
    }

    const confirmed = ['success', 'successful', 'completed', 'confirmed', 'paid'].includes(rawStatus);

    return {
      providerRef,
      status: confirmed ? 'confirmed' : 'failed',
      grossAmount: typeof body.amount === 'number' ? body.amount : undefined,
      failureReason: confirmed ? undefined : (String(body.message ?? rawStatus) || 'declined'),
    };
  }

  async refund(): Promise<never> {
    throw new ProviderNotConfiguredError(this.name, this.missing());
  }
}

/** Collects the monthly platform subscription on behalf of the operator. */
export class PalmPesaProvider extends PendingProvider {
  readonly name = 'palmpesa';
}

/** Collects the loan application fee and remits the net to the circle. */
export class KobePayProvider extends PendingProvider {
  readonly name = 'kobepay';
}

const REGISTRY = new Map<string, PaymentProvider>([
  ['manual', new ManualProvider()],
  ['palmpesa', new PalmPesaProvider()],
  ['kobepay', new KobePayProvider()],
]);

export function providerFor(name: string): PaymentProvider {
  const provider = REGISTRY.get(name);
  if (!provider) {
    throw new Error(`No payment provider called "${name}". Known: ${[...REGISTRY.keys()].join(', ')}`);
  }
  return provider;
}

export function listProviders(): { name: string; configured: boolean; supportsPush: boolean; missing: readonly string[] }[] {
  return [...REGISTRY.values()].map((provider) => ({
    name: provider.name,
    configured: provider.configured,
    supportsPush: provider.supportsPush,
    missing: provider.configured ? [] : (MISSING_INTEGRATION_DETAIL[provider.name] ?? []),
  }));
}
