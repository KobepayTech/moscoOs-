/**
 * The capital engine.
 *
 * Everything else in this package answers a question about one loan, one
 * member or one facility. This answers questions about the circle as a whole,
 * and about the future rather than the past:
 *
 *   - how much can we safely lend *right now*, and what is the binding limit?
 *   - how much is coming back over the next week, month and quarter?
 *   - how much of our capital is tied up as collateral rather than working?
 *   - is too much of the book sitting with one borrower, or behind one
 *     sponsor?
 *   - which of the requests waiting can we actually fund, and if not today,
 *     when?
 *
 * The difference this makes is the difference between a book-keeping system
 * and a treasury. A ledger tells a committee what happened; this tells them
 * what they can do.
 *
 * ## Available is not the same as spendable
 *
 * Two numbers get confused constantly and the engine keeps them apart:
 *
 *   - **available** — capital the circle's own policy says may be lent:
 *     total capital less what is already out.
 *   - **cash on hand** — money actually in the account.
 *
 * They diverge because cash includes amounts the circle is holding but does
 * not own: application fees awaiting a decision, members' savings balances,
 * a facility drawn but not yet lent. A circle can look under-lent on paper
 * and still be unable to disburse. What can actually go out of the door is
 * the lower of the two, and that is what a cashier needs to be told.
 */

import { type ISODate, addDays, assertISODate, daysBetween, isAfter, isOnOrBefore } from './dates.js';
import { type CircleConfig } from './config.js';
import { type Facility, facilityOutstanding } from './facility.js';
import { type Money, nonNegative, ratio, sum } from './money.js';

export class CapitalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapitalError';
  }
}

/** One instalment still to come. */
export interface UpcomingInstalment {
  dueOn: ISODate;
  principal: Money;
  interest: Money;
  total: Money;
}

/** A live loan, as the capital engine needs to see it. */
export interface LoanSnapshot {
  loanId: string;
  memberId: string;
  originalPrincipal: Money;
  principalOutstanding: Money;
  status: string;
  /** Instalments not yet settled, in date order. */
  upcoming: UpcomingInstalment[];
  /** Amount already overdue as at the valuation date. */
  arrears: Money;
  daysPastDue: number;
}

/** What one sponsor still has locked behind one loan. */
export interface CollateralCommitment {
  sponsorId: string;
  loanId: string;
  pledged: Money;
  atRisk: Money;
}

/** A request waiting for money. */
export interface PendingRequest {
  loanId: string;
  memberId: string;
  principal: Money;
  fullyCovered: boolean;
  /** Ready to pay out — cover complete and approved. */
  approved: boolean;
}

export interface CapitalInputs {
  asOf: ISODate;
  /** Member share capital. */
  equityPool: Money;
  /** Cash actually in the account, from the ledger. */
  cashOnHand: Money;
  facilities: readonly Facility[];
  loans: readonly LoanSnapshot[];
  collateral: readonly CollateralCommitment[];
  pending: readonly PendingRequest[];
}

// ---------------------------------------------------------------------------
// Expected inflows
// ---------------------------------------------------------------------------

export interface ExpectedInflow {
  windowDays: number;
  through: ISODate;
  principal: Money;
  interest: Money;
  total: Money;
  instalmentCount: number;
  /**
   * The part owed by borrowers already behind.
   *
   * Counted separately because a member who missed last month's instalment is
   * the least likely to make next month's, and a forecast that treats the two
   * alike will promise money that does not arrive.
   */
  fromBorrowersInArrears: Money;
  /** The forecast excluding borrowers already behind. */
  dependable: Money;
}

/**
 * What is scheduled to come back over each window.
 *
 * Arrears already overdue are *not* counted as future inflow — they were due
 * in the past, and folding them into "expected in the next 7 days" would let
 * a circle plan on money that is already late.
 */
