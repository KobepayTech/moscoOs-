import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCircleConfig } from '../src/config.js';
import {
  breakEvenUtilisation,
  deriveSustainableRate,
  projectEquityGrowth,
  projectedShareValue,
  rateInputsFromConfig,
  rateSensitivity,
  RateModelError,
} from '../src/rate.js';

const config = defaultCircleConfig();

/**
 * The founding capital structure: thirty members at 5,000,000 each, plus one
 * investor's 200,000,000 facility.
 */
const founding = rateInputsFromConfig(config, {
  equityCapital: 150_000_000,
  facilityCapital: 200_000_000,
});

describe('deriving the lending rate', () => {
  const result = deriveSustainableRate(founding);

  it('only counts capital that is actually out on loan as earning', () => {
    // 85% of 350,000,000.
    assert.equal(result.earningAssets, 297_500_000);
  });

  it('charges the investor’s return only on the part of the facility at work', () => {
    // 297,500,000 of lending draws 150,000,000 of equity first.
    assert.equal(result.equityUtilised, 150_000_000);
    assert.equal(result.facilityUtilised, 147_500_000);
    assert.ok(Math.abs(result.facilityUtilisationRatio - 0.7375) < 1e-9);
  });

  it('lands on 2.5% a month, which is what the circle publishes', () => {
    // Raw solve is ~2.343%; rounded up to the next quarter point.
    assert.ok(Math.abs(result.recommendedMonthlyRate - 0.023432) < 0.0001);
    assert.equal(result.publishedMonthlyRate, 0.025);
    assert.equal(result.publishedMonthlyRate, config.termLoan.monthlyInterestRate);
  });

  it('breaks the rate down so the committee can see what each part pays for', () => {
    const { components } = result;

    // Cost of the investor's money, spread over the earning assets.
    assert.ok(Math.abs(components.costOfExternalCapital - (0.01 * 147_500_000) / 297_500_000) < 1e-9);
    // Running costs.
    assert.ok(Math.abs(components.operatingCost - 2_000_000 / 297_500_000) < 1e-9);
    // Expected losses.
    assert.ok(Math.abs(components.expectedCreditLoss - 0.02 / 12) < 1e-9);
    // The members' own target return.
    assert.ok(Math.abs(components.equityGrowthTarget - (0.02 * 150_000_000) / 297_500_000) < 1e-9);

    const rebuilt =
      components.costOfExternalCapital +
      components.operatingCost +
      components.expectedCreditLoss +
      components.equityGrowthTarget +
      components.otherIncomeOffset;

    assert.ok(Math.abs(rebuilt - result.recommendedMonthlyRate) < 1e-12);
  });

  it('separates breaking even from growing', () => {
    assert.ok(result.breakEvenMonthlyRate < result.recommendedMonthlyRate);
    assert.ok(
      Math.abs(result.recommendedMonthlyRate - result.breakEvenMonthlyRate - result.components.equityGrowthTarget) <
        1e-12,
    );
  });

  it('quotes the annual figures members will actually ask about', () => {
    assert.equal(result.nominalAnnualRate, 0.3);
    // Compounding takes 30% nominal past 34% effective.
    assert.ok(result.effectiveAnnualRate > 0.34 && result.effectiveAnnualRate < 0.35);
  });

  it('beats the members’ target return, because the rate was rounded up', () => {
    assert.ok(result.projectedMonthlySurplus > 0);
    assert.ok(
      result.projectedAnnualReturnOnEquity >= 0.24,
      `expected at least the 24% target, got ${result.projectedAnnualReturnOnEquity}`,
    );
  });

  it('always prices above the cost of the external money it is lending on', () => {
    assert.ok(result.publishedMonthlyRate > founding.investorMonthlyRate);
  });

  it('refuses inputs that cannot produce a rate', () => {
    assert.throws(() => deriveSustainableRate({ ...founding, targetUtilisation: 0 }), RateModelError);
    assert.throws(() => deriveSustainableRate({ ...founding, targetUtilisation: 1.5 }), RateModelError);
    assert.throws(() => deriveSustainableRate({ ...founding, equityCapital: -1 }), RateModelError);
  });
});

describe('what happens when the circle lends less', () => {
  it('needs a higher rate as more capital sits idle', () => {
    const rows = rateSensitivity(founding, [0.4, 0.6, 0.85, 1.0]);

    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(
        rows[i].breakEvenMonthlyRate <= rows[i - 1].breakEvenMonthlyRate,
        'break-even must fall as utilisation rises',
      );
    }

    // Idle money is the real cost: at 40% utilisation the circle needs a
    // materially higher rate on what it does lend.
    assert.ok(rows[0].publishedMonthlyRate > rows[3].publishedMonthlyRate);
  });

  it('finds the level of lending below which a fixed rate loses money', () => {
    const { utilisation } = breakEvenUtilisation(founding, 0.025);

    assert.ok(utilisation !== null);
    assert.ok(utilisation > 0 && utilisation < 0.85, `expected break-even below target, got ${utilisation}`);

    // Sanity: just below that line the circle is losing money each month.
    const below = deriveSustainableRate({ ...founding, targetUtilisation: utilisation - 0.05 });
    assert.ok(below.breakEvenMonthlyRate > 0.025);
  });

  it('reports no break-even at all when the rate cannot cover expected losses', () => {
    const { utilisation } = breakEvenUtilisation(founding, 0.0001);
    assert.equal(utilisation, null);
  });
});

describe('projecting what the members earn', () => {
  it('compounds retained surplus into equity month by month', () => {
    const projection = projectEquityGrowth(founding, 0.025, {
      months: 12,
      monthlyContributionsTotal: 30 * config.membership.monthlyContribution,
    });

    assert.equal(projection.length, 12);
    assert.equal(projection[0].openingEquity, 150_000_000);

    for (let i = 1; i < projection.length; i += 1) {
      assert.equal(projection[i].openingEquity, projection[i - 1].closingEquity);
      assert.ok(projection[i].closingEquity > projection[i - 1].closingEquity);
    }

    // A year of trading at the published rate should grow the members' stake
    // by well over the 24% they targeted, once monthly contributions are in.
    const growth = (projection[11].closingEquity - 150_000_000) / 150_000_000;
    assert.ok(growth > 0.24, `expected growth above target, got ${growth}`);
  });

  it('can model paying the surplus out instead of retaining it', () => {
    const retained = projectEquityGrowth(founding, 0.025, { months: 6 });
    const paidOut = projectEquityGrowth(founding, 0.025, { months: 6, reinvestSurplus: false });

    assert.ok(retained[5].closingEquity > paidOut[5].closingEquity);
    assert.equal(paidOut[5].closingEquity, 150_000_000);
  });

  it('values a single member’s fifty shares at the end of the projection', () => {
    const projection = projectEquityGrowth(founding, 0.025, { months: 12 });
    const value = projectedShareValue(projection, 50, 1500);

    // One thirtieth of the circle.
    assert.ok(value > 5_000_000, 'a member should be ahead after a year');
    assert.ok(Math.abs(value - projection[11].closingEquity / 30) < 2);
  });
});
