/**
 * Loan schedules.
 *
 * ## The Mamogoro schedule (term / trade loans)
 *
 * The founding rule, in the members' own words: whatever you take, you return
 * at least 10% of it every month, the interest is collected inside those
 * monthly payments, and the final payment is flat — principal only, no
 * interest riding on it.
 *
 * Worked through for a TSh 50,000,000 loan over three months at 2.5% a month:
 *
 *   month 1: opening 50,000,000, interest 1,250,000, principal 5,000,000
 *   month 2: opening 45,000,000, interest 1,125,000, principal 5,000,000
 *   month 3: opening 40,000,000, interest 1,000,000, principal 5,000,000
 *   ------------------------------------------------------------------
 *   interest over the whole loan .......................... 3,375,000
 *
 * That interest is then *levelised* across the three instalments, so each one
 * is the same size and the member has one number to remember:
 *
 *   instalment = 5,000,000 + 3,375,000/3 = 6,125,000 a month
 *
 * After three instalments the member has returned 15,000,000 of principal and
 * every shilling of interest. What is left falls due at maturity as a flat
 * balloon:
 *
 *   balloon = 50,000,000 - 15,000,000 = 35,000,000, interest-free
 *
 * Total repaid: 3 x 6,125,000 + 35,000,000 = 53,375,000 = principal + interest.
 *
 * Two properties are worth naming, because the rest of the module defends them:
 *
 *   - Interest is computed on the *scheduled* declining balance, not flat on
 *     the original principal. A borrower who follows the schedule is charged
 *     for money they actually had.
 *   - Because interest is known up front and collected early, settling early
 *     would otherwise mean paying for months of borrowing that never happened.
 *     `settlementQuote` rebates that unearned portion.
 *
 * ## Short-term loans
 *
 * A separate product: money out for days, not months, repaid in one bullet
 * with a flat charge. Cheap in absolute terms, expensive in annualised terms —
 * `annualisedRate` on the result makes that explicit rather than hiding it.
 */

import {
  type ISODate,
  addDays,
  addMonths,
  assertISODate,
  daysBetween,
  isAfter,
  isOnOrBefore,
} from './dates.js';
import {
  type Money,
  allocateEvenly,
  applyRate,
  assertNonNegativeMoney,
  money,
  nonNegative,
  sum,
} from './money.js';

export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanError';
  }
}

// ---------------------------------------------------------------------------
// Term loans
// ---------------------------------------------------------------------------

export interface TermLoanTerms {
  principal: Money;
  /** Interest per month on the scheduled outstanding balance. */
  monthlyInterestRate: number;
  termMonths: number;
  /** Principal returned each month, as a fraction of the amount taken. */
  minimumMonthlyPrincipalRate: number;
  disbursedOn: ISODate;
  /** Days after the last instalment before the balloon falls due. */
  balloonGraceDays?: number;
}

export type InstalmentKind = 'service' | 'balloon';

export interface ScheduleRow {
  /** 1-based position in the schedule. */
  index: number;
  dueOn: ISODate;
  kind: InstalmentKind;
  /** Principal outstanding at the start of this period. */
  openingPrincipal: Money;
  principalDue: Money;
  interestDue: Money;
  totalDue: Money;
  /** Principal outstanding once this row is paid. */
  closingPrincipal: Money;
}

export interface TermLoanSchedule {
  terms: TermLoanTerms;
  rows: ScheduleRow[];
  /** Total interest over the life of the loan, on the scheduled balance path. */
  scheduledInterest: Money;
  /** The repeating monthly payment. Rows may differ by a shilling of rounding. */
  levelServiceInstalment: Money;
  /** Flat principal falling due at maturity. Zero if the loan fully amortises. */
  balloon: Money;
  totalRepayable: Money;
  maturityOn: ISODate;
  /**
   * Interest as a fraction of the amount taken, over the whole term. Quoted to
   * members because it is the number they can check by hand.
   */
  totalCostRatio: number;
}