export function expectedInflows(
  loans: readonly LoanSnapshot[],
  asOf: ISODate,
  windows: readonly number[] = [7, 30, 90],
): ExpectedInflow[] {
  assertISODate(asOf, 'asOf');

  return windows.map((windowDays) => {
    const through = addDays(asOf, windowDays);

    let principal = 0;
    let interest = 0;
    let instalmentCount = 0;
    let fromBorrowersInArrears = 0;

    for (const loan of loans) {
      const behind = loan.arrears > 0 || loan.daysPastDue > 0;

      for (const instalment of loan.upcoming) {
        // Strictly ahead of today and within the window.
        if (!isAfter(instalment.dueOn, asOf)) continue;
        if (!isOnOrBefore(instalment.dueOn, through)) continue;

        principal += instalment.principal;
        interest += instalment.interest;
        instalmentCount += 1;
        if (behind) fromBorrowersInArrears += instalment.total;
      }
    }

    const total = principal + interest;

    return {
      windowDays,
      through,
      principal,
      interest,
      total,
      instalmentCount,
      fromBorrowersInArrears,
      dependable: nonNegative(total - fromBorrowersInArrears),
    };
  });
}

// ---------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------

export interface ConcentrationEntry {
  memberId: string;
  amount: Money;
  share: number;
}

export interface Concentration {
  /** Borrowers ranked by outstanding principal. */
  borrowers: ConcentrationEntry[];
  /** Sponsors ranked by what they still have locked. */
  sponsors: ConcentrationEntry[];
  largestBorrower: ConcentrationEntry | null;
  largestSponsor: ConcentrationEntry | null;
  /**
   * Herfindahl index of the loan book: the sum of squared shares.
   *
   * 1.0 means a single borrower holds everything; 1/n means it is spread
   * perfectly across n borrowers. A single number the committee can watch
   * move, where a list of borrowers is only a list.
   */
  borrowerHerfindahl: number;
  /** How few borrowers account for half the book. */
  borrowersToHalfTheBook: number;
}

function rank(totals: Map<string, Money>): ConcentrationEntry[] {
  const total = sum([...totals.values()]);
  return [...totals.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([memberId, amount]) => ({ memberId, amount, share: ratio(amount, total) }))
    .sort((a, b) => b.amount - a.amount);
}

export function concentration(
  loans: readonly LoanSnapshot[],
  collateral: readonly CollateralCommitment[],
): Concentration {
  const byBorrower = new Map<string, Money>();
  for (const loan of loans) {
    if (loan.principalOutstanding <= 0) continue;
    byBorrower.set(loan.memberId, (byBorrower.get(loan.memberId) ?? 0) + loan.principalOutstanding);
  }

  const bySponsor = new Map<string, Money>();
  for (const commitment of collateral) {
    if (commitment.atRisk <= 0) continue;
    bySponsor.set(commitment.sponsorId, (bySponsor.get(commitment.sponsorId) ?? 0) + commitment.atRisk);
  }

  const borrowers = rank(byBorrower);
  const sponsors = rank(bySponsor);

  const borrowerHerfindahl = borrowers.reduce((total, entry) => total + entry.share * entry.share, 0);

  let running = 0;
  let borrowersToHalfTheBook = 0;
  for (const entry of borrowers) {
    running += entry.share;
    borrowersToHalfTheBook += 1;
    if (running >= 0.5) break;
  }

  return {
    borrowers,
    sponsors,
    largestBorrower: borrowers[0] ?? null,
    largestSponsor: sponsors[0] ?? null,
    borrowerHerfindahl,
    borrowersToHalfTheBook,
  };
}

// ---------------------------------------------------------------------------
// What can be funded
// ---------------------------------------------------------------------------

export interface FundingVerdict {
  loanId: string;
  memberId: string;
  principal: Money;
  fundableNow: boolean;
  /** Days until expected inflows would cover it. Null if not within 90 days. */
  fundableInDays: number | null;
  /** Date it becomes fundable, on current expectations. */
  fundableOn: ISODate | null;
  reason: string;
}

