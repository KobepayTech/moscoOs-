/**
 * External capital and the utilisation waterfall.
 *
 * A member may lend the circle money rather than buy shares with it. That
 * money is a *facility*: a liability of the circle, not capital of it. The
 * investor gets their money back with a return; they do not get a bigger slice
 * of the circle. (If they want a bigger slice they buy shares, which is a
 * separate transaction against the register — the two must never be conflated,
 * because one dilutes the other members and the other does not.)
 *
 * ## What the investor is actually owed
 *
 * The rule the circle agreed is that idle money earns nothing. Lending draws
 * on member equity first; only once lending passes the equity line does the
 * facility start working, and the investor is paid on the working part alone.
 *
 * With TSh 150,000,000 of member equity and a TSh 200,000,000 facility:
 *
 *   lending out  50,000,000  ->  facility utilised 0            -> investor earns nothing
 *   lending out 150,000,000  ->  facility utilised 0            -> investor earns nothing
 *   lending out 200,000,000  ->  facility utilised  50,000,000  -> investor earns on 50,000,000
 *   lending out 350,000,000  ->  facility utilised 200,000,000  -> investor earns on all of it
 *
 * This is fair in both directions. The investor is not paid for money the
 * circle never used; the circle is not charged for capital sitting in its
 * account. It also gives the committee a sharp incentive that a flat return
 * would not: unused external capital is a standing cost of *zero*, so the
 * circle can safely hold a buffer, but it only pays when it earns.
 *
 * Because utilisation moves every time a loan is disbursed or repaid, the
 * entitlement is accrued day by day over the observed path, not estimated from
 * a month-end snapshot.
 */

import {
  type ISODate,
  addMonths,
  assertISODate,
  compareDates,
  daysBetween,
  isAfter,
  isOnOrBefore,
  maxDate,
  minDate,
} from './dates.js';
import { type CircleConfig } from './config.js';
import { type Money, allocate, money, nonNegative, ratio, sum } from './money.js';

export class FacilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacilityError';
  }
}

export type FacilityStatus = 'active' | 'repaid' | 'cancelled';

export interface Facility {
  id: string;
  /** The member who advanced the money. They must be a member of the circle. */
  investorMemberId: string;
  /** Amount committed. */
  principal: Money;
  /** Return per month on the *utilised* balance. */
  monthlyRate: number;
  /** Lower draws first. Facilities of equal seniority share pro rata. */
  seniority: number;
  fundedOn: ISODate;
  /** Earliest the investor may ask for the money back. */
  committedUntil: ISODate | null;
  /** Principal already returned to the investor. */
  repaidPrincipal: Money;
  /** Return already paid out. */
  paidInterest: Money;
  status: FacilityStatus;
}

export interface FacilityInput {
  id: string;
  investorMemberId: string;
  principal: Money;
  fundedOn: ISODate;
  monthlyRate?: number;
  seniority?: number;
  committedUntil?: ISODate | null;
  repaidPrincipal?: Money;
  paidInterest?: Money;
  status?: FacilityStatus;
}

export function createFacility(config: CircleConfig, input: FacilityInput): Facility {
  assertISODate(input.fundedOn, 'fundedOn');
  if (input.principal <= 0) throw new FacilityError('Facility principal must be greater than zero');

  return {
    id: input.id,
    investorMemberId: input.investorMemberId,
    principal: input.principal,
    monthlyRate: input.monthlyRate ?? config.facility.investorMonthlyRate,
    seniority: input.seniority ?? 0,
    fundedOn: input.fundedOn,
    committedUntil:
      input.committedUntil === undefined
        ? addMonths(input.fundedOn, config.facility.minimumTermMonths)
        : input.committedUntil,
    repaidPrincipal: input.repaidPrincipal ?? 0,
    paidInterest: input.paidInterest ?? 0,
    status: input.status ?? 'active',
  };
}

/** Principal of a facility still outstanding to the investor. */
export function facilityOutstanding(facility: Facility): Money {
  if (facility.status === 'cancelled') return 0;
  return nonNegative(facility.principal - facility.repaidPrincipal);
}

function isLiveOn(facility: Facility, date: ISODate): boolean {
  return (
    facility.status !== 'cancelled' && isOnOrBefore(facility.fundedOn, date) && facilityOutstanding(facility) > 0
  );
}