/**
 * Build the repayment schedule for a term loan.
 *
 * The schedule is deterministic: every figure a member will ever be asked for
 * is fixed at disbursement, which is what lets the sponsorship and ledger
 * layers reason about the loan without re-deriving interest.
 */
export function buildTermLoanSchedule(terms: TermLoanTerms): TermLoanSchedule {
  const principal = assertNonNegativeMoney(terms.principal, 'principal');
  assertISODate(terms.disbursedOn, 'disbursedOn');

  const { monthlyInterestRate: rate, termMonths, minimumMonthlyPrincipalRate: principalRate } = terms;
  const balloonGraceDays = terms.balloonGraceDays ?? 0;

  if (principal === 0) throw new LoanError('Loan principal must be greater than zero');
  if (!Number.isInteger(termMonths) || termMonths < 1) {
    throw new LoanError(`Term must be a whole number of months of at least one, got ${termMonths}`);
  }
  if (!Number.isFinite(rate) || rate < 0) {
    throw new LoanError(`Monthly interest rate must be finite and non-negative, got ${rate}`);
  }
  if (!Number.isFinite(principalRate) || principalRate <= 0 || principalRate > 1) {
    throw new LoanError(`Monthly principal rate must fall in (0, 1], got ${principalRate}`);
  }
  if (balloonGraceDays < 0) throw new LoanError('Balloon grace period must not be negative');

  // Step 1 — the scheduled principal path. A fixed slice of the *original*
  // principal each month, never more than what is still outstanding.
  const scheduledPrincipalStep = money(principal * principalRate);
  const principalPath: Money[] = [];
  let outstanding = principal;
  for (let month = 1; month <= termMonths; month += 1) {
    const step = Math.min(scheduledPrincipalStep, outstanding);
    principalPath.push(step);
    outstanding -= step;
  }

  // Step 2 — interest accrues on the opening balance of each month along that
  // path. Sum first, round once: rounding each month separately would let the
  // error compound across a long term.
  let balance = principal;
  let rawInterest = 0;
  const openingBalances: Money[] = [];
  for (let month = 0; month < termMonths; month += 1) {
    openingBalances.push(balance);
    rawInterest += balance * rate;
    balance -= principalPath[month];
  }
  const scheduledInterest = money(rawInterest);

  // Step 3 — levelise. The member pays the same amount every month; the
  // interest is spread evenly rather than tracking the declining balance.
  const interestShares = allocateEvenly(scheduledInterest, termMonths);

  const rows: ScheduleRow[] = [];
  let closing = principal;
  for (let month = 0; month < termMonths; month += 1) {
    const principalDue = principalPath[month];
    const interestDue = interestShares[month];
    const openingPrincipal = closing;
    closing -= principalDue;
    rows.push({
      index: month + 1,
      dueOn: addMonths(terms.disbursedOn, month + 1),
      kind: 'service',
      openingPrincipal,
      principalDue,
      interestDue,
      totalDue: principalDue + interestDue,
      closingPrincipal: closing,
    });
  }

  // Step 4 — whatever principal the instalments did not reach falls due at
  // maturity, flat. No interest rides on the balloon: it has already been paid.
  const balloon = nonNegative(principal - sum(principalPath));
  const lastServiceDue = rows[rows.length - 1].dueOn;
  const maturityOn = balloonGraceDays > 0 ? addDays(lastServiceDue, balloonGraceDays) : lastServiceDue;

  if (balloon > 0) {
    rows.push({
      index: rows.length + 1,
      dueOn: maturityOn,
      kind: 'balloon',
      openingPrincipal: balloon,
      principalDue: balloon,
      interestDue: 0,
      totalDue: balloon,
      closingPrincipal: 0,
    });
  }

  const totalRepayable = sum(rows.map((row) => row.totalDue));

  // A schedule that does not return exactly what was lent plus exactly the
  // interest charged is a bug, not a rounding quirk. Fail loudly at build time.
  if (totalRepayable !== principal + scheduledInterest) {
    throw new LoanError(
      `Schedule does not reconcile: repayable ${totalRepayable} != principal ${principal} + interest ${scheduledInterest}`,
    );
  }

  return {
    terms,
    rows,
    scheduledInterest,
    levelServiceInstalment: rows[0].totalDue,
    balloon,
    totalRepayable,
    maturityOn,
    totalCostRatio: scheduledInterest / principal,
  };
}