/**
 * Work through the queue of approved requests in order, spending the cash.
 *
 * Sequential rather than independent: the second request can only be funded
 * from what the first one leaves. Answering each in isolation would tell a
 * committee it can fund four loans it can only fund one of.
 *
 * Requests are taken oldest-first by the order given, which is the fair
 * reading of a queue.
 */
export function fundingPlan(
  pending: readonly PendingRequest[],
  spendableNow: Money,
  inflows: readonly ExpectedInflow[],
  asOf: ISODate,
  formatAmount: (amount: Money) => string = (value) => String(value),
): FundingVerdict[] {
  const format = formatAmount;
  let purse = spendableNow;

  // Only the dependable part of each forecast is used to promise a date;
  // money owed by members already behind is not something to plan on.
  const byWindow = [...inflows].sort((a, b) => a.windowDays - b.windowDays);

  return pending.map((request) => {
    if (!request.approved) {
      return {
        loanId: request.loanId,
        memberId: request.memberId,
        principal: request.principal,
        fundableNow: false,
        fundableInDays: null,
        fundableOn: null,
        reason: request.fullyCovered
          ? 'Cover is complete but the loan has not been approved yet'
          : 'Still gathering sponsor cover',
      };
    }

    if (purse >= request.principal) {
      purse -= request.principal;
      return {
        loanId: request.loanId,
        memberId: request.memberId,
        principal: request.principal,
        fundableNow: true,
        fundableInDays: 0,
        fundableOn: asOf,
        reason: 'Can be paid out today',
      };
    }

    const shortfall = request.principal - purse;
    const window = byWindow.find((entry) => entry.dependable >= shortfall);

    if (window) {
      return {
        loanId: request.loanId,
        memberId: request.memberId,
        principal: request.principal,
        fundableNow: false,
        fundableInDays: window.windowDays,
        fundableOn: window.through,
        reason:
          `Short by ${format(shortfall)}. Repayments expected within ${window.windowDays} days cover it.`,
      };
    }

    return {
      loanId: request.loanId,
      memberId: request.memberId,
      principal: request.principal,
      fundableNow: false,
      fundableInDays: null,
      fundableOn: null,
      reason: `Short by ${format(shortfall)}, and repayments due within 90 days do not close the gap.`,
    };
  });
}

// ---------------------------------------------------------------------------
// The whole position
// ---------------------------------------------------------------------------

export type AlertLevel = 'info' | 'warning' | 'danger';

export interface CapitalAlert {
  level: AlertLevel;
  code: string;
  message: string;
}

export interface CapitalPosition {
  asOf: ISODate;

  capital: {
    equityPool: Money;
    facilityCommitted: Money;
    totalCapital: Money;
    deployed: Money;
    /** Capital policy allows to be lent. */
    available: Money;
    cashOnHand: Money;
    /**
     * What can actually go out of the door: the lower of what policy allows
     * and what is in the account.
     */
    spendableNow: Money;
    /** Cash not backing any loan. */
    idleCash: Money;
    utilisationRatio: number;
  };

  collateral: {
    totalPledged: Money;
    totalAtRisk: Money;
    releasedToDate: Money;
    /** Cover as a fraction of the book it stands behind. */
    coverageOfBook: number;
  };

  inflows: ExpectedInflow[];

  arrears: {
    total: Money;
    loanCount: number;
    /** Overdue amount as a fraction of the book. */
    portfolioAtRisk: number;
    worstDaysPastDue: number;
  };

  concentration: Concentration;
  funding: FundingVerdict[];

  /** Approved loans waiting for money. */
  committed: { count: number; amount: Money };

  alerts: CapitalAlert[];
  headline: string;
}

export interface CapitalOptions {
  /**
   * Render an amount for the alert text.
   *
   * Alerts are meant to be read by a committee, and "71000000" is not a
   * number anyone reads. Passed in rather than imported so the module stays
   * free of currency decisions.
   */
  formatAmount?: (amount: Money) => string;
  /** Resolve a member id to a name, for the same reason. */
  nameOf?: (memberId: string) => string;
}

