import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCircleConfig } from '../src/config.js';
import {
  accrueFacilityInterest,
  createFacility,
  facilityStatement,
  lendingHeadroom,
  repaymentQueue,
  splitUtilisation,
  type Facility,
} from '../src/facility.js';

const config = defaultCircleConfig();

/**
 * The founding example: thirty members bring 150,000,000 of share capital, and
 * one member advances a further 200,000,000 as a facility. The investor earns
 * only on the part of their money the circle actually lends out.
 */
describe('the 150,000,000 + 200,000,000 waterfall', () => {
  const facility = createFacility(config, {
    id: 'fac_1',
    investorMemberId: 'mem_investor',
    principal: 200_000_000,
    fundedOn: '2026-01-01',
  });

  const EQUITY = 150_000_000;

  const utilisedAt = (deployed: number) =>
    splitUtilisation(EQUITY, deployed, [facility], '2026-02-01').facilityUtilisedTotal;

  it('pays the investor nothing while lending stays below the equity line', () => {
    assert.equal(utilisedAt(0), 0);
    assert.equal(utilisedAt(50_000_000), 0);
    assert.equal(utilisedAt(149_999_999), 0);
  });

  it('pays the investor nothing at exactly the equity line', () => {
    assert.equal(utilisedAt(150_000_000), 0);
  });

  it('puts 50,000,000 of the facility to work once lending reaches 200,000,000', () => {
    // The members' own worked example.
    assert.equal(utilisedAt(200_000_000), 50_000_000);
  });

  it('puts the whole facility to work once lending reaches 350,000,000', () => {
    assert.equal(utilisedAt(350_000_000), 200_000_000);
  });

  it('never puts more to work than the investor committed', () => {
    assert.equal(utilisedAt(500_000_000), 200_000_000);
  });

  it('reports the idle balance, which is what earns nothing', () => {
    const split = splitUtilisation(EQUITY, 200_000_000, [facility], '2026-02-01');
    assert.equal(split.facilityUtilisedTotal, 50_000_000);
    assert.equal(split.facilityIdle, 150_000_000);
    assert.equal(split.equityUtilised, 150_000_000);
  });

  it('draws member equity before external capital, always', () => {
    const split = splitUtilisation(EQUITY, 120_000_000, [facility], '2026-02-01');
    assert.equal(split.equityUtilised, 120_000_000);
    assert.equal(split.facilityUtilisedTotal, 0);
  });
});

describe('several facilities at once', () => {
  const equal = (id: string, principal: number, fundedOn: string): Facility =>
    createFacility(config, { id, investorMemberId: `inv_${id}`, principal, fundedOn });

  it('shares a tranche pro rata between facilities of equal seniority', () => {
    const a = equal('fac_a', 100_000_000, '2026-01-01');
    const b = equal('fac_b', 300_000_000, '2026-01-05');

    // 100,000,000 of demand beyond equity, split 1:3 by committed principal.
    const split = splitUtilisation(150_000_000, 250_000_000, [a, b], '2026-02-01');

    assert.equal(split.facilityUtilisedTotal, 100_000_000);
    assert.equal(split.perFacility.get('fac_a'), 25_000_000);
    assert.equal(split.perFacility.get('fac_b'), 75_000_000);
  });

  it('exhausts senior facilities first when seniority differs', () => {
    const senior = createFacility(config, {
      id: 'fac_senior',
      investorMemberId: 'inv_s',
      principal: 60_000_000,
      fundedOn: '2026-01-01',
      seniority: 0,
    });
    const junior = createFacility(config, {
      id: 'fac_junior',
      investorMemberId: 'inv_j',
      principal: 200_000_000,
      fundedOn: '2026-01-01',
      seniority: 1,
    });

    const split = splitUtilisation(150_000_000, 240_000_000, [senior, junior], '2026-02-01');

    assert.equal(split.perFacility.get('fac_senior'), 60_000_000, 'senior fills first');
    assert.equal(split.perFacility.get('fac_junior'), 30_000_000, 'junior takes the remainder');
  });

  it('can draw sequentially instead, by funding date', () => {
    const first = equal('fac_first', 100_000_000, '2026-01-01');
    const second = equal('fac_second', 100_000_000, '2026-06-01');

    const split = splitUtilisation(150_000_000, 210_000_000, [first, second], '2026-07-01', 'sequential');

    assert.equal(split.perFacility.get('fac_first'), 60_000_000);
    assert.equal(split.perFacility.get('fac_second'), 0);
  });

  it('ignores a facility that had not been funded yet on the date in question', () => {
    const later = equal('fac_later', 100_000_000, '2026-06-01');
    const split = splitUtilisation(150_000_000, 200_000_000, [later], '2026-02-01');
    assert.equal(split.facilityUtilisedTotal, 0);
  });

  it('ignores a facility that has already been fully repaid', () => {
    const repaid = createFacility(config, {
      id: 'fac_repaid',
      investorMemberId: 'inv_r',
      principal: 100_000_000,
      fundedOn: '2026-01-01',
      repaidPrincipal: 100_000_000,
    });
    const split = splitUtilisation(150_000_000, 200_000_000, [repaid], '2026-03-01');
    assert.equal(split.facilityUtilisedTotal, 0);
  });
});

