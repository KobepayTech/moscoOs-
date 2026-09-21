/**
 * Money that arrives through a payment rail.
 *
 * Two flows run alongside the circle's own money, and the important thing
 * about both is that they are *not* the circle's money in the same way
 * contributions and repayments are:
 *
 *   1. **The loan application fee.** A member pays a fixed fee for their
 *      request to be circulated to sponsors. KobeTech collects it over USSD,
 *      keeps a processing share, and remits the rest to the circle. It is
 *      refundable until the loan is decided, so it is a *liability* when it
 *      lands — not income.
 *
 *   2. **The platform subscription.** Each member pays the platform operator
 *      monthly to use the software. This never touches the circle's books at
 *      all: it is revenue of the operator, and the circle is not a party to
 *      it. The platform tracks it only to know who may use the features it
 *      gates.
 *
 * ## Who bears the processing cost
 *
 * A member pays 50,000 and the circle receives 47,500. The 2,500 is the rail's
 * charge, and it is settled between the member and the rail — the circle never
 * holds it, so it must never appear in the circle's ledger as either income or
 * expense. It is recorded on the payment itself, so the circle can still see
 * what its members are paying in total, but the ledger only ever sees the net.
 *
 * That is also why a refund returns the *net*: the circle can only give back
 * what it actually received. A member is told this before they pay.
 */

import { type Money, applyRate, assertNonNegativeMoney, nonNegative } from './money.js';
import { type ISODate, addDays, daysBetween, isAfter, monthKey, monthKeysBetween } from './dates.js';

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** What a payment is for. */
export type PaymentPurpose =
  | 'loan_application_fee'
  | 'platform_subscription'
  | 'contribution'
  | 'membership_fee'
  | 'loan_repayment';

/**
 * Where a payment has got to.
 *
 * `initiated` means the rail has been asked and the member has a prompt on
 * their handset; nothing has moved yet. Only `confirmed` means money arrived,
 * and only `confirmed` may post to the ledger.
 */
export type PaymentStatus =
  | 'pending'
  | 'initiated'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'refunded';

export interface FeeSplit {
  /** What the member pays. */
  gross: Money;
  /** The rail's charge. Never the circle's money. */
  processingFee: Money;
  /** What reaches the circle — the only part that touches its books. */
  net: Money;
  processingFeeRate: number;
}

/**
 * Split a gross payment into the rail's charge and what the circle receives.
 *
 * The net is derived by subtraction rather than computed independently, so the
 * three figures always reconcile exactly however the rounding falls.
 */
export function splitPlatformFee(gross: Money, processingFeeRate: number): FeeSplit {
  assertNonNegativeMoney(gross, 'gross');

  if (!Number.isFinite(processingFeeRate) || processingFeeRate < 0 || processingFeeRate >= 1) {
    throw new PaymentError(
      `Processing fee rate must fall in [0, 1), got ${processingFeeRate}. A rate of 1 or more would ` +
        'leave the circle with nothing.',
    );
  }

  const processingFee = applyRate(gross, processingFeeRate);
  const net = gross - processingFee;

  if (net < 0) throw new PaymentError('Processing fee cannot exceed the payment');

  return { gross, processingFee, net, processingFeeRate };
}

/** What a member is told before they pay. */
export function describeFeeSplit(split: FeeSplit, currencyFormatter: (amount: Money) => string): string {
  if (split.processingFee === 0) {
    return `${currencyFormatter(split.gross)} in full.`;
  }
  return (
    `${currencyFormatter(split.gross)}, of which ${currencyFormatter(split.processingFee)} ` +
    `(${(split.processingFeeRate * 100).toFixed(1)}%) is the payment charge and ` +
    `${currencyFormatter(split.net)} reaches the circle. If the loan is not approved, ` +
    `${currencyFormatter(split.net)} is refunded — the payment charge is not recoverable.`
  );
}

// ---------------------------------------------------------------------------
// The loan application fee
// ---------------------------------------------------------------------------

export type ApplicationFeeState =
  /** Not paid: the request cannot be circulated to sponsors yet. */
  | 'unpaid'
  /** The member has been prompted on their handset. */
  | 'awaiting_confirmation'
  /** Paid and held. Refundable while the loan is undecided. */
  | 'held'
  /** The loan was approved, so the circle has earned it. */
  | 'earned'
  /** The loan was declined or lapsed, and the net has gone back. */
  | 'refunded';

export interface ApplicationFeeAssessment {
  required: Money;
  split: FeeSplit;
  state: ApplicationFeeState;
  /** Whether sponsor requests may go out. */
  mayCirculate: boolean;
  /** What the member still owes before the application moves. */
  outstanding: Money;
  reason: string;
}

/**
 * Whether a loan application may be circulated to sponsors.
 *
 * The fee gates the *notification*, not the application itself: a member can
 * fill in and price a request for nothing, and only pays when they are ready
 * to ask other people to put their shares behind it. That ordering matters —
 * charging before the applicant knows what they would repay would be charging
 * for information they should have had for free.
 */