// ---------------------------------------------------------------------------
// Short-term loans
// ---------------------------------------------------------------------------

export interface ShortTermLoanTerms {
  principal: Money;
  /** Flat charge on the amount taken. */
  flatRate: number;
  days: number;
  disbursedOn: ISODate;
  /** `flat` charges the full rate whatever the duration; `prorated` scales it. */
  mode?: 'flat' | 'prorated';
  /** Denominator for `prorated` mode — the product's full window. */
  proRataBasisDays?: number;
  minimumFee?: Money;
}

export interface ShortTermLoan {
  terms: ShortTermLoanTerms;
  fee: Money;
  totalRepayable: Money;
  dueOn: ISODate;
  /**
   * The flat fee expressed as a simple annual rate. A 5% charge over five days
   * annualises to 365%; the committee should see that number when it sets the
   * product, even though the member only ever pays the 5%.
   */
  annualisedRate: number;
}

export function buildShortTermLoan(terms: ShortTermLoanTerms): ShortTermLoan {
  const principal = assertNonNegativeMoney(terms.principal, 'principal');
  assertISODate(terms.disbursedOn, 'disbursedOn');

  const { flatRate, days } = terms;
  const mode = terms.mode ?? 'flat';
  const basis = terms.proRataBasisDays ?? 30;

  if (principal === 0) throw new LoanError('Loan principal must be greater than zero');
  if (!Number.isInteger(days) || days < 1) {
    throw new LoanError(`Short-term loans must run a whole number of days of at least one, got ${days}`);
  }
  if (!Number.isFinite(flatRate) || flatRate < 0) {
    throw new LoanError(`Flat rate must be finite and non-negative, got ${flatRate}`);
  }
  if (mode === 'prorated' && basis < 1) throw new LoanError('Pro-rata basis must be at least one day');

  const rawFee = mode === 'flat' ? applyRate(principal, flatRate) : applyRate(principal, (flatRate * days) / basis);
  const fee = Math.max(rawFee, terms.minimumFee ?? 0);

  return {
    terms,
    fee,
    totalRepayable: principal + fee,
    dueOn: addDays(terms.disbursedOn, days),
    annualisedRate: (fee / principal) * (365 / days),
  };
}

// ---------------------------------------------------------------------------
// Servicing: applying repayments, arrears, penalties, early settlement
// ---------------------------------------------------------------------------

export interface Repayment {
  id?: string;
  paidOn: ISODate;
  amount: Money;
  reference?: string;
}

export interface RowStatus {
  row: ScheduleRow;
  principalPaid: Money;
  interestPaid: Money;
  principalOutstanding: Money;
  interestOutstanding: Money;
  settled: boolean;
  settledOn: ISODate | null;
  /** Days past due as at the valuation date. Zero if not yet due or settled on time. */
  daysPastDue: number;
}

/**
 * How one payment was split.
 *
 * Reported rather than re-derived, so every consumer works from the same
 * split. `settlementQuote` in particular needs the exact principal path to
 * recompute earned interest, and deriving it a second time is how the two
 * drift apart.
 */
export interface PaymentAllocation {
  paidOn: ISODate;
  amount: Money;
  towardPenalty: Money;
  towardInterest: Money;
  towardPrincipal: Money;
  /** Left unapplied because everything due was already covered. */
  towardCredit: Money;
}

