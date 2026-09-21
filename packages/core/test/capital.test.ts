import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  capitalPosition,
  concentration,
  daysUntilFundable,
  expectedInflows,
  fundingPlan,
  projectCash,
  type CapitalInputs,
  type CollateralCommitment,
  type LoanSnapshot,
  type PendingRequest,
} from '../src/capital.js';
import { defaultCircleConfig } from '../src/config.js';
import { createFacility } from '../src/facility.js';

const config = defaultCircleConfig();
const ASOF = '2026-06-01';

function loan(overrides: Partial<LoanSnapshot> & Pick<LoanSnapshot, 'loanId' | 'memberId'>): LoanSnapshot {
  return {
    originalPrincipal: 10_000_000,
    principalOutstanding: 10_000_000,
    status: 'disbursed',
    upcoming: [],
    arrears: 0,
    daysPastDue: 0,
    ...overrides,
  };
}

function inputs(overrides: Partial<CapitalInputs> = {}): CapitalInputs {
  return {
    asOf: ASOF,
    equityPool: 150_000_000,
    cashOnHand: 100_000_000,
    facilities: [],
    loans: [],
    collateral: [],
    pending: [],
    ...overrides,
  };
}

describe('what is coming back, and when', () => {
  const book: LoanSnapshot[] = [
    loan({
      loanId: 'l1',
      memberId: 'mem_1',
      upcoming: [
        { dueOn: '2026-06-05', principal: 1_000_000, interest: 250_000, total: 1_250_000 },
        { dueOn: '2026-07-05', principal: 1_000_000, interest: 225_000, total: 1_225_000 },
        { dueOn: '2026-08-05', principal: 8_000_000, interest: 0, total: 8_000_000 },
      ],
    }),
    loan({
      loanId: 'l2',
      memberId: 'mem_2',
      upcoming: [{ dueOn: '2026-06-20', principal: 2_000_000, interest: 500_000, total: 2_500_000 }],
    }),
  ];

  it('counts only what falls due inside each window', () => {
    const [week, month, quarter] = expectedInflows(book, ASOF);

    // Within seven days: just the 5 June instalment.
    assert.equal(week.instalmentCount, 1);
    assert.equal(week.total, 1_250_000);

    // Within thirty days: 5 June and 20 June.
    assert.equal(month.instalmentCount, 2);
    assert.equal(month.total, 1_250_000 + 2_500_000);

    // Within ninety days: everything.
    assert.equal(quarter.instalmentCount, 4);
    assert.equal(quarter.total, 1_250_000 + 1_225_000 + 8_000_000 + 2_500_000);
  });

  it('separates principal from interest, since only one replenishes capital', () => {
    const [, month] = expectedInflows(book, ASOF);
    assert.equal(month.principal, 3_000_000);
    assert.equal(month.interest, 750_000);
    assert.equal(month.total, month.principal + month.interest);
  });

  it('reports the window it covers, so a date can be quoted', () => {
    const [week, month, quarter] = expectedInflows(book, ASOF);
    assert.equal(week.through, '2026-06-08');
    assert.equal(month.through, '2026-07-01');
    assert.equal(quarter.through, '2026-08-30');
  });

  /**
   * A forecast that treats a borrower who missed last month like one who paid
   * promises money that will not arrive.
   */
  it('does not treat money owed by members already behind as dependable', () => {
    const shaky = [
      loan({
        loanId: 'l3',
        memberId: 'mem_3',
        arrears: 1_250_000,
        daysPastDue: 40,
        upcoming: [{ dueOn: '2026-06-05', principal: 1_000_000, interest: 250_000, total: 1_250_000 }],
      }),
      book[0],
    ];

    const [week] = expectedInflows(shaky, ASOF);

    assert.equal(week.total, 2_500_000, 'both instalments are scheduled');
    assert.equal(week.fromBorrowersInArrears, 1_250_000);
    assert.equal(week.dependable, 1_250_000, 'only the reliable half is dependable');
  });

  it('never counts an overdue amount as a future inflow', () => {
    const overdue = [
      loan({
        loanId: 'l4',
        memberId: 'mem_4',
        arrears: 5_000_000,
        daysPastDue: 60,
        // Its instalment fell due in the past.
        upcoming: [{ dueOn: '2026-04-01', principal: 5_000_000, interest: 0, total: 5_000_000 }],
      }),
    ];

    const [, month] = expectedInflows(overdue, ASOF);

    // Money that was due in April is not "expected in the next 30 days".
    assert.equal(month.total, 0);
    assert.equal(month.instalmentCount, 0);
  });
});