describe('accruing the investor return', () => {
  const facility = createFacility(config, {
    id: 'fac_1',
    investorMemberId: 'mem_investor',
    principal: 200_000_000,
    fundedOn: '2026-01-01',
    monthlyRate: 0.01,
  });

  it('earns nothing over a period when lending never passed the equity line', () => {
    const result = accrueFacilityInterest(
      [facility],
      [{ date: '2026-01-01', equityPool: 150_000_000, outstandingDeployed: 100_000_000 }],
      { from: '2026-01-01', to: '2026-02-01' },
    );

    assert.equal(result.totalInterestAccrued, 0);
    assert.equal(result.perFacility[0].utilisedDays, 0);
    assert.equal(result.perFacility[0].averageUtilised, 0);
  });

  it('earns on the utilised balance alone, day by day', () => {
    // 50,000,000 working for the whole of a 31-day January.
    const result = accrueFacilityInterest(
      [facility],
      [{ date: '2026-01-01', equityPool: 150_000_000, outstandingDeployed: 200_000_000 }],
      { from: '2026-01-01', to: '2026-02-01' },
    );

    const expected = Math.round(50_000_000 * ((0.01 * 12) / 365) * 31);
    assert.equal(result.totalInterestAccrued, expected);
    assert.equal(result.perFacility[0].utilisedDays, 31);
    assert.equal(result.perFacility[0].averageUtilised, 50_000_000);
    assert.equal(result.perFacility[0].peakUtilised, 50_000_000);
  });

  it('follows the book as it moves, treating each reading as holding until the next', () => {
    const result = accrueFacilityInterest(
      [facility],
      [
        // Fifteen days with nothing of the facility at work.
        { date: '2026-01-01', equityPool: 150_000_000, outstandingDeployed: 120_000_000 },
        // Then sixteen days with 50,000,000 working.
        { date: '2026-01-16', equityPool: 150_000_000, outstandingDeployed: 200_000_000 },
      ],
      { from: '2026-01-01', to: '2026-02-01' },
    );

    const daily = (0.01 * 12) / 365;
    assert.equal(result.totalInterestAccrued, Math.round(50_000_000 * daily * 16));
    assert.equal(result.perFacility[0].utilisedDays, 16);
    // Average across the whole month, idle days included.
    assert.equal(result.perFacility[0].averageUtilised, Math.round((50_000_000 * 16) / 31));
  });

  it('reports how hard the facility worked, as a fraction of what was committed', () => {
    const result = accrueFacilityInterest(
      [facility],
      [{ date: '2026-01-01', equityPool: 150_000_000, outstandingDeployed: 350_000_000 }],
      { from: '2026-01-01', to: '2026-02-01' },
    );

    assert.equal(result.perFacility[0].utilisationRatio, 1);
  });

  it('clips accrual to the window, ignoring readings outside it', () => {
    const result = accrueFacilityInterest(
      [facility],
      [
        { date: '2025-06-01', equityPool: 150_000_000, outstandingDeployed: 350_000_000 },
        { date: '2026-01-01', equityPool: 150_000_000, outstandingDeployed: 200_000_000 },
      ],
      { from: '2026-01-01', to: '2026-01-11' },
    );

    assert.equal(result.days, 10);
    assert.equal(result.totalInterestAccrued, Math.round(50_000_000 * ((0.01 * 12) / 365) * 10));
  });
});