export interface LoanState {
  schedule: TermLoanSchedule;
  asOf: ISODate;
  rows: RowStatus[];
  /** One entry per repayment considered, in date order. */
  allocations: PaymentAllocation[];
  totalPaid: Money;
  principalPaid: Money;
  interestPaid: Money;
  penaltyPaid: Money;
  principalOutstanding: Money;
  /** Scheduled interest not yet paid. */
  interestOutstanding: Money;
  /** Amount that fell due on or before `asOf` and has not been paid. */
  arrears: Money;
  /** Penalty accrued on those arrears, unpaid. */
  penaltyAccrued: Money;
  /** Unapplied credit sitting on the loan after everything due was covered. */
  creditBalance: Money;
  daysPastDue: number;
  status: 'pending' | 'current' | 'in_arrears' | 'defaulted' | 'settled';
  /** Everything owed if the member paid the loan off on `asOf`, ignoring rebates. */
  payoffWithoutRebate: Money;
}

export interface ServicingOptions {
  asOf: ISODate;
  /** Penalty per month charged on overdue amounts. */
  penaltyMonthlyRate?: number;
  /** Days past due before the loan is called defaulted. */
  defaultAfterDays?: number;
  /** Day-count basis for penalty accrual. */
  accrualBasisDays?: 365 | 360;
}

/**
 * Walk repayments against a schedule and report where the loan stands.
 *
 * Money is applied oldest-instalment-first, and within an instalment to
 * penalties, then interest, then principal. That ordering is deliberate: it
 * clears the charges that keep growing before it touches the principal that
 * does not.
 */
export function applyRepayments(
  schedule: TermLoanSchedule,
  repayments: readonly Repayment[],
  options: ServicingOptions,
): LoanState {
  const asOf = assertISODate(options.asOf, 'asOf');
  const penaltyMonthlyRate = options.penaltyMonthlyRate ?? 0;
  const defaultAfterDays = options.defaultAfterDays ?? 90;
  const basis = options.accrualBasisDays ?? 365;
  const dailyPenaltyRate = (penaltyMonthlyRate * 12) / basis;

  const ordered = [...repayments]
    .filter((payment) => isOnOrBefore(payment.paidOn, asOf))
    .sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0));

  for (const payment of ordered) assertNonNegativeMoney(payment.amount, 'repayment amount');

  const statuses: RowStatus[] = schedule.rows.map((row) => ({
    row,
    principalPaid: 0,
    interestPaid: 0,
    principalOutstanding: row.principalDue,
    interestOutstanding: row.interestDue,
    settled: row.totalDue === 0,
    settledOn: null,
    daysPastDue: 0,
  }));

  // Penalties are charged per payment date, so a member who clears arrears
  // early stops the meter on that date rather than at the valuation date.
  let penaltyPaid = 0;
  let creditBalance = 0;

  const penaltyOwedAt = (date: ISODate): number => {
    if (dailyPenaltyRate === 0) return 0;
    let owed = 0;
    for (const status of statuses) {
      if (isAfter(status.row.dueOn, date)) continue;
      const overdue = status.principalOutstanding + status.interestOutstanding;
      if (overdue <= 0) continue;
      owed += overdue * dailyPenaltyRate * daysBetween(status.row.dueOn, date);
    }
    return nonNegative(money(owed));
  };

  const allocations: PaymentAllocation[] = [];

  for (const payment of ordered) {
    let remaining = payment.amount + creditBalance;
    creditBalance = 0;

    let towardPenalty = 0;
    let towardInterest = 0;
    let towardPrincipal = 0;

    // 1. Penalties standing at the moment of payment.
    const penaltyDue = nonNegative(penaltyOwedAt(payment.paidOn) - penaltyPaid);
    if (penaltyDue > 0 && remaining > 0) {
      const applied = Math.min(penaltyDue, remaining);
      penaltyPaid += applied;
      towardPenalty += applied;
      remaining -= applied;
    }

    // 2. Then instalments, oldest first: interest before principal.
    for (const status of statuses) {
      if (remaining <= 0) break;

      if (status.interestOutstanding > 0) {
        const applied = Math.min(status.interestOutstanding, remaining);
        status.interestOutstanding -= applied;
        status.interestPaid += applied;
        towardInterest += applied;
        remaining -= applied;
      }
      if (remaining <= 0 && status.principalOutstanding > 0) break;

      if (status.principalOutstanding > 0) {
        const applied = Math.min(status.principalOutstanding, remaining);
        status.principalOutstanding -= applied;
        status.principalPaid += applied;
        towardPrincipal += applied;
        remaining -= applied;
      }

      if (!status.settled && status.principalOutstanding === 0 && status.interestOutstanding === 0) {
        status.settled = true;
        status.settledOn = payment.paidOn;
      }
    }

    // 3. Anything left over stays as credit against the next instalment.
    if (remaining > 0) creditBalance += remaining;

    allocations.push({
      paidOn: payment.paidOn,
      amount: payment.amount,
      towardPenalty,
      towardInterest,
      towardPrincipal,
      towardCredit: remaining > 0 ? remaining : 0,
    });
  }

  for (const status of statuses) {
    if (status.settled) {
      status.daysPastDue =
        status.settledOn && isAfter(status.settledOn, status.row.dueOn)
          ? daysBetween(status.row.dueOn, status.settledOn)
          : 0;
    } else {
      status.daysPastDue = isAfter(asOf, status.row.dueOn) ? daysBetween(status.row.dueOn, asOf) : 0;
    }
  }

  const principalPaid = sum(statuses.map((s) => s.principalPaid));
  const interestPaid = sum(statuses.map((s) => s.interestPaid));
  const principalOutstanding = sum(statuses.map((s) => s.principalOutstanding));
  const interestOutstanding = sum(statuses.map((s) => s.interestOutstanding));

  const arrears = sum(
    statuses
      .filter((status) => isOnOrBefore(status.row.dueOn, asOf))
      .map((status) => status.principalOutstanding + status.interestOutstanding),
  );

  const penaltyAccrued = nonNegative(penaltyOwedAt(asOf) - penaltyPaid);
  const daysPastDue = statuses.reduce(
    (worst, status) => (status.settled ? worst : Math.max(worst, status.daysPastDue)),
    0,
  );

  const fullySettled = principalOutstanding === 0 && interestOutstanding === 0 && penaltyAccrued === 0;
  const status: LoanState['status'] = fullySettled
    ? 'settled'
    : daysPastDue >= defaultAfterDays
      ? 'defaulted'
      : arrears > 0
        ? 'in_arrears'
        : principalPaid === 0 && interestPaid === 0
          ? 'pending'
          : 'current';

  return {
    schedule,
    asOf,
    rows: statuses,
    allocations,
    totalPaid: sum(ordered.map((payment) => payment.amount)),
    principalPaid,
    interestPaid,
    penaltyPaid,
    principalOutstanding,
    interestOutstanding,
    arrears,
    penaltyAccrued,
    creditBalance,
    daysPastDue,
    status,
    payoffWithoutRebate: principalOutstanding + interestOutstanding + penaltyAccrued - creditBalance,
  };
}

