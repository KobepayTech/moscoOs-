/**
 * Circle configuration.
 *
 * Every number a circle can argue about lives here, so that changing policy is
 * a config change and never a code change. The defaults encode the founding
 * rules of Mamogoro Circles as agreed: TSh 100,000 a share, 50 shares to join
 * (TSh 5,000,000), a 1,000,000-share authorised capital, three-month trade
 * loans repaid at 10% of principal a month, and a short-term window priced at
 * a flat 5%.
 */

import type { Money } from './money.js';

export interface ShareConfig {
  /** Price of one share, and the value each share carries in a loss cascade. */
  parValue: Money;
  /** Ceiling on shares the circle may ever issue. */
  authorized: number;
  /** Shares a member must hold to be a member in good standing. */
  minimumMembershipShares: number;
  /** Ceiling on any one member's holding, as a fraction of issued shares. 0 disables. */
  maxHoldingRatio: number;
}

export interface MembershipConfig {
  /** One-off fee on joining. Income, not capital — it buys no shares. */
  joiningFee: Money;
  /** Annual subscription. Income, not capital. */
  annualFee: Money;
  /** Monthly contribution every member owes. */
  monthlyContribution: Money;
  /**
   * When true a monthly contribution buys shares at par (the default: TSh
   * 100,000 a month is exactly one share). When false it accrues to the
   * member's savings balance instead.
   */
  monthlyContributionBuysShares: boolean;
  /** Days after month end before a contribution counts as late. */
  gracePeriodDays: number;
  /** Flat charge per missed monthly contribution. */
  lateContributionPenalty: Money;
  /** Consecutive missed contributions before a member is suspended from borrowing. */
  missedContributionsBeforeSuspension: number;
}

export interface TermLoanConfig {
  /** Default term, in months, for a trade loan. */
  defaultTermMonths: number;
  minTermMonths: number;
  maxTermMonths: number;
  /** Interest rate per month, applied to the scheduled outstanding balance. */
  monthlyInterestRate: number;
  /**
   * Minimum principal a borrower must return each month, as a fraction of the
   * amount originally taken. The founding rule is 10%.
   */
  minimumMonthlyPrincipalRate: number;
  /** Penalty rate per month charged on overdue amounts. */
  penaltyMonthlyRate: number;
  /** Days after the final service instalment before the balloon falls due. */
  balloonGraceDays: number;
  /** Hard ceiling on a single loan. `null` means "no fixed ceiling". */
  maxPrincipal: Money | null;
  /** Ceiling on a loan as a multiple of the whole circle's lendable capital. */
  maxPrincipalAsRatioOfCapital: number;
  /** Rebate unearned interest when a borrower settles early. */
  earlySettlementRebate: boolean;
}

export interface ShortTermLoanConfig {
  /** Longest a short-term loan may run. */
  maxDays: number;
  /** Flat charge on the amount taken. The founding rule is 5%. */
  flatRate: number;
  /**
   * `flat` charges `flatRate` regardless of how many days the money is out
   * (the rule as agreed). `prorated` charges `flatRate * days / maxDays`, which
   * makes a five-day loan cost a sixth of a thirty-day one.
   */
  interestMode: 'flat' | 'prorated';
  /** Minimum charge when `interestMode` is `prorated`. */
  minimumFee: Money;
  maxConcurrentPerMember: number;
  /** Sponsor cover required, as a multiple of principal. Stricter than term loans. */
  requiredSponsorCoverage: number;
  /** Penalty rate per day past the due date. */
  dailyPenaltyRate: number;
  maxPrincipal: Money;
  /** Days a member must wait after settling before taking another. */
  cooldownDays: number;
}

export interface SponsorshipConfig {
  /** Cover required, as a multiple of principal. The founding rule is 1.0x. */
  coverageRatio: number;
  /** Count the borrower's own unpledged share value toward the requirement. */
  includeBorrowerSelfCover: boolean;
  /** Hours a sponsor has to accept or decline before the request expires. */
  responseWindowHours: number;
  maxSponsorsPerLoan: number;
  /** Disburse automatically the moment cover is complete. */
  autoApproveOnFullCoverage: boolean;
  /** Largest share of one loan a single sponsor may carry. 0 disables. */
  maxSingleSponsorRatio: number;
}

