import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type CollectedPayment,
  type SettlementLine,
  SettlementError,
  cashInTransit,
  reconcileSettlement,
  settledBetween,
} from '../src/settlement.js';

const TODAY = '2026-09-22';

/** The application fee, net of the rail's 5%: what the circle should receive. */
function fee(overrides: Partial<CollectedPayment> = {}): CollectedPayment {
  return {
    intentId: 'pay_1',
    reference: 'pay_1',
    expectedNet: 47_500,
    confirmedOn: '2026-09-20',
    purpose: 'loan_application_fee',
    memberId: 'mem_07',
    ...overrides,
  };
}

function credit(overrides: Partial<SettlementLine> = {}): SettlementLine {
  return { id: 'stmt_1', amount: 47_500, settledOn: '2026-09-21', reference: 'pay_1', ...overrides };
}

const money = (amount: number) => `TSh ${amount.toLocaleString('en-US')}`;

describe('matching what was collected against what arrived', () => {
  it('matches on the reference we sent', () => {
    const report = reconcileSettlement([fee()], [credit()], { asOf: TODAY, formatAmount: money });

    assert.equal(report.matched.length, 1);
    assert.equal(report.matched[0].basis, 'reference');
    assert.equal(report.matched[0].variance, 0);
    assert.equal(report.matched[0].daysToSettle, 1);
    assert.deepEqual(report.exceptions, []);
    assert.equal(report.clean, true);
  });

  it('falls back to the rail receipt when the statement drops the reference', () => {
    const report = reconcileSettlement(
      [fee({ railReceipt: 'MPESA-XYZ-1' })],
      [credit({ reference: undefined, railReceipt: 'MPESA-XYZ-1' })],
      { asOf: TODAY, formatAmount: money },
    );

    assert.equal(report.matched[0].basis, 'receipt');
  });

  it('will read a narrative, and says that is what it did', () => {
    const report = reconcileSettlement(
      [fee()],
      [credit({ reference: undefined, narrative: 'MOBILE DEPOSIT REF pay_1 THANK YOU' })],
      { asOf: TODAY, formatAmount: money },
    );

    // A narrative match is a guess. The basis travels with the match so a
    // treasurer can see why two lines were paired before accepting it.
    assert.equal(report.matched[0].basis, 'narrative');
  });

  it('never lets one credit settle two collections', () => {
    const report = reconcileSettlement(
      [fee({ intentId: 'pay_1', reference: 'pay_1' }), fee({ intentId: 'pay_2', reference: 'pay_1' })],
      [credit()],
      { asOf: TODAY, formatAmount: money },
    );

    assert.equal(report.matched.length, 1);
    assert.equal(report.exceptions.length, 1, 'the second is still waiting');
  });

  it('gives a contested credit to whichever collection has waited longest', () => {
    const report = reconcileSettlement(
      [
        fee({ intentId: 'pay_new', reference: 'ref', confirmedOn: '2026-09-21' }),
        fee({ intentId: 'pay_old', reference: 'ref', confirmedOn: '2026-09-10' }),
      ],
      [credit({ reference: 'ref' })],
      { asOf: TODAY, formatAmount: money },
    );

    assert.equal(report.matched[0].payment.intentId, 'pay_old');
  });
});

describe('money that has not arrived', () => {
  it('treats a recent collection as in transit, not a problem', () => {
    const report = reconcileSettlement([fee({ confirmedOn: '2026-09-21' })], [], {
      asOf: TODAY,
      formatAmount: money,
    });

    assert.equal(report.exceptions[0].kind, 'awaiting_settlement');
    assert.equal(report.clean, true, 'in transit is the system working, not a fault');
    assert.match(report.headline, /1 in transit/);
    assert.match(report.headline, /nothing needs attention/);
  });

  it('escalates once it has waited too long', () => {
    const report = reconcileSettlement([fee({ confirmedOn: '2026-09-11' })], [], {
      asOf: TODAY,
      toleratedDelayDays: 3,
      formatAmount: money,
    });

    assert.equal(report.exceptions[0].kind, 'overdue_settlement');
    assert.equal(report.exceptions[0].ageDays, 11);
    assert.match(report.exceptions[0].summary, /has not settled \(11 days\)/);
    assert.match(report.exceptions[0].summary, /Ask the operator/);
    assert.equal(report.clean, false);
  });

  it('counts what the books claim but the account has not received', () => {
    const waiting = [
      fee({ intentId: 'pay_1', reference: 'pay_1' }),
      fee({ intentId: 'pay_2', reference: 'pay_2' }),
    ];

    assert.equal(cashInTransit(waiting, [], TODAY), 95_000);
    assert.equal(
      cashInTransit(waiting, [credit({ reference: 'pay_1' })], TODAY),
      47_500,
      'once one settles only the other is outstanding',
    );
  });
});