export interface SettlementQuote {
  asOf: ISODate;
  principalOutstanding: Money;
  /** Interest genuinely earned by the circle for the days the money was out. */
  interestEarned: Money;
  /** Scheduled interest already collected. */
  interestPaid: Money;
  /** Collected but not yet earned — credited back on early settlement. */
  interestRebate: Money;
  /** Earned but not yet collected — added to the payoff. */
  interestShortfall: Money;
  penaltyDue: Money;
  /** The single figure the cashier quotes to the member. */
  payoffAmount: Money;
  /** Saving against paying the schedule out to maturity. */
  savingVersusSchedule: Money;
}

/**
 * What it costs to close the loan today.
 *
 * Because the schedule front-loads interest, a member who settles in month two
 * has already paid for month three. Interest actually earned is recomputed day
 * by day on the balance the member really carried, and the difference comes
 * back to them. Without this, early repayment would be a penalty — exactly the
 * wrong incentive for a circle that wants its capital recycled quickly.
 */
export function settlementQuote(
  schedule: TermLoanSchedule,
  repayments: readonly Repayment[],
  options: ServicingOptions & { rebateUnearnedInterest?: boolean },
): SettlementQuote {
  const asOf = assertISODate(options.asOf, 'asOf');
  const state = applyRepayments(schedule, repayments, options);
  const rebateEnabled = options.rebateUnearnedInterest ?? true;

  const basis = options.accrualBasisDays ?? 365;
  const dailyRate = (schedule.terms.monthlyInterestRate * 12) / basis;

  // Rebuild the balance the member actually carried, day by day, and charge
  // interest only for the days the circle's money was genuinely out. The
  // principal path comes straight from the servicing pass, so the two can
  // never disagree about what a given payment repaid.
  let balance = schedule.terms.principal;
  let cursor = schedule.terms.disbursedOn;
  let earned = 0;

  for (const allocation of state.allocations) {
    const days = daysBetween(cursor, allocation.paidOn);
    if (days > 0) earned += balance * dailyRate * days;
    balance = nonNegative(balance - allocation.towardPrincipal);
    cursor = allocation.paidOn;
  }

  const tailDays = daysBetween(cursor, asOf);
  if (tailDays > 0) earned += balance * dailyRate * tailDays;

  const interestEarnedRaw = money(earned);
  // Never charge more than the schedule promised, however the day-count falls.
  const interestEarned = Math.min(interestEarnedRaw, schedule.scheduledInterest);

  const interestRebate = rebateEnabled ? nonNegative(state.interestPaid - interestEarned) : 0;
  const interestShortfall = nonNegative(interestEarned - state.interestPaid);

  const payoffAmount = nonNegative(
    state.principalOutstanding + interestShortfall + state.penaltyAccrued - interestRebate - state.creditBalance,
  );

  return {
    asOf,
    principalOutstanding: state.principalOutstanding,
    interestEarned,
    interestPaid: state.interestPaid,
    interestRebate,
    interestShortfall,
    penaltyDue: state.penaltyAccrued,
    payoffAmount,
    savingVersusSchedule: nonNegative(state.payoffWithoutRebate - payoffAmount),
  };
}

