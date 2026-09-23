/**
 * Settlement: proving the money actually arrived.
 *
 * Confirming a payment and receiving it are not the same event, and the gap
 * between them is where money goes missing without anybody noticing.
 *
 * When a member approves a USSD prompt, the rail tells MoscoOS the collection
 * succeeded and the books record the net. But the cash is still with the
 * operator at that moment. It reaches the circle's KobePay account later, on
 * the rail's own settlement cycle, in a batch alongside everybody else's. So
 * between confirmation and settlement the books assert the circle holds money
 * it has not yet been given — correctly, because it is owed, but a circle that
 * never checks the second half has no way to discover that a settlement was
 * short, late, or never came at all.
 *
 * ## Why this is reconciliation and not an API call
 *
 * There is no endpoint to ask. KobePay is an account, not a service MoscoOS
 * can call: nothing in KobeOS exposes a payout, a settlement query or a
 * statement feed. The settlement lines come in the way they come — a
 * statement, an export, a screen somebody reads — and the circle's job is to
 * match them against what it believes it collected.
 *
 * That makes this module a matcher rather than a client, and the design
 * follows: it takes two lists and says what agrees, what does not, and what to
 * do about each. Pure, like the rest of the engine, so the same function
 * handles a file upload, a pasted statement or a future feed without knowing
 * the difference.
 *
 * ## What a treasurer should have to read
 *
 * Not two hundred matching lines. The whole point is that agreement is
 * uninteresting and only exceptions deserve a person's attention:
 *
 *     247 settlements matched. 3 need attention.
 *       · TSh 47,500 collected on 12 Sept has not settled (11 days)
 *       · TSh 47,500 expected, TSh 45,000 received — short by TSh 2,500
 *       · TSh 100,000 arrived against no collection
 *
 * Each of those is a different problem with a different answer, which is why
 * they are separate kinds rather than one "mismatch" list.
 */

import { type ISODate, assertISODate, compareDates, daysBetween, isOnOrBefore } from './dates.js';
import { type Money, sum } from './money.js';

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementError';
  }
}

/**
 * One credit on the circle's settlement account.
 *
 * Read off a statement, so everything but the amount and the date is
 * optional — a bank line may carry a narrative and nothing else.
 */
export interface SettlementLine {
  /** Whatever identifies this line on the statement. */
  id: string;
  /** What actually landed. */
  amount: Money;
  settledOn: ISODate;
  /** The collection reference, where the statement carries one. */
  reference?: string;
  /** The mobile-money receipt, which often survives where the reference does not. */
  railReceipt?: string;
  /** The statement's own words, searched as a last resort. */
  narrative?: string;
}

/** A collection MoscoOS believes succeeded, awaiting its money. */
export interface CollectedPayment {
  intentId: string;
  /** What the circle should receive: the net, after the rail's share. */
  expectedNet: Money;
  confirmedOn: ISODate;
  /** The reference sent to the rail, which is the intent id. */
  reference: string;
  railReceipt?: string;
  purpose: string;
  memberId: string;
}

export type MatchBasis = 'reference' | 'receipt' | 'narrative';

export interface SettlementMatch {
  payment: CollectedPayment;
  line: SettlementLine;
  basis: MatchBasis;
  /** Received less expected. Negative means the circle was paid short. */
  variance: Money;
  /** Days between confirming the collection and the money landing. */
  daysToSettle: number;
}

export type ExceptionKind =
  /** Collected, confirmed, and the money has not arrived. */
  | 'awaiting_settlement'
  /** Collected and still not settled beyond the tolerated wait. */
  | 'overdue_settlement'
  /** Matched, but the amounts disagree. */
  | 'short_settlement'
  /** Matched, and more arrived than was collected. */
  | 'over_settlement'
  /** Money arrived that no collection explains. */
  | 'unexpected_credit';