export interface UtilisationSplit {
  date: ISODate;
  /** Member capital available for lending. */
  equityPool: Money;
  /** Principal out on loan across the whole book. */
  outstandingDeployed: Money;
  /** The part of it funded by member equity. */
  equityUtilised: Money;
  /** The part of it funded by external capital. */
  facilityUtilisedTotal: Money;
  /** Utilised balance per facility. */
  perFacility: Map<string, Money>;
  /** Committed external capital left untouched — earning nothing. */
  facilityIdle: Money;
  /** Fraction of the whole capital base at work. */
  utilisationRatio: number;
}

/**
 * Split a day's lending across equity and the facilities behind it.
 *
 * Equity absorbs first. What remains cascades through the facilities in
 * seniority order; facilities of equal seniority share that tranche pro rata
 * by their outstanding principal, with any shortfall from a capped facility
 * spilling to the next group.
 */
export function splitUtilisation(
  equityPool: Money,
  outstandingDeployed: Money,
  facilities: readonly Facility[],
  date: ISODate,
  allocation: 'pro-rata' | 'sequential' = 'pro-rata',
): UtilisationSplit {
  assertISODate(date, 'date');

  const live = facilities.filter((facility) => isLiveOn(facility, date));
  const perFacility = new Map<string, Money>();
  for (const facility of facilities) perFacility.set(facility.id, 0);

  const equityUtilised = Math.min(nonNegative(outstandingDeployed), nonNegative(equityPool));
  let demand = nonNegative(outstandingDeployed - equityPool);

  // Group by seniority so equal-ranking facilities share the same tranche.
  const groups = new Map<number, Facility[]>();
  for (const facility of live) {
    const group = groups.get(facility.seniority) ?? [];
    group.push(facility);
    groups.set(facility.seniority, group);
  }

  const seniorities = [...groups.keys()].sort((a, b) => a - b);

  for (const seniority of seniorities) {
    if (demand <= 0) break;

    const group = groups
      .get(seniority)!
      .slice()
      .sort((a, b) => compareDates(a.fundedOn, b.fundedOn) || (a.id < b.id ? -1 : 1));

    const capacities = group.map((facility) => facilityOutstanding(facility));
    const groupCapacity = sum(capacities);
    if (groupCapacity <= 0) continue;

    const takenByGroup = Math.min(demand, groupCapacity);

    if (allocation === 'sequential') {
      let remaining = takenByGroup;
      group.forEach((facility, index) => {
        const taken = Math.min(capacities[index], remaining);
        perFacility.set(facility.id, taken);
        remaining -= taken;
      });
    } else {
      // Pro rata by capacity. Largest-remainder keeps the parts summing to the
      // tranche exactly; no facility can be handed more than it holds because
      // the weights are the capacities themselves.
      const shares = allocate(takenByGroup, capacities);
      group.forEach((facility, index) => {
        perFacility.set(facility.id, Math.min(shares[index], capacities[index]));
      });
    }

    demand -= takenByGroup;
  }

  const facilityUtilisedTotal = sum([...perFacility.values()]);
  const totalCommitted = sum(live.map((facility) => facilityOutstanding(facility)));
  const totalCapital = equityPool + totalCommitted;

  return {
    date,
    equityPool,
    outstandingDeployed,
    equityUtilised,
    facilityUtilisedTotal,
    perFacility,
    facilityIdle: nonNegative(totalCommitted - facilityUtilisedTotal),
    utilisationRatio: ratio(nonNegative(outstandingDeployed), totalCapital),
  };
}

/**
 * A reading of the circle's books on a date.
 *
 * The accrual engine walks a series of these and treats each as holding until
 * the next — a step function, which is exactly how a loan book behaves: the
 * outstanding balance only moves when money moves.
 */
export interface BookSnapshot {
  date: ISODate;
  /** Member capital available for lending on that date. */
  equityPool: Money;
  /** Principal out on loan across the whole book on that date. */
  outstandingDeployed: Money;
}

export interface FacilityAccrual {
  facilityId: string;
  investorMemberId: string;
  principal: Money;
  outstandingPrincipal: Money;
  /** Days on which any part of this facility was working. */
  utilisedDays: number;
  /** Average utilised balance across the whole period, including idle days. */
  averageUtilised: Money;
  /** Peak utilised balance observed. */
  peakUtilised: Money;
  /** Return earned over the period. */
  interestAccrued: Money;
  /** Return already paid out. */
  interestPaid: Money;
  interestOutstanding: Money;
  /** Utilised balance as a fraction of the facility — how hard it worked. */
  utilisationRatio: number;
}

