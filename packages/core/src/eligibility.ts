/**
 * Who may borrow, and how much.
 *
 * The checks here run *before* a member is allowed to go looking for sponsors.
 * Finding ten people willing to put their shares behind you is real social
 * work; being told afterwards that you were never eligible would be a waste of
 * that, and would spend goodwill the circle needs for the next application.
 *
 * Every rejection carries a reason the member can act on, and where possible
 * the number they would need to reach.
 */

import { type ISODate, daysBetween, isAfter } from './dates.js';
import { type CircleConfig } from './config.js';
import { type LendingHeadroom } from './facility.js';
import { type ShareRegister, isFullyPaidMember, sharesOf, sharesOutstandingForMembership } from './shares.js';
import { type Money, applyRate, formatMoney, nonNegative } from './money.js';

export type LoanProduct = 'term' | 'short_term';

export interface MemberStanding {
  memberId: string;
  joinedOn: ISODate;
  /** Consecutive monthly contributions missed. */
  missedContributions: number;
  /** Whether the current year's subscription is settled. */
  annualFeePaid: boolean;
  /** Principal the member currently owes across all loans. */
  outstandingPrincipal: Money;
  /** Loans currently in arrears. */
  loansInArrears: number;
  /** Live loans, by product. */
  activeTermLoans: number;
  activeShortTermLoans: number;
  /** Date the member last settled a short-term loan, if any. */
  lastShortTermSettledOn?: ISODate | null;
  /** Committed to other members' loans as a sponsor. */
  pledgedOut: Money;
  /** Set by a governance resolution. */
  suspended?: boolean;
}

export interface EligibilityProblem {
  code: string;
  message: string;
  /** True when the member can fix this themselves. */
  actionable: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  product: LoanProduct;
  problems: EligibilityProblem[];
  /** Largest loan this member could take right now, given every constraint. */
  maxPrincipal: Money;
  /** Which rule set the ceiling, so the member knows what to improve. */
  bindingConstraint: string | null;
}

/**
 * Assess a member against a product.
 *
 * `maxPrincipal` is the minimum across every ceiling that applies, and
 * `bindingConstraint` names the one that bound — the difference between
 * "you can borrow 4,000,000" and "you can borrow 4,000,000 *because the
 * circle only has that much free*" is the difference between a member waiting
 * and a member buying more shares.
 */
export function assessEligibility(
  config: CircleConfig,
  register: ShareRegister,
  standing: MemberStanding,
  headroom: LendingHeadroom,
  options: { product: LoanProduct; asOf: ISODate; requestedPrincipal?: Money },
): EligibilityResult {
  const { product, asOf } = options;
  const problems: EligibilityProblem[] = [];
  const ceilings: { label: string; value: Money }[] = [];

  const add = (code: string, message: string, actionable = true) =>
    problems.push({ code, message, actionable });

  // --- Standing -----------------------------------------------------------

  if (standing.suspended) {
    add('suspended', 'Your borrowing rights are suspended by a resolution of the circle', false);
  }

  if (!isFullyPaidMember(register, config, standing.memberId)) {
    const owed = sharesOutstandingForMembership(register, config, standing.memberId);
    add(
      'shares_incomplete',
      `You hold ${sharesOf(register, standing.memberId)} of the ${config.shares.minimumMembershipShares} ` +
        `shares required for membership. ${owed} more (${formatMoney(owed * config.shares.parValue, config.currency)}) ` +
        'to complete your subscription.',
    );
  }

  if (!standing.annualFeePaid) {
    add(
      'annual_fee_unpaid',
      `This year's subscription of ${formatMoney(config.membership.annualFee, config.currency)} is outstanding`,
    );
  }

  if (standing.missedContributions >= config.membership.missedContributionsBeforeSuspension) {
    add(
      'contributions_in_arrears',
      `You have missed ${standing.missedContributions} monthly contributions; ` +
        `${config.membership.missedContributionsBeforeSuspension} suspends borrowing`,
    );
  }

  if (standing.loansInArrears > 0) {
    add(
      'existing_arrears',
      `You have ${standing.loansInArrears} loan(s) in arrears. Clear them before applying again.`,
    );
  }

  // --- Product rules ------------------------------------------------------

  if (product === 'short_term') {
    if (standing.activeShortTermLoans >= config.shortTermLoan.maxConcurrentPerMember) {
      add(
        'short_term_limit',
        `Only ${config.shortTermLoan.maxConcurrentPerMember} short-term loan may be open at a time`,
        false,
      );
    }

    if (standing.lastShortTermSettledOn) {
      const sinceLast = daysBetween(standing.lastShortTermSettledOn, asOf);
      if (sinceLast < config.shortTermLoan.cooldownDays) {
        add(
          'short_term_cooldown',
          `Short-term loans carry a ${config.shortTermLoan.cooldownDays}-day cooling-off period; ` +
            `${config.shortTermLoan.cooldownDays - sinceLast} day(s) remain`,
          false,
        );
      }
    }

    ceilings.push({ label: 'short-term product ceiling', value: config.shortTermLoan.maxPrincipal });
  } else {
    if (config.termLoan.maxPrincipal !== null) {
      ceilings.push({ label: 'product ceiling', value: config.termLoan.maxPrincipal });
    }
    ceilings.push({
      label: `single-loan policy (${(config.termLoan.maxPrincipalAsRatioOfCapital * 100).toFixed(0)}% of circle capital)`,
      value: applyRate(headroom.totalCapital, config.termLoan.maxPrincipalAsRatioOfCapital),
    });
  }

  // --- Capital available --------------------------------------------------

  ceilings.push({ label: 'capital free to lend', value: headroom.available });

  if (headroom.available <= 0) {
    add('no_capital', 'The circle has no capital free to lend at the moment. Join the queue.', false);
  }

  // --- Cover the member can raise ----------------------------------------

  // A member cannot realistically borrow more than the circle's members could
  // stand behind, and their own shares are the first line of that cover.
  const selfCover = config.sponsorship.includeBorrowerSelfCover
    ? nonNegative(
        sharesOf(register, standing.memberId) * config.shares.parValue -
          standing.pledgedOut -
          standing.outstandingPrincipal,
      )
    : 0;

  const coverageRatio =
    product === 'short_term' ? config.shortTermLoan.requiredSponsorCoverage : config.sponsorship.coverageRatio;

  if (product === 'short_term' && selfCover <= 0) {
    add(
      'no_self_cover',
      'Short-term loans require cover, and your shares are fully committed elsewhere',
      false,
    );
  }

  const maxPrincipal = ceilings.reduce<{ label: string | null; value: Money }>(
    (lowest, ceiling) => (ceiling.value < lowest.value ? { label: ceiling.label, value: ceiling.value } : lowest),
    { label: null, value: Number.MAX_SAFE_INTEGER },
  );

  const effectiveMax = problems.some((problem) => !problem.actionable) ? 0 : nonNegative(maxPrincipal.value);

  if (options.requestedPrincipal !== undefined && options.requestedPrincipal > effectiveMax) {
    add(
      'over_ceiling',
      `You asked for ${formatMoney(options.requestedPrincipal, config.currency)} but the ceiling right now is ` +
        `${formatMoney(effectiveMax, config.currency)} (${maxPrincipal.label ?? 'policy'})`,
      false,
    );
  }

  if (options.requestedPrincipal !== undefined && coverageRatio > 0) {
    const required = applyRate(options.requestedPrincipal, coverageRatio);
    if (selfCover < required) {
      // Not a rejection — this is what sponsors are for. Stated so the member
      // knows the size of the ask before they start making calls.
      problems.push({
        code: 'sponsors_required',
        message:
          `You need ${formatMoney(required, config.currency)} of cover. Your own shares provide ` +
          `${formatMoney(selfCover, config.currency)}, so you must find sponsors for ` +
          `${formatMoney(required - selfCover, config.currency)}.`,
        actionable: true,
      });
    }
  }

  const blocking = problems.filter((problem) => problem.code !== 'sponsors_required');

  return {
    eligible: blocking.length === 0,
    product,
    problems,
    maxPrincipal: effectiveMax,
    bindingConstraint: maxPrincipal.label,
  };
}

