/**
 * Deriving the lending rate.
 *
 * The circle's rate is not picked by feel. Every shilling of interest a
 * borrower pays has four calls on it, and the rate is whatever makes them add
 * up:
 *
 *   1. the return owed to external capital, on the part of it actually lent out;
 *   2. the circle's running costs;
 *   3. the loans that will not come back (expected credit loss);
 *   4. the growth the members want on their own share capital.
 *
 * Writing that as an identity over one month, with `A` the average earning
 * assets (capital actually out on loan), `F_u` the average *utilised* facility
 * balance, `E` the members' equity and `r_L` the rate we are solving for:
 *
 *     r_L * A  +  other income
 *        =  r_inv * F_u  +  opex  +  ecl * A  +  g * E
 *
 * so
 *
 *     r_L = (r_inv * F_u + opex + g * E - other income) / A  +  ecl
 *
 * Idle capital is what makes this bite. If only 85% of the money is ever out
 * on loan, the 15% sitting in the account still owes the investor nothing but
 * still has to be carried by the 85% that is working — which is why `A` is
 * utilisation-weighted while `E` is not.
 */

import type { CircleConfig } from './config.js';
import { type Money, applyRate, money, nonNegative } from './money.js';

export interface RateModelInputs {
  /** Member share capital. */
  equityCapital: Money;
  /** External capital committed by investor-members. */
  facilityCapital: Money;
  /** Fraction of total capital expected to be on loan at any moment. */
  targetUtilisation: number;
  /** Monthly return promised to external capital on its utilised balance. */
  investorMonthlyRate: number;
  /** The circle's running cost per month. */
  monthlyOperatingCost: Money;
  /** Expected annual credit loss as a fraction of the portfolio. */
  annualExpectedCreditLoss: number;
  /** Return the members want on their share capital, per year. */
  targetAnnualReturnOnEquity: number;
  /** Fees and fines per month, which reduce what interest has to carry. */
  otherMonthlyIncome?: Money;
  /** Rounding granularity for the published rate. */
  rateRoundingStep?: number;
}

export interface RateComponents {
  /** Each component expressed as a monthly rate on earning assets. */
  costOfExternalCapital: number;
  operatingCost: number;
  expectedCreditLoss: number;
  equityGrowthTarget: number;
  otherIncomeOffset: number;
}

export interface RateModelResult {
  inputs: RateModelInputs;
  totalCapital: Money;
  /** Capital expected to be out on loan — the only capital that earns. */
  earningAssets: Money;
  /** Part of the earning assets drawn from member equity. */
  equityUtilised: Money;
  /** Part of the earning assets drawn from external capital. */
  facilityUtilised: Money;
  /** Fraction of the committed facility that is actually working. */
  facilityUtilisationRatio: number;
  components: RateComponents;
  /** Rate that covers cost and losses but funds no growth. */
  breakEvenMonthlyRate: number;
  /** Rate that additionally funds the members' target return. */
  recommendedMonthlyRate: number;
  /** The above, rounded up to the configured step — the rate to publish. */
  publishedMonthlyRate: number;
  /** Simple annualisation, the way members will quote it. */
  nominalAnnualRate: number;
  /** Compounded annualisation, the true cost of carrying a balance for a year. */
  effectiveAnnualRate: number;
  /** Monthly surplus after every cost, at the published rate. */
  projectedMonthlySurplus: Money;
  /** That surplus as an annual return on member equity. */
  projectedAnnualReturnOnEquity: number;
}

export class RateModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateModelError';
  }
}

/**
 * Trim binary-fraction noise from a published rate.
 *
 * `0.025 * 12` is `0.30000000000000004` in IEEE-754, and a member reading
 * "30.000000000000004% a year" in the app will rightly wonder what else the
 * system is confused about. Ten decimal places is far finer than any rate the
 * circle will ever quote, so nothing meaningful is lost.
 */
function cleanRate(value: number): number {
  return Number(value.toFixed(10));
}

function roundUpToStep(value: number, step: number): number {
  if (!step || step <= 0) return value;
  // Work in integer multiples of the step to dodge binary-fraction drift
  // (0.023432 / 0.0025 lands at 9.3728 and must not become 9.372799999).
  const multiples = Math.ceil(Number((value / step).toFixed(9)));
  return Number((multiples * step).toFixed(10));
}

/**
 * Solve for the lending rate the circle needs in order to meet its
 * obligations and still grow member equity at the target rate.
 */