export interface ShortTermLoanState {
  loan: ShortTermLoan;
  asOf: ISODate;
  paid: Money;
  outstanding: Money;
  penalty: Money;
  daysPastDue: number;
  status: 'pending' | 'current' | 'overdue' | 'settled';
  payoffAmount: Money;
}

/** Position of a short-term bullet loan as at a date. */
export function shortTermLoanState(
  loan: ShortTermLoan,
  repayments: readonly Repayment[],
  options: { asOf: ISODate; dailyPenaltyRate?: number },
): ShortTermLoanState {
  const asOf = assertISODate(options.asOf, 'asOf');
  const dailyPenaltyRate = options.dailyPenaltyRate ?? 0;

  const paid = sum(
    repayments.filter((payment) => isOnOrBefore(payment.paidOn, asOf)).map((payment) => payment.amount),
  );
  const daysPastDue = isAfter(asOf, loan.dueOn) ? daysBetween(loan.dueOn, asOf) : 0;

  const grossOutstanding = nonNegative(loan.totalRepayable - paid);
  const penalty = grossOutstanding > 0 ? applyRate(grossOutstanding, dailyPenaltyRate * daysPastDue) : 0;
  const payoffAmount = grossOutstanding + penalty;

  return {
    loan,
    asOf,
    paid,
    outstanding: grossOutstanding,
    penalty,
    daysPastDue,
    status:
      payoffAmount === 0 ? 'settled' : daysPastDue > 0 ? 'overdue' : paid > 0 ? 'current' : 'pending',
    payoffAmount,
  };
}

/**
 * Daily outstanding-principal path for a term loan.
 *
 * The facility waterfall needs to know how much of the circle's money was out
 * on loan on any given day, so this exposes the balance as a step function
 * rather than only at instalment dates.
 */
export function principalOutstandingOn(
  schedule: TermLoanSchedule,
  repayments: readonly Repayment[],
  asOf: ISODate,
): Money {
  if (isAfter(schedule.terms.disbursedOn, asOf)) return 0;
  return applyRepayments(schedule, repayments, { asOf }).principalOutstanding;
}