export interface SettlementException {
  kind: ExceptionKind;
  /** One line, as a treasurer would read it. */
  summary: string;
  amount: Money;
  /** Present on everything but an unexpected credit. */
  payment?: CollectedPayment;
  /** Present on everything but an unsettled collection. */
  line?: SettlementLine;
  /** How long this has been outstanding, where that is the point. */
  ageDays?: number;
}

export interface SettlementReport {
  asOf: ISODate;
  matched: SettlementMatch[];
  exceptions: SettlementException[];
  totals: {
    /** What the books say was collected, net of the rail's share. */
    expected: Money;
    /** What the settlement account actually received. */
    received: Money;
    /** Received less expected, across matched lines only. */
    variance: Money;
    /** Collected and not yet settled. */
    inTransit: Money;
  };
  /** The line a treasurer reads instead of the tables. */
  headline: string;
  /** True when nothing needs a person. */
  clean: boolean;
}

export interface SettlementOptions {
  asOf: ISODate;
  /**
   * Days a settlement may take before it is somebody's problem.
   *
   * Below this, an unsettled collection is simply in transit and not worth
   * anyone's attention. Above it, the circle should be asking the operator.
   */
  toleratedDelayDays?: number;
  /**
   * Variance ignored on a match, in shillings.
   *
   * Zero by default, and it should stay zero: the whole system is integer
   * shillings precisely so that "close enough" never enters the books. It
   * exists only for a rail that rounds, and a circle that needs it should know
   * it has turned a check off.
   */
  toleranceShillings?: Money;
  formatAmount?: (amount: Money) => string;
}

/**
 * Match what was collected against what arrived.
 *
 * Matching is tried in descending order of how much a match can be trusted:
 * the reference we sent, then the rail's receipt, then the statement's
 * narrative. A narrative match is a guess and is reported as one — the basis
 * travels with every match so a treasurer can see *why* two lines were paired
 * before accepting it.
 */