export function assessApplicationFee(options: {
  feeAmount: Money;
  processingFeeRate: number;
  state: ApplicationFeeState;
}): ApplicationFeeAssessment {
  const split = splitPlatformFee(options.feeAmount, options.processingFeeRate);

  const mayCirculate = options.state === 'held' || options.state === 'earned';
  const outstanding = mayCirculate || options.state === 'refunded' ? 0 : options.feeAmount;

  const reason = (() => {
    switch (options.state) {
      case 'held':
        return 'The application fee is paid and held. It is refunded if the loan is not approved.';
      case 'earned':
        return 'The loan was approved, so the application fee has been earned by the circle.';
      case 'refunded':
        return 'The loan did not go ahead and the fee has been refunded.';
      case 'awaiting_confirmation':
        return 'Waiting for the payment to be confirmed. Check your handset for the prompt.';
      default:
        return 'The application fee must be paid before your request can be sent to sponsors.';
    }
  })();

  return { required: options.feeAmount, split, state: options.state, mayCirculate, outstanding, reason };
}

// ---------------------------------------------------------------------------
// The platform subscription
// ---------------------------------------------------------------------------

export type SubscriptionStanding = 'current' | 'grace' | 'lapsed' | 'not_started';

export interface SubscriptionStatus {
  standing: SubscriptionStanding;
  /** Months the member should have paid for, from joining to now. */
  monthsDue: number;
  monthsPaid: number;
  monthsMissed: number;
  /** Month the next payment covers. */
  nextPeriod: string;
  /** Amount owed to bring the subscription current. */
  arrears: Money;
  /** Days left before a missed month becomes a lapse. */
  graceDaysRemaining: number;
  /**
   * Features the platform withholds while lapsed.
   *
   * Reading and repaying are never withheld, and neither is voting. A member
   * locked out of seeing their own savings because of a software bill would be
   * indefensible, and a subscription the operator bills for must not be able
   * to disenfranchise someone in their own circle. What lapses is access to
   * the transactional features the subscription pays for.
   */
  withheld: readonly ('borrow' | 'sponsor')[];
}

export function subscriptionStatus(options: {
  joinedOn: ISODate;
  /** `YYYY-MM` periods already paid. */
  paidPeriods: readonly string[];
  monthlyAmount: Money;
  graceDays: number;
  asOf: ISODate;
}): SubscriptionStatus {
  const { joinedOn, paidPeriods, monthlyAmount, graceDays, asOf } = options;

  /*
   * Nobody is in arrears on an invoice that was never issued.
   *
   * Until the operator sets a price, there is no subscription to be behind
   * on, and a member must not be refused a loan from their own circle
   * because a bill nobody has sent them is unpaid. This matters more than it
   * looks: the borrowing gate reads this standing, so a subscription left at
   * zero would otherwise silently freeze lending across the whole circle
   * while every individual rule appeared to be working.
   */
  if (monthlyAmount <= 0) {
    return {
      standing: 'not_started',
      monthsDue: 0,
      monthsPaid: 0,
      monthsMissed: 0,
      nextPeriod: monthKey(asOf),
      arrears: 0,
      graceDaysRemaining: 0,
      withheld: [],
    };
  }

  // A member owes for every month from the one they joined up to the current
  // one, inclusive — the platform is used from the day they arrive.
  const periods = monthKeysBetween(joinedOn, asOf);
  const paid = new Set(paidPeriods);
  const missed = periods.filter((period) => !paid.has(period));

  const monthsDue = periods.length;
  const monthsPaid = periods.length - missed.length;
  const arrears = monthlyAmount * missed.length;

  // The current month is not late until its grace period has run.
  const currentPeriod = monthKey(asOf);
  const overdue = missed.filter((period) => period !== currentPeriod);

  const graceEndsOn = addDays(`${currentPeriod}-01`, graceDays);
  const graceDaysRemaining = isAfter(asOf, graceEndsOn) ? 0 : daysBetween(asOf, graceEndsOn);

  const standing: SubscriptionStanding =
    monthsDue === 0
      ? 'not_started'
      : overdue.length === 0
        ? 'current'
        : overdue.length === 1 && graceDaysRemaining > 0
          ? 'grace'
          : 'lapsed';

  return {
    standing,
    monthsDue,
    monthsPaid,
    monthsMissed: missed.length,
    nextPeriod: missed[0] ?? monthKey(addDays(`${currentPeriod}-01`, 32)),
    arrears: nonNegative(arrears),
    graceDaysRemaining,
    withheld: standing === 'lapsed' ? (['borrow', 'sponsor'] as const) : [],
  };
}

/** Whether a lapsed subscription blocks this particular action. */
export function subscriptionAllows(
  status: SubscriptionStatus,
  action: 'borrow' | 'sponsor' | 'vote' | 'repay' | 'read',
): boolean {
  return !(status.withheld as readonly string[]).includes(action);
}
