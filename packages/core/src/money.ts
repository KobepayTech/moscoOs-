/**
 * Money primitives.
 *
 * Money is represented as a safe integer number of *minor units*. For TZS the
 * minor unit is one shilling (the cent is not used in practice), so 5,000,000
 * means TSh 5,000,000. Keeping money as integers removes every class of
 * floating-point drift from the ledger: a circle's books must reconcile to the
 * shilling, not to "close enough".
 *
 * Rates (interest, penalty, ownership) stay as plain floats because they are
 * ratios, not amounts. Every crossing from rate-land back to money-land goes
 * through `applyRate` or `allocate`, both of which round deterministically.
 */

export type Money = number;

export const ZERO: Money = 0;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Narrow an arbitrary value to Money without throwing. */
export function isMoney(value: unknown): value is Money {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Coerce a number to Money, rounding half away from zero.
 *
 * Half-away-from-zero (rather than JS's default half-up, which biases negative
 * values toward zero) keeps a debit and its mirrored credit the same size.
 */
export function money(value: number): Money {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError(`Not a finite number: ${String(value)}`);
  }
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  if (!Number.isSafeInteger(rounded)) {
    throw new MoneyError(`Amount outside safe integer range: ${value}`);
  }
  return rounded;
}

/** Assert that a value is Money, returning it. Used at trust boundaries. */
export function assertMoney(value: unknown, label = 'amount'): Money {
  if (!isMoney(value)) {
    throw new MoneyError(`${label} must be an integer amount of minor units, got ${String(value)}`);
  }
  return value;
}

/** Assert that a value is Money and non-negative. */
export function assertNonNegativeMoney(value: unknown, label = 'amount'): Money {
  const amount = assertMoney(value, label);
  if (amount < 0) throw new MoneyError(`${label} must not be negative, got ${amount}`);
  return amount;
}

export function sum(amounts: readonly Money[]): Money {
  let total = 0;
  for (const amount of amounts) total += amount;
  if (!Number.isSafeInteger(total)) throw new MoneyError('Sum overflowed the safe integer range');
  return total;
}

export function max(a: Money, b: Money): Money {
  return a > b ? a : b;
}

export function min(a: Money, b: Money): Money {
  return a < b ? a : b;
}

/** Clamp to the closed interval [0, ceiling]. */
export function clamp(amount: Money, ceiling: Money): Money {
  if (amount < 0) return 0;
  return amount > ceiling ? ceiling : amount;
}

export function nonNegative(amount: Money): Money {
  return amount < 0 ? 0 : amount;
}

/** Apply a rate to a principal, rounding to the minor unit. */
export function applyRate(principal: Money, rate: number): Money {
  if (!Number.isFinite(rate)) throw new MoneyError(`Rate must be finite, got ${rate}`);
  return money(principal * rate);
}

/**
 * Split `total` across `weights` so that the parts sum to *exactly* `total`.
 *
 * Uses the largest-remainder method: floor every exact share, then hand the
 * leftover minor units to the entries with the largest discarded fractions.
 * This is what keeps a dividend run, an interest levelisation or a sponsor
 * loss-cascade from leaving an orphaned shilling behind.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    if (total !== 0) throw new MoneyError('Cannot allocate a non-zero total across zero weights');
    return [];
  }
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new MoneyError(`Allocation weights must be finite and non-negative, got ${weight}`);
    }
  }

  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  if (totalWeight === 0) {
    if (total !== 0) throw new MoneyError('Cannot allocate a non-zero total across zero total weight');
    return weights.map(() => 0);
  }

  // Work on the magnitude so rounding behaves symmetrically for refunds.
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const exact = weights.map((w) => (magnitude * w) / totalWeight);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = magnitude - floors.reduce((acc, value) => acc + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));

  const parts = floors.slice();
  for (let i = 0; remainder > 0; i = (i + 1) % order.length) {
    parts[order[i].index] += 1;
    remainder -= 1;
  }

  return parts.map((part) => sign * part);
}

/** Split `total` into `count` parts that differ by at most one minor unit. */
export function allocateEvenly(total: Money, count: number): Money[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new MoneyError(`Count must be a non-negative integer, got ${count}`);
  }
  return allocate(total, new Array(count).fill(1));
}

/** Ratio of `part` to `whole`, guarding the zero denominator. */
export function ratio(part: Money, whole: Money): number {
  if (whole === 0) return 0;
  return part / whole;
}

const GROUPING = /\B(?=(\d{3})+(?!\d))/g;

/** Render money for humans: `formatMoney(5_000_000)` -> `"TSh 5,000,000"`. */
export function formatMoney(amount: Money, currency = 'TZS'): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const sign = amount < 0 ? '-' : '';
  const digits = Math.abs(amount).toFixed(0).replace(GROUPING, ',');
  return `${sign}${symbol} ${digits}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  TZS: 'TSh',
  KES: 'KSh',
  UGX: 'USh',
  RWF: 'FRw',
  USD: '$',
};

/** Render a rate as a percentage string, e.g. `0.025` -> `"2.5%"`. */
export function formatRate(rate: number, decimals = 2): string {
  return `${(rate * 100).toFixed(decimals).replace(/\.?0+$/, '')}%`;
}