export interface AccrualResult {
  from: ISODate;
  to: ISODate;
  days: number;
  perFacility: FacilityAccrual[];
  totalInterestAccrued: Money;
  /** Average of the whole book's deployed principal over the period. */
  averageDeployed: Money;
  /** Average equity at work over the period. */
  averageEquityUtilised: Money;
}

/**
 * Accrue investor returns over an observed path of the book.
 *
 * Each snapshot holds until the next one, so the caller should emit a snapshot
 * on every day the book moved — every disbursement and every repayment. The
 * API layer does exactly that, which makes the accrual an audit of what really
 * happened rather than a projection.
 */
export function accrueFacilityInterest(
  facilities: readonly Facility[],
  snapshots: readonly BookSnapshot[],
  options: { from: ISODate; to: ISODate; accrualBasisDays?: 365 | 360; allocation?: 'pro-rata' | 'sequential' },
): AccrualResult {
  const from = assertISODate(options.from, 'from');
  const to = assertISODate(options.to, 'to');
  const basis = options.accrualBasisDays ?? 365;
  const allocation = options.allocation ?? 'pro-rata';

  if (isAfter(from, to)) throw new FacilityError(`Accrual window runs backwards: ${from} to ${to}`);

  const ordered = [...snapshots].sort((a, b) => compareDates(a.date, b.date));
  if (ordered.length === 0) {
    return {
      from,
      to,
      days: daysBetween(from, to),
      perFacility: facilities.map((facility) => emptyAccrual(facility)),
      totalInterestAccrued: 0,
      averageDeployed: 0,
      averageEquityUtilised: 0,
    };
  }

  interface Tally {
    utilisedDayValue: number;
    utilisedDays: number;
    peak: Money;
    interest: number;
  }
  const tallies = new Map<string, Tally>();
  for (const facility of facilities) {
    tallies.set(facility.id, { utilisedDayValue: 0, utilisedDays: 0, peak: 0, interest: 0 });
  }

  let deployedDayValue = 0;
  let equityDayValue = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const snapshot = ordered[index];
    const nextDate = index + 1 < ordered.length ? ordered[index + 1].date : to;

    // Clip the segment to the accrual window.
    const segmentStart = maxDate(snapshot.date, from);
    const segmentEnd = minDate(nextDate, to);
    const days = daysBetween(segmentStart, segmentEnd);
    if (days <= 0) continue;

    const split = splitUtilisation(
      snapshot.equityPool,
      snapshot.outstandingDeployed,
      facilities,
      segmentStart,
      allocation,
    );

    deployedDayValue += snapshot.outstandingDeployed * days;
    equityDayValue += split.equityUtilised * days;

    for (const facility of facilities) {
      const utilised = split.perFacility.get(facility.id) ?? 0;
      if (utilised <= 0) continue;
      const tally = tallies.get(facility.id)!;
      tally.utilisedDayValue += utilised * days;
      tally.utilisedDays += days;
      tally.peak = Math.max(tally.peak, utilised);
      tally.interest += utilised * ((facility.monthlyRate * 12) / basis) * days;
    }
  }

  const totalDays = Math.max(1, daysBetween(from, to));

  const perFacility: FacilityAccrual[] = facilities.map((facility) => {
    const tally = tallies.get(facility.id)!;
    const interestAccrued = money(tally.interest);
    const outstandingPrincipal = facilityOutstanding(facility);
    return {
      facilityId: facility.id,
      investorMemberId: facility.investorMemberId,
      principal: facility.principal,
      outstandingPrincipal,
      utilisedDays: tally.utilisedDays,
      averageUtilised: money(tally.utilisedDayValue / totalDays),
      peakUtilised: tally.peak,
      interestAccrued,
      interestPaid: facility.paidInterest,
      interestOutstanding: nonNegative(interestAccrued - facility.paidInterest),
      utilisationRatio: outstandingPrincipal === 0 ? 0 : money(tally.utilisedDayValue / totalDays) / outstandingPrincipal,
    };
  });

  return {
    from,
    to,
    days: daysBetween(from, to),
    perFacility,
    totalInterestAccrued: sum(perFacility.map((accrual) => accrual.interestAccrued)),
    averageDeployed: money(deployedDayValue / totalDays),
    averageEquityUtilised: money(equityDayValue / totalDays),
  };
}