export function reconcileSettlement(
  collected: readonly CollectedPayment[],
  lines: readonly SettlementLine[],
  options: SettlementOptions,
): SettlementReport {
  assertISODate(options.asOf, 'asOf');

  const tolerated = options.toleratedDelayDays ?? 3;
  const tolerance = options.toleranceShillings ?? 0;
  const amount = options.formatAmount ?? ((value: Money) => String(value));

  for (const line of lines) {
    assertISODate(line.settledOn, 'settlementLine.settledOn');
    if (line.amount <= 0) {
      throw new SettlementError(`Settlement line ${line.id} credits ${line.amount}; a credit must be positive`);
    }
  }

  const unclaimed = new Map(lines.map((line) => [line.id, line]));
  const matched: SettlementMatch[] = [];
  const exceptions: SettlementException[] = [];

  // A line may only settle one collection, so each is removed as it is taken.
  const claim = (payment: CollectedPayment): { line: SettlementLine; basis: MatchBasis } | null => {
    for (const [id, line] of unclaimed) {
      if (line.reference && line.reference === payment.reference) {
        unclaimed.delete(id);
        return { line, basis: 'reference' };
      }
    }
    for (const [id, line] of unclaimed) {
      if (line.railReceipt && payment.railReceipt && line.railReceipt === payment.railReceipt) {
        unclaimed.delete(id);
        return { line, basis: 'receipt' };
      }
    }
    for (const [id, line] of unclaimed) {
      if (line.narrative && line.narrative.includes(payment.reference)) {
        unclaimed.delete(id);
        return { line, basis: 'narrative' };
      }
    }
    return null;
  };

  // Oldest first: when two collections could take the same line, the one that
  // has been waiting longest has the better claim on it.
  const byAge = collected
    .slice()
    .sort((a, b) => compareDates(a.confirmedOn, b.confirmedOn) || (a.intentId < b.intentId ? -1 : 1));

  for (const payment of byAge) {
    const found = claim(payment);

    if (!found) {
      const age = daysBetween(payment.confirmedOn, options.asOf);
      const overdue = age > tolerated;

      exceptions.push({
        kind: overdue ? 'overdue_settlement' : 'awaiting_settlement',
        summary: overdue
          ? `${amount(payment.expectedNet)} collected on ${payment.confirmedOn} has not settled (${age} days). ` +
            'Ask the operator.'
          : `${amount(payment.expectedNet)} collected on ${payment.confirmedOn} is still in transit.`,
        amount: payment.expectedNet,
        payment,
        ageDays: age,
      });
      continue;
    }

    const variance = found.line.amount - payment.expectedNet;
    matched.push({
      payment,
      line: found.line,
      basis: found.basis,
      variance,
      daysToSettle: daysBetween(payment.confirmedOn, found.line.settledOn),
    });

    if (Math.abs(variance) > tolerance) {
      exceptions.push({
        kind: variance < 0 ? 'short_settlement' : 'over_settlement',
        summary:
          variance < 0
            ? `${amount(payment.expectedNet)} expected, ${amount(found.line.amount)} received — short by ` +
              `${amount(-variance)}.`
            : `${amount(payment.expectedNet)} expected, ${amount(found.line.amount)} received — ` +
              `${amount(variance)} more than collected.`,
        amount: Math.abs(variance),
        payment,
        line: found.line,
      });
    }
  }

  // Whatever is left arrived without a collection to explain it. Not
  // necessarily wrong — it may be a member paying the account directly — but
  // unexplained money in a circle's account is always somebody's question.
  for (const line of unclaimed.values()) {
    exceptions.push({
      kind: 'unexpected_credit',
      summary:
        `${amount(line.amount)} arrived on ${line.settledOn} against no collection` +
        (line.narrative ? ` (${line.narrative})` : '') +
        '. Find out whose it is before spending it.',
      amount: line.amount,
      line,
    });
  }

  const expected = sum(matched.map((match) => match.payment.expectedNet));
  const received = sum(matched.map((match) => match.line.amount));
  const inTransit = sum(
    exceptions
      .filter((item) => item.kind === 'awaiting_settlement' || item.kind === 'overdue_settlement')
      .map((item) => item.amount),
  );

  return {
    asOf: options.asOf,
    matched,
    exceptions,
    totals: { expected, received, variance: received - expected, inTransit },
    headline: headlineFor(matched.length, exceptions),
    clean: exceptions.every((item) => item.kind === 'awaiting_settlement'),
  };
}

/**
 * The one line worth reading.
 *
 * Collections still within the tolerated window are counted as settled for
 * this purpose: money in transit is the system working, not a problem, and
 * reporting it as one teaches a treasurer to ignore the report.
 */
function headlineFor(matchedCount: number, exceptions: readonly SettlementException[]): string {
  const needsAttention = exceptions.filter((item) => item.kind !== 'awaiting_settlement');
  const inTransit = exceptions.length - needsAttention.length;

  const parts = [`${matchedCount} settlement${matchedCount === 1 ? '' : 's'} matched`];
  if (inTransit > 0) parts.push(`${inTransit} in transit`);

  if (needsAttention.length === 0) {
    parts.push('nothing needs attention');
    return `${parts.join(', ')}.`;
  }

  parts.push(`${needsAttention.length} need${needsAttention.length === 1 ? 's' : ''} attention`);
  return `${parts.join(', ')}.`;
}

/**
 * Money the books count as the circle's that has not actually arrived.
 *
 * Worth separating from cash on hand. A circle that has confirmed a hundred
 * collections and received none of them is not as liquid as its balance sheet
 * says, and the difference is exactly this figure.
 */
export function cashInTransit(
  collected: readonly CollectedPayment[],
  lines: readonly SettlementLine[],
  asOf: ISODate,
): Money {
  const report = reconcileSettlement(collected, lines, { asOf });
  return report.totals.inTransit;
}

/** Collections settled within a window, for a period report. */
export function settledBetween(
  report: SettlementReport,
  from: ISODate,
  to: ISODate,
): SettlementMatch[] {
  return report.matched.filter(
    (match) => compareDates(match.line.settledOn, from) >= 0 && isOnOrBefore(match.line.settledOn, to),
  );
}