describe('where the risk is concentrated', () => {
  it('ranks borrowers by what they owe', () => {
    const risk = concentration(
      [
        loan({ loanId: 'l1', memberId: 'mem_1', principalOutstanding: 6_000_000 }),
        loan({ loanId: 'l2', memberId: 'mem_2', principalOutstanding: 3_000_000 }),
        loan({ loanId: 'l3', memberId: 'mem_1', principalOutstanding: 1_000_000 }),
      ],
      [],
    );

    // mem_1's two loans are added together — concentration is per member.
    assert.equal(risk.largestBorrower?.memberId, 'mem_1');
    assert.equal(risk.largestBorrower?.amount, 7_000_000);
    assert.equal(risk.largestBorrower?.share, 0.7);
  });

  it('ranks sponsors by what they still have locked, not what they promised', () => {
    const commitments: CollateralCommitment[] = [
      { sponsorId: 'mem_5', loanId: 'l1', pledged: 5_000_000, atRisk: 1_000_000 },
      { sponsorId: 'mem_6', loanId: 'l1', pledged: 2_000_000, atRisk: 2_000_000 },
    ];

    const risk = concentration([loan({ loanId: 'l1', memberId: 'mem_1' })], commitments);

    // mem_5 pledged more but has been released; mem_6 carries more today.
    assert.equal(risk.largestSponsor?.memberId, 'mem_6');
    assert.equal(risk.largestSponsor?.amount, 2_000_000);
  });

  it('scores a book held by one borrower as fully concentrated', () => {
    const risk = concentration([loan({ loanId: 'l1', memberId: 'mem_1' })], []);
    assert.equal(risk.borrowerHerfindahl, 1);
    assert.equal(risk.borrowersToHalfTheBook, 1);
  });

  it('scores an evenly spread book near the floor', () => {
    const loans = Array.from({ length: 10 }, (_, index) =>
      loan({ loanId: `l${index}`, memberId: `mem_${index}`, principalOutstanding: 1_000_000 }),
    );

    const risk = concentration(loans, []);

    // Ten equal borrowers: 10 x 0.1^2 = 0.1.
    assert.ok(Math.abs(risk.borrowerHerfindahl - 0.1) < 1e-9);
    assert.equal(risk.borrowersToHalfTheBook, 5);
  });

  it('ignores loans that have been fully repaid', () => {
    const risk = concentration(
      [
        loan({ loanId: 'l1', memberId: 'mem_1', principalOutstanding: 5_000_000 }),
        loan({ loanId: 'l2', memberId: 'mem_2', principalOutstanding: 0, status: 'settled' }),
      ],
      [],
    );

    assert.equal(risk.borrowers.length, 1);
    assert.equal(risk.largestBorrower?.share, 1);
  });
});

describe('what can actually be paid out', () => {
  const request = (overrides: Partial<PendingRequest> & Pick<PendingRequest, 'loanId'>): PendingRequest => ({
    memberId: 'mem_x',
    principal: 5_000_000,
    fullyCovered: true,
    approved: true,
    ...overrides,
  });

  const inflows = expectedInflows(
    [
      loan({
        loanId: 'l1',
        memberId: 'mem_1',
        upcoming: [{ dueOn: '2026-06-20', principal: 4_000_000, interest: 0, total: 4_000_000 }],
      }),
    ],
    ASOF,
  );

  it('funds what the purse covers', () => {
    const plan = fundingPlan([request({ loanId: 'a' })], 10_000_000, inflows, ASOF);
    assert.equal(plan[0].fundableNow, true);
    assert.equal(plan[0].fundableInDays, 0);
  });

  /**
   * The queue is spent down in order. Answering each request independently
   * would tell a committee it can fund three loans it can only fund one of.
   */
  it('spends the purse down the queue rather than answering each in isolation', () => {
    const plan = fundingPlan(
      [request({ loanId: 'a' }), request({ loanId: 'b' }), request({ loanId: 'c' })],
      6_000_000,
      inflows,
      ASOF,
    );

    assert.equal(plan[0].fundableNow, true, 'the first takes 5,000,000 of the 6,000,000');
    assert.equal(plan[1].fundableNow, false, 'only 1,000,000 is left for the second');
    assert.equal(plan[2].fundableNow, false);
  });

  it('says when a request becomes fundable from expected repayments', () => {
    const plan = fundingPlan([request({ loanId: 'a', principal: 4_000_000 })], 1_000_000, inflows, ASOF);

    assert.equal(plan[0].fundableNow, false);
    // 4,000,000 arrives on 20 June, inside the 30-day window.
    assert.equal(plan[0].fundableInDays, 30);
    assert.equal(plan[0].fundableOn, '2026-07-01');
  });

  it('says plainly when repayments will not close the gap', () => {
    const plan = fundingPlan([request({ loanId: 'a', principal: 90_000_000 })], 0, inflows, ASOF);

    assert.equal(plan[0].fundableNow, false);
    assert.equal(plan[0].fundableInDays, null);
    assert.match(plan[0].reason, /do not close the gap/);
  });

  it('does not promise money to a request that is not approved yet', () => {
    const plan = fundingPlan(
      [request({ loanId: 'a', approved: false, fullyCovered: false })],
      100_000_000,
      inflows,
      ASOF,
    );

    assert.equal(plan[0].fundableNow, false);
    assert.match(plan[0].reason, /gathering sponsor cover/);
  });

  it('distinguishes covered-but-unapproved from still-gathering', () => {
    const plan = fundingPlan(
      [request({ loanId: 'a', approved: false, fullyCovered: true })],
      100_000_000,
      inflows,
      ASOF,
    );

    assert.match(plan[0].reason, /not been approved yet/);
  });
});