export interface FacilityConfig {
  /** Return paid to external capital, per month, on the *utilised* balance. */
  investorMonthlyRate: number;
  /** How simultaneous facilities of equal seniority share the drawn amount. */
  allocation: 'pro-rata' | 'sequential';
  /** Shortest commitment a facility may carry. */
  minimumTermMonths: number;
  /** Day-count basis for daily accrual. */
  accrualBasisDays: 365 | 360;
  /** Notice, in days, an investor must give before withdrawing. */
  withdrawalNoticeDays: number;
}

export type DeletableEntity =
  | 'member_profile'
  | 'loan_application'
  | 'announcement'
  | 'document'
  | 'meeting_minute'
  | 'comment'
  | 'sponsorship_request';

export interface GovernanceConfig {
  votingWindowHours: number;
  /** `shares` weights a vote by holding; `per-member` gives everyone one vote. */
  weighting: 'shares' | 'per-member';
  /** Fraction of total voting weight that must vote for the result to count. */
  quorumRatio: number;
  /** Fraction of the weight *cast* that must be in favour. */
  passThresholdRatio: number;
  /** Entity kinds members may vote to delete outright. */
  deletableEntities: DeletableEntity[];
  /**
   * Financial history is never deleted, only reversed. A vote against a posted
   * entry produces a balancing reversal that leaves the original visible.
   */
  financialRecordsAreImmutable: boolean;
  /** A proposer may not also vote on their own proposal. */
  proposerMayVote: boolean;
}

export interface GrowthTargetConfig {
  /** Share of total capital expected to be out on loan at any time. */
  targetUtilisation: number;
  /** The circle's running cost per month. */
  monthlyOperatingCost: Money;
  /** Expected annual credit loss, as a fraction of the portfolio. */
  annualExpectedCreditLoss: number;
  /** Return the members want on their share capital, per year. */
  targetAnnualReturnOnEquity: number;
  /** Non-interest income per month (fees, fines) that offsets the lending rate. */
  otherMonthlyIncome: Money;
  /** Rounding granularity for the recommended rate, e.g. 0.0025 = quarter point. */
  rateRoundingStep: number;
}

export interface ApplicationFeeConfig {
  /** Fixed fee a borrower pays before their request goes out to sponsors. */
  amount: Money;
  /** Share the payment rail deducts before remitting to the circle. */
  processingFeeRate: number;
  /**
   * Refund the fee when the loan is not approved.
   *
   * When true the fee is a liability on receipt and only becomes income once
   * the loan is approved — the circle has not earned it until it has done the
   * thing the member paid for.
   */
  refundable: boolean;
  /**
   * `net` refunds what the circle actually received; `gross` refunds what the
   * member paid, with the circle absorbing the rail's charge.
   */
  refundMode: 'net' | 'gross';
  /** Rail used to collect it. */
  provider: string;
  /** Days an unpaid application waits before it lapses. */
  unpaidExpiryDays: number;
}

export interface PlatformConfig {
  /** The company operating the software and collecting the subscription. */
  operator: string;
  /** Monthly subscription per member. Revenue of the operator, never the circle's. */
  memberSubscription: Money;
  /** Days past the start of a month before an unpaid subscription lapses. */
  subscriptionGraceDays: number;
  /** Rail used to collect the subscription. */
  subscriptionProvider: string;
  /** The circle's account with the remitting rail, where net fees land. */
  settlementProvider: string;
}

export interface CircleConfig {
  circleName: string;
  currency: string;
  /** Members expected at full formation. Used by the rate model's projections. */
  targetMembership: number;
  shares: ShareConfig;
  membership: MembershipConfig;
  applicationFee: ApplicationFeeConfig;
  platform: PlatformConfig;
  termLoan: TermLoanConfig;
  shortTermLoan: ShortTermLoanConfig;
  sponsorship: SponsorshipConfig;
  facility: FacilityConfig;
  governance: GovernanceConfig;
  growth: GrowthTargetConfig;
}

/**
 * The founding configuration of Mamogoro Circles.
 *
 * `termLoan.monthlyInterestRate` is not a guess: it is the output of
 * `deriveSustainableRate` run against `growth` and the founding capital
 * structure (TSh 150,000,000 of member equity alongside a TSh 200,000,000
 * facility), rounded up to the next quarter point. See `rate.ts` and
 * docs/FINANCIAL-MODEL.md for the derivation.
 */