export function deriveSustainableRate(inputs: RateModelInputs): RateModelResult {
  const {
    equityCapital,
    facilityCapital,
    targetUtilisation,
    investorMonthlyRate,
    monthlyOperatingCost,
    annualExpectedCreditLoss,
    targetAnnualReturnOnEquity,
    otherMonthlyIncome = 0,
    rateRoundingStep = 0.0025,
  } = inputs;

  if (equityCapital < 0 || facilityCapital < 0) {
    throw new RateModelError('Capital amounts must not be negative');
  }
  if (targetUtilisation <= 0 || targetUtilisation > 1) {
    throw new RateModelError(`Target utilisation must fall in (0, 1], got ${targetUtilisation}`);
  }

  const totalCapital = equityCapital + facilityCapital;
  const earningAssets = money(totalCapital * targetUtilisation);

  if (earningAssets <= 0) {
    throw new RateModelError('Cannot derive a rate with no earning assets');
  }

  // Loans draw member equity before they draw external capital, so the
  // facility only starts earning once lending passes the equity line. This is
  // the same waterfall the servicing engine applies day by day.
  const equityUtilised = Math.min(earningAssets, equityCapital);
  const facilityUtilised = nonNegative(earningAssets - equityCapital);
  const facilityUtilisationRatio = facilityCapital === 0 ? 0 : facilityUtilised / facilityCapital;

  const monthlyEcl = annualExpectedCreditLoss / 12;
  const monthlyEquityGrowthTarget = targetAnnualReturnOnEquity / 12;

  const components: RateComponents = {
    costOfExternalCapital: (investorMonthlyRate * facilityUtilised) / earningAssets,
    operatingCost: monthlyOperatingCost / earningAssets,
    expectedCreditLoss: monthlyEcl,
    equityGrowthTarget: (monthlyEquityGrowthTarget * equityCapital) / earningAssets,
    otherIncomeOffset: -(otherMonthlyIncome / earningAssets),
  };

  const breakEvenMonthlyRate =
    components.costOfExternalCapital +
    components.operatingCost +
    components.expectedCreditLoss +
    components.otherIncomeOffset;

  const recommendedMonthlyRate = breakEvenMonthlyRate + components.equityGrowthTarget;
  const publishedMonthlyRate = roundUpToStep(recommendedMonthlyRate, rateRoundingStep);

  // Re-run the identity at the published rate to see what actually lands in
  // retained earnings once rounding is taken into account.
  const monthlyInterestIncome = publishedMonthlyRate * earningAssets;
  const monthlyFacilityCost = investorMonthlyRate * facilityUtilised;
  const monthlyLossProvision = monthlyEcl * earningAssets;
  const projectedMonthlySurplus = money(
    monthlyInterestIncome + otherMonthlyIncome - monthlyFacilityCost - monthlyOperatingCost - monthlyLossProvision,
  );

  return {
    inputs,
    totalCapital,
    earningAssets,
    equityUtilised,
    facilityUtilised,
    facilityUtilisationRatio,
    components,
    breakEvenMonthlyRate,
    recommendedMonthlyRate,
    publishedMonthlyRate,
    nominalAnnualRate: cleanRate(publishedMonthlyRate * 12),
    effectiveAnnualRate: cleanRate(Math.pow(1 + publishedMonthlyRate, 12) - 1),
    projectedMonthlySurplus,
    projectedAnnualReturnOnEquity: equityCapital === 0 ? 0 : (projectedMonthlySurplus * 12) / equityCapital,
  };
}

/** Build the inputs implied by a circle's config and its current capital. */
export function rateInputsFromConfig(
  config: CircleConfig,
  capital: { equityCapital: Money; facilityCapital: Money },
): RateModelInputs {
  return {
    equityCapital: capital.equityCapital,
    facilityCapital: capital.facilityCapital,
    targetUtilisation: config.growth.targetUtilisation,
    investorMonthlyRate: config.facility.investorMonthlyRate,
    monthlyOperatingCost: config.growth.monthlyOperatingCost,
    annualExpectedCreditLoss: config.growth.annualExpectedCreditLoss,
    targetAnnualReturnOnEquity: config.growth.targetAnnualReturnOnEquity,
    otherMonthlyIncome: config.growth.otherMonthlyIncome,
    rateRoundingStep: config.growth.rateRoundingStep,
  };
}

export interface SensitivityRow {
  targetUtilisation: number;
  earningAssets: Money;
  facilityUtilised: Money;
  breakEvenMonthlyRate: number;
  publishedMonthlyRate: number;
  projectedAnnualReturnOnEquity: number;
}

/**
 * How the required rate moves as lending activity changes.
 *
 * The headline risk for a circle is not the rate — it is idle money. A circle
 * that lends out only half its capital needs a much higher rate on that half
 * to pay the same investor and hit the same target, and this table is what
 * makes that visible before the committee sets the price.
 */