/**
 * The distinction the engine exists to keep straight: capital a policy allows
 * to be lent is not the same as money in the account.
 */
describe('available capital versus money in the account', () => {
  it('can only spend what is actually there', () => {
    const position = capitalPosition(
      config,
      inputs({ equityPool: 150_000_000, cashOnHand: 20_000_000, loans: [] }),
    );

    assert.equal(position.capital.available, 150_000_000, 'policy allows the whole capital base');
    assert.equal(position.capital.cashOnHand, 20_000_000);
    assert.equal(position.capital.spendableNow, 20_000_000, 'but only the cash can go out');
  });

  it('warns when the two diverge, and says why', () => {
    const position = capitalPosition(config, inputs({ cashOnHand: 20_000_000 }));
    const alert = position.alerts.find((entry) => entry.code === 'capital_not_in_cash');

    assert.ok(alert);
    assert.match(alert.message, /held as fees awaiting decisions, member savings/);
  });

  it('does not warn when the cash is there', () => {
    const position = capitalPosition(config, inputs({ equityPool: 50_000_000, cashOnHand: 80_000_000 }));
    assert.ok(!position.alerts.some((entry) => entry.code === 'capital_not_in_cash'));
  });

  it('raises a danger when the circle has promised more than it can release', () => {
    const position = capitalPosition(
      config,
      inputs({
        cashOnHand: 3_000_000,
        pending: [
          { loanId: 'a', memberId: 'mem_1', principal: 10_000_000, fullyCovered: true, approved: true },
        ],
      }),
    );

    const alert = position.alerts.find((entry) => entry.code === 'cannot_meet_commitments');
    assert.ok(alert);
    assert.equal(alert.level, 'danger');
    assert.match(alert.message, /promised money it cannot currently release/);
  });
});

describe('the whole position', () => {
  const facility = createFacility(config, {
    id: 'fac_1',
    investorMemberId: 'mem_30',
    principal: 200_000_000,
    fundedOn: '2026-01-01',
  });

  const position = capitalPosition(
    config,
    inputs({
      cashOnHand: 260_000_000,
      facilities: [facility],
      loans: [
        loan({
          loanId: 'l1',
          memberId: 'mem_1',
          originalPrincipal: 50_000_000,
          principalOutstanding: 40_000_000,
          upcoming: [
            { dueOn: '2026-06-15', principal: 5_000_000, interest: 1_125_000, total: 6_125_000 },
            { dueOn: '2026-07-15', principal: 35_000_000, interest: 0, total: 35_000_000 },
          ],
        }),
        loan({
          loanId: 'l2',
          memberId: 'mem_2',
          originalPrincipal: 50_000_000,
          principalOutstanding: 50_000_000,
          arrears: 6_125_000,
          daysPastDue: 45,
          upcoming: [{ dueOn: '2026-06-10', principal: 5_000_000, interest: 1_250_000, total: 6_250_000 }],
        }),
      ],
      collateral: [
        { sponsorId: 'mem_5', loanId: 'l1', pledged: 5_000_000, atRisk: 4_000_000 },
        { sponsorId: 'mem_6', loanId: 'l2', pledged: 5_000_000, atRisk: 5_000_000 },
      ],
    }),
  );

  it('adds equity and the facility into one capital base', () => {
    assert.equal(position.capital.totalCapital, 350_000_000);
    assert.equal(position.capital.deployed, 90_000_000);
    assert.equal(position.capital.available, 260_000_000);
  });

  it('reports collateral locked and released together', () => {
    assert.equal(position.collateral.totalPledged, 10_000_000);
    assert.equal(position.collateral.totalAtRisk, 9_000_000);
    assert.equal(position.collateral.releasedToDate, 1_000_000);
  });

  it('measures arrears against the book', () => {
    assert.equal(position.arrears.total, 6_125_000);
    assert.equal(position.arrears.loanCount, 1);
    assert.equal(position.arrears.worstDaysPastDue, 45);
    assert.ok(Math.abs(position.arrears.portfolioAtRisk - 6_125_000 / 90_000_000) < 1e-9);
  });

  it('discounts the inflow from the borrower who is behind', () => {
    const [, month] = position.inflows;

    assert.equal(month.total, 6_125_000 + 6_250_000);
    assert.equal(month.fromBorrowersInArrears, 6_250_000);
    assert.equal(month.dependable, 6_125_000);
  });

  it('projects the cash position forward without assuming new lending', () => {
    const projection = projectCash(position, 30);

    assert.equal(projection.on, '2026-07-01');
    assert.equal(projection.opening, 260_000_000);
    assert.equal(projection.inflow, 6_125_000);
    assert.equal(projection.closing, 266_125_000);
  });

  it('answers how long until a given amount could be lent', () => {
    assert.equal(daysUntilFundable(position, 100_000_000), 0, 'already covered by cash');
    assert.equal(daysUntilFundable(position, 900_000_000), null, 'never, on current expectations');
  });

  it('gives the committee a headline they can read out', () => {
    assert.match(position.headline, /can be lent today/);
  });
});