describe('what the investor is owed', () => {
  it('states principal plus earned return, net of what was already paid', () => {
    const facility = createFacility(config, {
      id: 'fac_1',
      investorMemberId: 'mem_investor',
      principal: 200_000_000,
      fundedOn: '2026-01-01',
      paidInterest: 100_000,
    });

    const accrual = accrueFacilityInterest(
      [facility],
      [{ date: '2026-01-01', equityPool: 150_000_000, outstandingDeployed: 200_000_000 }],
      { from: '2026-01-01', to: '2026-02-01' },
    ).perFacility[0];

    const statement = facilityStatement(facility, accrual, { asOf: '2026-02-01' });

    assert.equal(statement.totalDue, 200_000_000 + accrual.interestAccrued - 100_000);
    assert.equal(accrual.interestOutstanding, accrual.interestAccrued - 100_000);
  });

  it('holds the investor to the minimum commitment before they may withdraw', () => {
    const facility = createFacility(config, {
      id: 'fac_1',
      investorMemberId: 'mem_investor',
      principal: 200_000_000,
      fundedOn: '2026-01-01',
    });

    // Default commitment is three months from funding.
    assert.equal(facility.committedUntil, '2026-04-01');

    const accrual = accrueFacilityInterest([facility], [], { from: '2026-01-01', to: '2026-02-01' })
      .perFacility[0];

    assert.equal(facilityStatement(facility, accrual, { asOf: '2026-02-01' }).withdrawable, false);
    assert.equal(facilityStatement(facility, accrual, { asOf: '2026-05-01' }).withdrawable, true);
  });

  it('queues repayment senior-first, and earned return before capital', () => {
    const senior = createFacility(config, {
      id: 'fac_senior',
      investorMemberId: 'inv_s',
      principal: 50_000_000,
      fundedOn: '2026-01-01',
      seniority: 0,
    });
    const junior = createFacility(config, {
      id: 'fac_junior',
      investorMemberId: 'inv_j',
      principal: 50_000_000,
      fundedOn: '2026-01-01',
      seniority: 1,
    });

    const accruals = accrueFacilityInterest(
      [senior, junior],
      [{ date: '2026-01-01', equityPool: 0, outstandingDeployed: 100_000_000 }],
      { from: '2026-01-01', to: '2026-02-01' },
    ).perFacility;

    const queue = repaymentQueue([senior, junior], accruals);

    // Junior ranks last for seniority, so it is repaid first when the circle
    // is *returning* capital: the senior lender stays in longest.
    assert.equal(queue[0].facilityId, 'fac_junior');
    assert.equal(queue[1].facilityId, 'fac_senior');
    for (const row of queue) {
      assert.ok(row.interestDue > 0, 'each facility has earned something');
      assert.equal(row.totalDue, row.interestDue + row.principalDue);
    }
  });
});

describe('how much the circle can still lend', () => {
  it('counts equity and committed facilities, less what is already out', () => {
    const facility = createFacility(config, {
      id: 'fac_1',
      investorMemberId: 'mem_investor',
      principal: 200_000_000,
      fundedOn: '2026-01-01',
    });

    const headroom = lendingHeadroom(config, 150_000_000, 200_000_000, [facility], '2026-02-01');

    assert.equal(headroom.totalCapital, 350_000_000);
    assert.equal(headroom.available, 150_000_000);
    assert.ok(Math.abs(headroom.utilisationRatio - 200 / 350) < 1e-9);
  });

  it('caps a single loan at the policy share of the whole capital base', () => {
    const facility = createFacility(config, {
      id: 'fac_1',
      investorMemberId: 'mem_investor',
      principal: 200_000_000,
      fundedOn: '2026-01-01',
    });

    const headroom = lendingHeadroom(config, 150_000_000, 0, [facility], '2026-02-01');

    // 25% of 350,000,000 under the founding policy.
    assert.equal(headroom.maxSingleLoan, 87_500_000);
  });

  it('caps the single loan at whatever cash is actually free when that is less', () => {
    const facility = createFacility(config, {
      id: 'fac_1',
      investorMemberId: 'mem_investor',
      principal: 200_000_000,
      fundedOn: '2026-01-01',
    });

    const headroom = lendingHeadroom(config, 150_000_000, 330_000_000, [facility], '2026-02-01');

    assert.equal(headroom.available, 20_000_000);
    assert.equal(headroom.maxSingleLoan, 20_000_000);
  });
});