export function rateSensitivity(
  inputs: RateModelInputs,
  utilisations: readonly number[] = [0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0],
): SensitivityRow[] {
  return utilisations.map((targetUtilisation) => {
    const result = deriveSustainableRate({ ...inputs, targetUtilisation });
    return {
      targetUtilisation,
      earningAssets: result.earningAssets,
      facilityUtilised: result.facilityUtilised,
      breakEvenMonthlyRate: result.breakEvenMonthlyRate,
      publishedMonthlyRate: result.publishedMonthlyRate,
      projectedAnnualReturnOnEquity: result.projectedAnnualReturnOnEquity,
    };
  });
}

export interface BreakEvenUtilisation {
  /** Utilisation at which the published rate exactly covers costs. */
  utilisation: number | null;
  /** Capital that must be on loan at that utilisation. */
  earningAssets: Money | null;
}

/**
 * The lowest level of lending at which a *fixed* published rate still covers
 * the investor, the running costs and expected losses. Below this line the
 * circle is eating its own equity every month, however healthy the rate looks.
 */
export function breakEvenUtilisation(inputs: RateModelInputs, publishedMonthlyRate: number): BreakEvenUtilisation {
  const totalCapital = inputs.equityCapital + inputs.facilityCapital;
  if (totalCapital <= 0) return { utilisation: null, earningAssets: null };

  const monthlyEcl = inputs.annualExpectedCreditLoss / 12;
  const otherIncome = inputs.otherMonthlyIncome ?? 0;

  // Margin per shilling lent, before the fixed monthly costs are covered.
  const marginPerShilling = publishedMonthlyRate - monthlyEcl;
  if (marginPerShilling <= 0) return { utilisation: null, earningAssets: null };

  // Scan the utilisation range: the facility cost is piecewise linear in
  // assets (zero until lending passes the equity line), so a direct solve
  // would need case analysis for little gain in precision.
  const STEPS = 10_000;
  for (let step = 1; step <= STEPS; step += 1) {
    const utilisation = step / STEPS;
    const earningAssets = totalCapital * utilisation;
    const facilityUtilised = Math.max(0, earningAssets - inputs.equityCapital);
    const surplus =
      publishedMonthlyRate * earningAssets +
      otherIncome -
      inputs.investorMonthlyRate * facilityUtilised -
      inputs.monthlyOperatingCost -
      monthlyEcl * earningAssets;
    if (surplus >= 0) {
      return { utilisation, earningAssets: money(earningAssets) };
    }
  }

  return { utilisation: null, earningAssets: null };
}

export interface GrowthProjection {
  month: number;
  openingEquity: Money;
  contributions: Money;
  surplus: Money;
  closingEquity: Money;
}

/**
 * Project member equity forward, compounding retained surplus alongside the
 * monthly contributions. This is the number members actually care about: what
 * their 50 shares are worth after a year of the circle running.
 */
export function projectEquityGrowth(
  inputs: RateModelInputs,
  publishedMonthlyRate: number,
  options: { months: number; monthlyContributionsTotal?: Money; reinvestSurplus?: boolean },
): GrowthProjection[] {
  const { months, monthlyContributionsTotal = 0, reinvestSurplus = true } = options;
  const monthlyEcl = inputs.annualExpectedCreditLoss / 12;
  const otherIncome = inputs.otherMonthlyIncome ?? 0;

  const rows: GrowthProjection[] = [];
  let equity = inputs.equityCapital;

  for (let month = 1; month <= months; month += 1) {
    const openingEquity = equity;
    const totalCapital = openingEquity + inputs.facilityCapital;
    const earningAssets = totalCapital * inputs.targetUtilisation;
    const facilityUtilised = Math.max(0, earningAssets - openingEquity);

    const surplus = money(
      publishedMonthlyRate * earningAssets +
        otherIncome -
        inputs.investorMonthlyRate * facilityUtilised -
        inputs.monthlyOperatingCost -
        monthlyEcl * earningAssets,
    );

    const contributions = monthlyContributionsTotal;
    const closingEquity = openingEquity + contributions + (reinvestSurplus ? surplus : 0);

    rows.push({ month, openingEquity, contributions, surplus, closingEquity });
    equity = closingEquity;
  }

  return rows;
}

/**
 * What a single member's stake is worth at the end of a projection, given the
 * shares they hold. Used by the mobile app's "what my shares are worth" panel.
 */
export function projectedShareValue(
  projection: readonly GrowthProjection[],
  memberShares: number,
  issuedShares: number,
): Money {
  if (issuedShares <= 0 || projection.length === 0) return 0;
  const finalEquity = projection[projection.length - 1].closingEquity;
  return applyRate(finalEquity, memberShares / issuedShares);
}