export interface ContributionStatus {
  memberId: string;
  /** Months since joining that a contribution was owed for. */
  monthsDue: number;
  monthsPaid: number;
  monthsMissed: number;
  amountDue: Money;
  amountPaid: Money;
  arrears: Money;
  penalties: Money;
  inGoodStanding: boolean;
}

/**
 * Reconcile a member's monthly contributions against what they owed.
 *
 * Contributions are counted by month, not by amount: a member who pays double
 * one month has paid for one month, not two. A circle that lets members pay
 * ahead loses its monthly rhythm, and that rhythm is what keeps the lending
 * pool growing.
 */
export function reconcileContributions(
  config: CircleConfig,
  standing: { joinedOn: ISODate; monthsPaid: number },
  asOf: ISODate,
): Omit<ContributionStatus, 'memberId'> {
  const monthly = config.membership.monthlyContribution;

  const start = new Date(`${standing.joinedOn}T00:00:00.000Z`);
  const end = new Date(`${asOf}T00:00:00.000Z`);
  const rawMonths =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());

  // A month only counts once its grace period has run out.
  const graceClearedOn = new Date(end);
  graceClearedOn.setUTCDate(graceClearedOn.getUTCDate() - config.membership.gracePeriodDays);
  const graceApplies = graceClearedOn.getUTCDate() < start.getUTCDate();

  const monthsDue = Math.max(0, rawMonths - (graceApplies ? 1 : 0));
  const monthsPaid = Math.min(standing.monthsPaid, monthsDue);
  const monthsMissed = Math.max(0, monthsDue - monthsPaid);

  const amountDue = monthly * monthsDue;
  const amountPaid = monthly * monthsPaid;
  const penalties = monthsMissed * config.membership.lateContributionPenalty;

  return {
    monthsDue,
    monthsPaid,
    monthsMissed,
    amountDue,
    amountPaid,
    arrears: nonNegative(amountDue - amountPaid),
    penalties,
    inGoodStanding: monthsMissed < config.membership.missedContributionsBeforeSuspension,
  };
}

/** Whether a member's annual subscription is current as at a date. */
export function annualFeeDue(joinedOn: ISODate, lastPaidOn: ISODate | null, asOf: ISODate): boolean {
  if (!lastPaidOn) return true;
  const anniversary = new Date(`${lastPaidOn}T00:00:00.000Z`);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  return isAfter(asOf, anniversary.toISOString().slice(0, 10));
}