/**
 * Assemble the circle's capital position.
 *
 * Pure: every fact it needs is passed in, so the whole thing can be tested
 * against a hand-built scenario without a database.
 */
export function capitalPosition(
  config: CircleConfig,
  inputs: CapitalInputs,
  options: CapitalOptions = {},
): CapitalPosition {
  const amount = options.formatAmount ?? ((value: Money) => String(value));
  const nameOf = options.nameOf ?? ((memberId: string) => memberId);
  const asOf = assertISODate(inputs.asOf, 'asOf');

  const live = inputs.loans.filter((loan) => loan.principalOutstanding > 0);
  const deployed = sum(live.map((loan) => loan.principalOutstanding));

  const facilityCommitted = sum(
    inputs.facilities
      .filter((facility) => facility.status === 'active' && isOnOrBefore(facility.fundedOn, asOf))
      .map((facility) => facilityOutstanding(facility)),
  );

  const totalCapital = inputs.equityPool + facilityCommitted;
  const available = nonNegative(totalCapital - deployed);
  const idleCash = nonNegative(inputs.cashOnHand);
  const spendableNow = Math.min(available, idleCash);

  const totalPledged = sum(inputs.collateral.map((entry) => entry.pledged));
  const totalAtRisk = sum(inputs.collateral.map((entry) => entry.atRisk));

  const arrearsTotal = sum(live.map((loan) => loan.arrears));
  const loansInArrears = live.filter((loan) => loan.arrears > 0).length;
  const worstDaysPastDue = live.reduce((worst, loan) => Math.max(worst, loan.daysPastDue), 0);

  const inflows = expectedInflows(live, asOf);

  const approved = inputs.pending.filter((request) => request.approved);
  const committedAmount = sum(approved.map((request) => request.principal));

  const funding = fundingPlan(inputs.pending, spendableNow, inflows, asOf, amount);
  const risk = concentration(live, inputs.collateral);

  // -------------------------------------------------------------------------
  // Alerts — the things a committee should be told without having to ask
  // -------------------------------------------------------------------------

  const alerts: CapitalAlert[] = [];

  if (committedAmount > spendableNow) {
    alerts.push({
      level: 'danger',
      code: 'cannot_meet_commitments',
      message:
        `${approved.length} approved loan(s) totalling ${amount(committedAmount)} are waiting, but only ` +
        `${amount(spendableNow)} can be paid out. The circle has promised money it cannot currently release.`,
    });
  }

  if (available > idleCash && available - idleCash > 0) {
    alerts.push({
      level: 'warning',
      code: 'capital_not_in_cash',
      message:
        `Policy allows ${amount(available)} to be lent but only ${amount(idleCash)} is in the account. ` +
        'The difference ' +
        'is held as fees awaiting decisions, member savings, or capital not yet drawn.',
    });
  }

  const portfolioAtRisk = ratio(arrearsTotal, deployed);
  if (portfolioAtRisk >= 0.1) {
    alerts.push({
      level: 'danger',
      code: 'arrears_high',
      message: `${(portfolioAtRisk * 100).toFixed(1)}% of the book is overdue across ${loansInArrears} loan(s).`,
    });
  } else if (portfolioAtRisk > 0.05) {
    alerts.push({
      level: 'warning',
      code: 'arrears_rising',
      message: `${(portfolioAtRisk * 100).toFixed(1)}% of the book is overdue.`,
    });
  }

  const borrowerCeiling = config.termLoan.maxPrincipalAsRatioOfCapital;
  if (risk.largestBorrower && risk.largestBorrower.share > borrowerCeiling) {
    alerts.push({
      level: 'warning',
      code: 'borrower_concentration',
      message:
        `${nameOf(risk.largestBorrower.memberId)} holds ${(risk.largestBorrower.share * 100).toFixed(0)}% of the ` +
        'loan book. One default would take a large part of the circle with it.',
    });
  }

  if (risk.largestSponsor && risk.largestSponsor.share > 0.25) {
    alerts.push({
      level: 'warning',
      code: 'sponsor_concentration',
      message:
        `${nameOf(risk.largestSponsor.memberId)} is standing behind ` +
        `${(risk.largestSponsor.share * 100).toFixed(0)}% ` +
        'of all cover. The circle is leaning heavily on one member.',
    });
  }

  const utilisationRatio = ratio(deployed, totalCapital);
  if (totalCapital > 0 && utilisationRatio < 0.3 && inputs.pending.length === 0) {
    alerts.push({
      level: 'info',
      code: 'capital_idle',
      message:
        `Only ${(utilisationRatio * 100).toFixed(0)}% of capital is working and nobody is waiting to ` +
        'borrow. Idle money earns nothing but still has to be carried.',
    });
  }

  if (deployed > 0 && totalAtRisk < deployed) {
    alerts.push({
      level: 'info',
      code: 'cover_below_book',
      message:
        `Cover of ${amount(totalAtRisk)} stands behind ${amount(deployed)} of lending. The gap is carried ` +
        "by borrowers' " +
        'own shares.',
    });
  }

  const headline =
    spendableNow > 0
      ? `${amount(spendableNow)} can be lent today. ${amount(inflows[1]?.dependable ?? 0)} more is ` +
        'expected within 30 days.'
      : `Nothing can be lent today. ${amount(inflows[1]?.dependable ?? 0)} is expected back within 30 days.`;

  return {
    asOf,
    capital: {
      equityPool: inputs.equityPool,
      facilityCommitted,
      totalCapital,
      deployed,
      available,
      cashOnHand: inputs.cashOnHand,
      spendableNow,
      idleCash: nonNegative(idleCash - committedAmount),
      utilisationRatio,
    },
    collateral: {
      totalPledged,
      totalAtRisk,
      releasedToDate: nonNegative(totalPledged - totalAtRisk),
      coverageOfBook: ratio(totalAtRisk, deployed),
    },
    inflows,
    arrears: {
      total: arrearsTotal,
      loanCount: loansInArrears,
      portfolioAtRisk,
      worstDaysPastDue,
    },
    concentration: risk,
    funding,
    committed: { count: approved.length, amount: committedAmount },
    alerts,
    headline,
  };
}