describe('amounts that disagree', () => {
  it('reports a short settlement with the shortfall named', () => {
    const report = reconcileSettlement([fee()], [credit({ amount: 45_000 })], {
      asOf: TODAY,
      formatAmount: money,
    });

    const problem = report.exceptions[0];
    assert.equal(problem.kind, 'short_settlement');
    assert.equal(problem.amount, 2_500);
    assert.match(problem.summary, /TSh 47,500 expected, TSh 45,000 received — short by TSh 2,500/);
    assert.equal(report.totals.variance, -2_500);
  });

  it('reports an over-settlement too, rather than quietly banking it', () => {
    const report = reconcileSettlement([fee()], [credit({ amount: 50_000 })], {
      asOf: TODAY,
      formatAmount: money,
    });

    assert.equal(report.exceptions[0].kind, 'over_settlement');
    assert.equal(report.totals.variance, 2_500);
  });

  it('holds the line at exact shillings by default', () => {
    const report = reconcileSettlement([fee()], [credit({ amount: 47_499 })], {
      asOf: TODAY,
      formatAmount: money,
    });

    // The whole system is integer shillings so that "close enough" never
    // enters the books.
    assert.equal(report.exceptions.length, 1);
  });

  it('can be told to tolerate a rounding rail, and then says nothing', () => {
    const report = reconcileSettlement([fee()], [credit({ amount: 47_499 })], {
      asOf: TODAY,
      toleranceShillings: 1,
      formatAmount: money,
    });

    assert.deepEqual(report.exceptions, []);
  });
});

describe('money nobody expected', () => {
  it('flags a credit no collection explains', () => {
    const report = reconcileSettlement([], [credit({ amount: 100_000, narrative: 'CASH DEPOSIT' })], {
      asOf: TODAY,
      formatAmount: money,
    });

    const problem = report.exceptions[0];
    assert.equal(problem.kind, 'unexpected_credit');
    assert.match(problem.summary, /TSh 100,000 arrived on 2026-09-21 against no collection \(CASH DEPOSIT\)/);
    assert.match(problem.summary, /before spending it/);
    assert.equal(report.clean, false);
  });
});

describe('what a treasurer reads', () => {
  it('leads with the count, not the tables', () => {
    const collected = Array.from({ length: 247 }, (_, index) =>
      fee({ intentId: `pay_${index}`, reference: `pay_${index}` }),
    );
    const lines = collected.map((payment, index) => credit({ id: `stmt_${index}`, reference: payment.reference }));

    // Three problems: one short, one never arrived, one unexplained.
    lines[0].amount = 45_000;
    lines.pop();
    lines.push(credit({ id: 'stmt_odd', amount: 100_000, reference: undefined, narrative: 'UNKNOWN' }));

    const report = reconcileSettlement(collected, lines, {
      asOf: TODAY,
      toleratedDelayDays: 1,
      formatAmount: money,
    });

    assert.match(report.headline, /^246 settlements matched/);
    assert.match(report.headline, /3 need attention/);
    assert.equal(report.exceptions.length, 3);
    assert.deepEqual(
      report.exceptions.map((problem) => problem.kind).sort(),
      ['overdue_settlement', 'short_settlement', 'unexpected_credit'],
    );
  });

  it('says so plainly when there is nothing to do', () => {
    const report = reconcileSettlement([fee()], [credit()], { asOf: TODAY, formatAmount: money });
    assert.equal(report.headline, '1 settlement matched, nothing needs attention.');
  });

  it('reports nothing at all as clean rather than as an error', () => {
    const report = reconcileSettlement([], [], { asOf: TODAY, formatAmount: money });

    assert.equal(report.clean, true);
    assert.equal(report.totals.received, 0);
    assert.match(report.headline, /0 settlements matched/);
  });
});

describe('guarding the inputs', () => {
  it('refuses a credit that is not a credit', () => {
    assert.throws(
      () => reconcileSettlement([], [credit({ amount: -500 })], { asOf: TODAY }),
      SettlementError,
    );
  });

  it('refuses a malformed date', () => {
    assert.throws(() => reconcileSettlement([], [], { asOf: 'last Tuesday' }), /asOf/);
  });
});

describe('period reporting', () => {
  it('picks out what settled inside a window', () => {
    const report = reconcileSettlement(
      [
        fee({ intentId: 'pay_1', reference: 'pay_1', confirmedOn: '2026-08-01' }),
        fee({ intentId: 'pay_2', reference: 'pay_2', confirmedOn: '2026-09-01' }),
      ],
      [
        credit({ id: 'a', reference: 'pay_1', settledOn: '2026-08-03' }),
        credit({ id: 'b', reference: 'pay_2', settledOn: '2026-09-03' }),
      ],
      { asOf: TODAY, formatAmount: money },
    );

    const september = settledBetween(report, '2026-09-01', '2026-09-30');
    assert.equal(september.length, 1);
    assert.equal(september[0].payment.intentId, 'pay_2');
  });
});