export function defaultCircleConfig(): CircleConfig {
  return {
    circleName: 'Mamogoro Circles',
    currency: 'TZS',
    targetMembership: 30,

    shares: {
      parValue: 100_000,
      authorized: 1_000_000,
      minimumMembershipShares: 50,
      maxHoldingRatio: 0.25,
    },

    membership: {
      joiningFee: 20_000,
      annualFee: 50_000,
      monthlyContribution: 100_000,
      monthlyContributionBuysShares: true,
      gracePeriodDays: 10,
      lateContributionPenalty: 5_000,
      missedContributionsBeforeSuspension: 3,
    },

    applicationFee: {
      amount: 50_000,
      processingFeeRate: 0.05,
      refundable: true,
      refundMode: 'net',
      provider: 'kobepay',
      unpaidExpiryDays: 7,
    },

    platform: {
      operator: 'KobeTech',
      // PLACEHOLDER — the monthly subscription has not been set. Confirm the
      // amount before billing anyone.
      memberSubscription: 5_000,
      subscriptionGraceDays: 7,
      subscriptionProvider: 'palmpesa',
      settlementProvider: 'kobepay',
    },

    termLoan: {
      defaultTermMonths: 3,
      minTermMonths: 1,
      maxTermMonths: 12,
      monthlyInterestRate: 0.025,
      minimumMonthlyPrincipalRate: 0.1,
      penaltyMonthlyRate: 0.01,
      balloonGraceDays: 0,
      maxPrincipal: null,
      maxPrincipalAsRatioOfCapital: 0.25,
      earlySettlementRebate: true,
    },

    shortTermLoan: {
      maxDays: 30,
      flatRate: 0.05,
      interestMode: 'flat',
      minimumFee: 0,
      maxConcurrentPerMember: 1,
      requiredSponsorCoverage: 1.0,
      dailyPenaltyRate: 0.005,
      maxPrincipal: 10_000_000,
      cooldownDays: 7,
    },

    sponsorship: {
      coverageRatio: 1.0,
      includeBorrowerSelfCover: true,
      responseWindowHours: 72,
      maxSponsorsPerLoan: 20,
      autoApproveOnFullCoverage: true,
      maxSingleSponsorRatio: 0.5,
    },

    facility: {
      investorMonthlyRate: 0.01,
      allocation: 'pro-rata',
      minimumTermMonths: 3,
      accrualBasisDays: 365,
      withdrawalNoticeDays: 90,
    },

    governance: {
      votingWindowHours: 72,
      weighting: 'shares',
      quorumRatio: 0.5,
      passThresholdRatio: 2 / 3,
      deletableEntities: [
        'member_profile',
        'loan_application',
        'announcement',
        'document',
        'meeting_minute',
        'comment',
        'sponsorship_request',
      ],
      financialRecordsAreImmutable: true,
      proposerMayVote: true,
    },

    growth: {
      targetUtilisation: 0.85,
      monthlyOperatingCost: 2_000_000,
      annualExpectedCreditLoss: 0.02,
      targetAnnualReturnOnEquity: 0.24,
      otherMonthlyIncome: 0,
      rateRoundingStep: 0.0025,
    },
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends readonly unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

export type CircleConfigOverrides = DeepPartial<CircleConfig>;

/** Overlay partial overrides onto a base config, one section at a time. */
export function mergeConfig(base: CircleConfig, overrides: CircleConfigOverrides = {}): CircleConfig {
  const merged = { ...base } as CircleConfig;
  for (const [key, value] of Object.entries(overrides) as [keyof CircleConfig, unknown][]) {
    if (value === undefined) continue;
    const current = base[key];
    const target = merged as unknown as Record<string, unknown>;
    if (current !== null && typeof current === 'object' && !Array.isArray(current) && typeof value === 'object') {
      target[key] = { ...(current as object), ...(value as object) };
    } else {
      target[key] = value;
    }
  }
  return merged;
}

export interface ConfigProblem {
  path: string;
  message: string;
}

/** Check a config for rules that contradict each other. */
export function validateConfig(config: CircleConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const fail = (path: string, message: string) => problems.push({ path, message });

  if (config.shares.parValue <= 0) fail('shares.parValue', 'Share par value must be positive');
  if (config.shares.minimumMembershipShares <= 0) {
    fail('shares.minimumMembershipShares', 'A member must subscribe at least one share');
  }
  if (config.shares.authorized < config.shares.minimumMembershipShares * config.targetMembership) {
    fail(
      'shares.authorized',
      `Authorised capital (${config.shares.authorized}) cannot seat ${config.targetMembership} members ` +
        `at ${config.shares.minimumMembershipShares} shares each`,
    );
  }
  if (config.shares.maxHoldingRatio < 0 || config.shares.maxHoldingRatio > 1) {
    fail('shares.maxHoldingRatio', 'Holding ceiling must be a fraction between 0 and 1');
  }

  if (config.termLoan.minimumMonthlyPrincipalRate <= 0 || config.termLoan.minimumMonthlyPrincipalRate > 1) {
    fail('termLoan.minimumMonthlyPrincipalRate', 'Monthly principal step must fall in (0, 1]');
  }
  if (config.termLoan.monthlyInterestRate < 0) {
    fail('termLoan.monthlyInterestRate', 'Interest rate must not be negative');
  }
  if (config.termLoan.minTermMonths < 1) fail('termLoan.minTermMonths', 'Minimum term must be at least one month');
  if (config.termLoan.maxTermMonths < config.termLoan.minTermMonths) {
    fail('termLoan.maxTermMonths', 'Maximum term must not be shorter than the minimum');
  }
  if (
    config.termLoan.defaultTermMonths < config.termLoan.minTermMonths ||
    config.termLoan.defaultTermMonths > config.termLoan.maxTermMonths
  ) {
    fail('termLoan.defaultTermMonths', 'Default term must fall inside the allowed range');
  }

  // The circle only grows if borrowers pay more than external capital costs.
  if (config.termLoan.monthlyInterestRate <= config.facility.investorMonthlyRate) {
    fail(
      'termLoan.monthlyInterestRate',
      `Lending rate (${config.termLoan.monthlyInterestRate}) must exceed the cost of external capital ` +
        `(${config.facility.investorMonthlyRate}); otherwise every loan funded by a facility loses money`,
    );
  }

  if (config.shortTermLoan.maxDays <= 0) fail('shortTermLoan.maxDays', 'Short-term window must be positive');
  if (config.shortTermLoan.flatRate < 0) fail('shortTermLoan.flatRate', 'Flat rate must not be negative');

  if (config.sponsorship.coverageRatio < 0) {
    fail('sponsorship.coverageRatio', 'Coverage ratio must not be negative');
  }
  if (config.sponsorship.maxSingleSponsorRatio < 0 || config.sponsorship.maxSingleSponsorRatio > 1) {
    fail('sponsorship.maxSingleSponsorRatio', 'Single-sponsor ceiling must be a fraction between 0 and 1');
  }

  if (config.applicationFee.amount < 0) {
    fail('applicationFee.amount', 'Application fee must not be negative');
  }
  if (config.applicationFee.processingFeeRate < 0 || config.applicationFee.processingFeeRate >= 1) {
    fail(
      'applicationFee.processingFeeRate',
      'Processing fee rate must fall in [0, 1); at 1 or above the circle would receive nothing',
    );
  }
  if (config.platform.memberSubscription < 0) {
    fail('platform.memberSubscription', 'Subscription must not be negative');
  }
  if (config.platform.subscriptionGraceDays < 0) {
    fail('platform.subscriptionGraceDays', 'Grace period must not be negative');
  }

  if (config.governance.quorumRatio < 0 || config.governance.quorumRatio > 1) {
    fail('governance.quorumRatio', 'Quorum must be a fraction between 0 and 1');
  }
  if (config.governance.passThresholdRatio <= 0.5 || config.governance.passThresholdRatio > 1) {
    fail('governance.passThresholdRatio', 'Pass threshold must be greater than half and at most all');
  }

  if (config.growth.targetUtilisation <= 0 || config.growth.targetUtilisation > 1) {
    fail('growth.targetUtilisation', 'Target utilisation must fall in (0, 1]');
  }

  return problems;
}

/** Throw if the config contains contradictions. */
export function assertValidConfig(config: CircleConfig): CircleConfig {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    const detail = problems.map((p) => `  - ${p.path}: ${p.message}`).join('\n');
    throw new Error(`Invalid circle configuration:\n${detail}`);
  }
  return config;
}

/** Capital a prospective member must bring to take up a seat. */
export function requiredEntryCapital(config: CircleConfig): Money {
  return config.shares.minimumMembershipShares * config.shares.parValue;
}

/** Cash a prospective member needs on day one: share capital plus opening fees. */
export function requiredEntryPayment(config: CircleConfig): Money {
  return requiredEntryCapital(config) + config.membership.joiningFee + config.membership.annualFee;
}