function emptyAccrual(facility: Facility): FacilityAccrual {
  return {
    facilityId: facility.id,
    investorMemberId: facility.investorMemberId,
    principal: facility.principal,
    outstandingPrincipal: facilityOutstanding(facility),
    utilisedDays: 0,
    averageUtilised: 0,
    peakUtilised: 0,
    interestAccrued: 0,
    interestPaid: facility.paidInterest,
    interestOutstanding: nonNegative(0 - facility.paidInterest),
    utilisationRatio: 0,
  };
}

export interface FacilityStatement {
  facility: Facility;
  accrual: FacilityAccrual;
  /** Principal plus earned return, less what has already been paid out. */
  totalDue: Money;
  /** Whether the investor may call the money back today. */
  withdrawable: boolean;
  earliestWithdrawalOn: ISODate | null;
}

/** The statement an investor sees: what is working, what it earned, what is owed. */
export function facilityStatement(
  facility: Facility,
  accrual: FacilityAccrual,
  options: { asOf: ISODate; noticeDays?: number },
): FacilityStatement {
  const asOf = assertISODate(options.asOf, 'asOf');
  const noticeDays = options.noticeDays ?? 0;

  const earliestWithdrawalOn = facility.committedUntil;
  const withdrawable =
    facility.status === 'active' &&
    (earliestWithdrawalOn === null || isOnOrBefore(earliestWithdrawalOn, asOf)) &&
    noticeDays >= 0;

  return {
    facility,
    accrual,
    totalDue: facilityOutstanding(facility) + accrual.interestOutstanding,
    withdrawable,
    earliestWithdrawalOn,
  };
}

export interface RepaymentPriority {
  facilityId: string;
  investorMemberId: string;
  /** Return owed. Paid before principal: earnings first, then capital. */
  interestDue: Money;
  principalDue: Money;
  totalDue: Money;
  seniority: number;
}

/**
 * Order in which facilities are repaid when the circle returns external money.
 *
 * Senior first, and within a rank the earliest-funded first. Accrued return is
 * settled ahead of principal so an investor whose money is being returned is
 * never left holding an unpaid entitlement on capital they no longer have in.
 */
export function repaymentQueue(
  facilities: readonly Facility[],
  accruals: readonly FacilityAccrual[],
): RepaymentPriority[] {
  const byId = new Map(accruals.map((accrual) => [accrual.facilityId, accrual]));

  return facilities
    .filter((facility) => facility.status === 'active')
    .slice()
    .sort((a, b) => b.seniority - a.seniority || compareDates(a.fundedOn, b.fundedOn))
    .map((facility) => {
      const interestDue = byId.get(facility.id)?.interestOutstanding ?? 0;
      const principalDue = facilityOutstanding(facility);
      return {
        facilityId: facility.id,
        investorMemberId: facility.investorMemberId,
        interestDue,
        principalDue,
        totalDue: interestDue + principalDue,
        seniority: facility.seniority,
      };
    });
}

export interface LendingHeadroom {
  equityPool: Money;
  facilityCommitted: Money;
  totalCapital: Money;
  outstandingDeployed: Money;
  /** Capital free to lend right now. */
  available: Money;
  /** Largest single loan policy allows against the current capital base. */
  maxSingleLoan: Money;
  utilisationRatio: number;
}

/** How much the circle can still lend, and the largest loan it may write. */
export function lendingHeadroom(
  config: CircleConfig,
  equityPool: Money,
  outstandingDeployed: Money,
  facilities: readonly Facility[],
  asOf: ISODate,
): LendingHeadroom {
  const facilityCommitted = sum(
    facilities.filter((facility) => isLiveOn(facility, asOf)).map((facility) => facilityOutstanding(facility)),
  );
  const totalCapital = equityPool + facilityCommitted;
  const available = nonNegative(totalCapital - outstandingDeployed);

  const policyCeiling = money(totalCapital * config.termLoan.maxPrincipalAsRatioOfCapital);
  const hardCeiling = config.termLoan.maxPrincipal;

  return {
    equityPool,
    facilityCommitted,
    totalCapital,
    outstandingDeployed,
    available,
    maxSingleLoan: Math.min(available, policyCeiling, hardCeiling ?? Number.MAX_SAFE_INTEGER),
    utilisationRatio: ratio(outstandingDeployed, totalCapital),
  };
}