/**
 * Cash the circle expects to hold on a future date.
 *
 * A straight-line projection: what is in the account now, plus what is
 * scheduled to arrive, less what has been promised. No assumption is made
 * about new lending, because that is the decision this is meant to inform.
 */
export function projectCash(
  position: CapitalPosition,
  days: number,
): { on: ISODate; opening: Money; inflow: Money; commitments: Money; closing: Money } {
  const inflow = position.inflows.find((entry) => entry.windowDays === days);
  if (!inflow) {
    throw new CapitalError(
      `No inflow window of ${days} days. Available: ${position.inflows.map((e) => e.windowDays).join(', ')}`,
    );
  }

  const opening = position.capital.cashOnHand;
  const commitments = position.committed.amount;

  return {
    on: inflow.through,
    opening,
    inflow: inflow.dependable,
    commitments,
    closing: opening + inflow.dependable - commitments,
  };
}

/** Days until a given amount is expected to be available. */
export function daysUntilFundable(position: CapitalPosition, amount: Money): number | null {
  if (position.capital.spendableNow >= amount) return 0;

  const shortfall = amount - position.capital.spendableNow;
  const window = position.inflows.find((entry) => entry.dependable >= shortfall);

  return window ? window.windowDays : null;
}

/** Whole days from `asOf` to a loan's next instalment, for a due-soon list. */
export function daysUntilDue(instalment: UpcomingInstalment, asOf: ISODate): number {
  return daysBetween(asOf, instalment.dueOn);
}
