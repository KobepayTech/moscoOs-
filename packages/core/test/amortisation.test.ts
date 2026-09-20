import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRepayments,
  buildShortTermLoan,
  buildTermLoanSchedule,
  LoanError,
  settlementQuote,
  shortTermLoanState,
} from '../src/amortisation.js';

/**
 * The founding worked example, exactly as the members set it out:
 * take 50,000,000 over three months, return 10% of it each month, and the
 * final payment is the flat 35,000,000 that is left with no interest on it.
 */
describe('the 50,000,000 three-month loan', () => {
  const schedule = buildTermLoanSchedule({
    principal: 50_000_000,
    monthlyInterestRate: 0.025,
    termMonths: 3,
    minimumMonthlyPrincipalRate: 0.1,
    disbursedOn: '2026-01-15',
  });

  it('returns 10% of the original principal every month', () => {
    const service = schedule.rows.filter((row) => row.kind === 'service');
    assert.equal(service.length, 3);
    for (const row of service) {
      assert.equal(row.principalDue, 5_000_000);
    }
  });

  it('charges interest on the declining scheduled balance, not flat on the original', () => {
    // 50m -> 1,250,000, then 45m -> 1,125,000, then 40m -> 1,000,000.
    assert.equal(schedule.scheduledInterest, 3_375_000);

    // Flat interest would have been 50m * 2.5% * 3 = 3,750,000. The declining
    // balance saves the borrower 375,000 for following the schedule.
    assert.ok(schedule.scheduledInterest < 50_000_000 * 0.025 * 3);
  });

  it('levels the instalment so the member has one number to remember', () => {
    // 5,000,000 of principal + 3,375,000/3 of interest.
    assert.equal(schedule.levelServiceInstalment, 6_125_000);
    const service = schedule.rows.filter((row) => row.kind === 'service');
    for (const row of service) {
      assert.equal(row.totalDue, 6_125_000);
      assert.equal(row.interestDue, 1_125_000);
    }
  });

  it('leaves a flat 35,000,000 balloon carrying no interest', () => {
    assert.equal(schedule.balloon, 35_000_000);

    const balloon = schedule.rows.find((row) => row.kind === 'balloon');
    assert.ok(balloon, 'expected a balloon row');
    assert.equal(balloon.principalDue, 35_000_000);
    assert.equal(balloon.interestDue, 0, 'the final payment must be flat');
    assert.equal(balloon.totalDue, 35_000_000);
    assert.equal(balloon.closingPrincipal, 0);
  });

  it('collects every shilling of interest before the balloon falls due', () => {
    const service = schedule.rows.filter((row) => row.kind === 'service');
    const interestInService = service.reduce((total, row) => total + row.interestDue, 0);
    assert.equal(interestInService, schedule.scheduledInterest);
  });

  it('reconciles: 15,000,000 through instalments leaves 35,000,000 outstanding', () => {
    const service = schedule.rows.filter((row) => row.kind === 'service');
    const principalThroughInstalments = service.reduce((total, row) => total + row.principalDue, 0);
    assert.equal(principalThroughInstalments, 15_000_000);
    assert.equal(50_000_000 - principalThroughInstalments, schedule.balloon);
  });

  it('totals 53,375,000 repayable', () => {
    assert.equal(schedule.totalRepayable, 53_375_000);
    assert.equal(schedule.totalRepayable, 50_000_000 + 3_375_000);
  });

  it('runs its due dates off the disbursement date, maturing at month three', () => {
    assert.deepEqual(
      schedule.rows.map((row) => row.dueOn),
      ['2026-02-15', '2026-03-15', '2026-04-15', '2026-04-15'],
    );
    assert.equal(schedule.maturityOn, '2026-04-15');
  });
});

describe('schedule invariants', () => {
  it('always reconciles principal + interest to the total repayable', () => {
    const cases = [
      { principal: 1_000_000, rate: 0.025, months: 3, step: 0.1 },
      { principal: 7_333_333, rate: 0.0225, months: 6, step: 0.1 },
      { principal: 250_000, rate: 0.03, months: 12, step: 0.05 },
      { principal: 99_999_999, rate: 0.025, months: 4, step: 0.17 },
      { principal: 12_345_678, rate: 0.0333, months: 5, step: 0.13 },
    ];

    for (const testCase of cases) {
      const schedule = buildTermLoanSchedule({
        principal: testCase.principal,
        monthlyInterestRate: testCase.rate,
        termMonths: testCase.months,
        minimumMonthlyPrincipalRate: testCase.step,
        disbursedOn: '2026-01-31',
      });

      const totalPrincipal = schedule.rows.reduce((total, row) => total + row.principalDue, 0);
      const totalInterest = schedule.rows.reduce((total, row) => total + row.interestDue, 0);

      assert.equal(totalPrincipal, testCase.principal, `principal for ${JSON.stringify(testCase)}`);
      assert.equal(totalInterest, schedule.scheduledInterest, `interest for ${JSON.stringify(testCase)}`);
      assert.equal(schedule.totalRepayable, testCase.principal + schedule.scheduledInterest);

      // No balloon may ever carry interest.
      for (const row of schedule.rows.filter((r) => r.kind === 'balloon')) {
        assert.equal(row.interestDue, 0);
      }
    }
  });

  it('fully amortises with no balloon when the monthly step reaches 100%', () => {
    const schedule = buildTermLoanSchedule({
      principal: 10_000_000,
      monthlyInterestRate: 0.025,
      termMonths: 10,
      minimumMonthlyPrincipalRate: 0.1,
      disbursedOn: '2026-01-01',
    });

    assert.equal(schedule.balloon, 0);
    assert.ok(!schedule.rows.some((row) => row.kind === 'balloon'));
    assert.equal(schedule.rows.length, 10);
  });

  it('never schedules more principal than was lent, even on a short over-stepped term', () => {
    // 60% a month over three months would repay 180% of principal if unchecked.
    const schedule = buildTermLoanSchedule({
      principal: 10_000_000,
      monthlyInterestRate: 0.025,
      termMonths: 3,
      minimumMonthlyPrincipalRate: 0.6,
      disbursedOn: '2026-01-01',
    });

    const totalPrincipal = schedule.rows.reduce((total, row) => total + row.principalDue, 0);
    assert.equal(totalPrincipal, 10_000_000);
    assert.equal(schedule.balloon, 0);
    assert.equal(schedule.rows[2].principalDue, 0, 'the third month has nothing left to repay');
  });

  it('clamps month-end due dates instead of drifting into the next month', () => {
    const schedule = buildTermLoanSchedule({
      principal: 3_000_000,
      monthlyInterestRate: 0.025,
      termMonths: 3,
      minimumMonthlyPrincipalRate: 0.1,
      disbursedOn: '2026-01-31',
    });

    assert.equal(schedule.rows[0].dueOn, '2026-02-28');
    assert.equal(schedule.rows[1].dueOn, '2026-03-31');
  });

  it('can push the balloon past the last instalment with a grace period', () => {
    const schedule = buildTermLoanSchedule({
      principal: 50_000_000,
      monthlyInterestRate: 0.025,
      termMonths: 3,
      minimumMonthlyPrincipalRate: 0.1,
      disbursedOn: '2026-01-15',
      balloonGraceDays: 14,
    });

    assert.equal(schedule.maturityOn, '2026-04-29');
    assert.equal(schedule.rows.at(-1)?.dueOn, '2026-04-29');
  });

  it('rejects terms that make no sense', () => {
    const base = {
      principal: 1_000_000,
      monthlyInterestRate: 0.025,
      termMonths: 3,
      minimumMonthlyPrincipalRate: 0.1,
      disbursedOn: '2026-01-01',
    };

    assert.throws(() => buildTermLoanSchedule({ ...base, principal: 0 }), LoanError);
    assert.throws(() => buildTermLoanSchedule({ ...base, termMonths: 0 }), LoanError);
    assert.throws(() => buildTermLoanSchedule({ ...base, monthlyInterestRate: -0.01 }), LoanError);
    assert.throws(() => buildTermLoanSchedule({ ...base, minimumMonthlyPrincipalRate: 0 }), LoanError);
    assert.throws(() => buildTermLoanSchedule({ ...base, minimumMonthlyPrincipalRate: 1.5 }), LoanError);
  });
});

describe('servicing a term loan', () => {
  const schedule = buildTermLoanSchedule({
    principal: 50_000_000,
    monthlyInterestRate: 0.025,
    termMonths: 3,
    minimumMonthlyPrincipalRate: 0.1,
    disbursedOn: '2026-01-15',
  });

  it('reports a loan nobody has paid yet as pending', () => {
    const state = applyRepayments(schedule, [], { asOf: '2026-01-20' });
    assert.equal(state.status, 'pending');
    assert.equal(state.principalOutstanding, 50_000_000);
    assert.equal(state.arrears, 0);
  });

  it('applies a payment to interest before principal', () => {
    const state = applyRepayments(schedule, [{ paidOn: '2026-02-15', amount: 6_125_000 }], {
      asOf: '2026-02-15',
    });

    assert.equal(state.interestPaid, 1_125_000);
    assert.equal(state.principalPaid, 5_000_000);
    assert.equal(state.principalOutstanding, 45_000_000);
    assert.equal(state.arrears, 0);
    assert.equal(state.status, 'current');
  });

  it('flags arrears once an instalment is missed', () => {
    const state = applyRepayments(schedule, [], { asOf: '2026-02-20' });

    assert.equal(state.status, 'in_arrears');
    assert.equal(state.arrears, 6_125_000);
    assert.equal(state.daysPastDue, 5);
  });

  it('charges a penalty on what is overdue, from the date it fell due', () => {
    const state = applyRepayments(schedule, [], {
      asOf: '2026-03-17',
      penaltyMonthlyRate: 0.01,
    });

    // Two instalments overdue by then: one by 30 days, one by 2.
    assert.ok(state.penaltyAccrued > 0);
    assert.equal(state.arrears, 12_250_000);

    const expected = Math.round(
      6_125_000 * ((0.01 * 12) / 365) * 30 + 6_125_000 * ((0.01 * 12) / 365) * 2,
    );
    assert.equal(state.penaltyAccrued, expected);
  });

  it('settles the loan when everything including the balloon is paid', () => {
    const state = applyRepayments(
      schedule,
      [
        { paidOn: '2026-02-15', amount: 6_125_000 },
        { paidOn: '2026-03-15', amount: 6_125_000 },
        { paidOn: '2026-04-15', amount: 6_125_000 },
        { paidOn: '2026-04-15', amount: 35_000_000 },
      ],
      { asOf: '2026-04-16' },
    );

    assert.equal(state.status, 'settled');
    assert.equal(state.principalOutstanding, 0);
    assert.equal(state.interestOutstanding, 0);
    assert.equal(state.totalPaid, 53_375_000);
  });

  it('holds an overpayment as credit against the next instalment', () => {
    const state = applyRepayments(schedule, [{ paidOn: '2026-02-15', amount: 10_000_000 }], {
      asOf: '2026-02-16',
    });

    // Covers instalment one (6,125,000) and eats into instalment two.
    assert.equal(state.creditBalance, 0);
    assert.equal(state.principalPaid + state.interestPaid, 10_000_000);
    assert.equal(state.arrears, 0);
  });

  it('calls a loan defaulted once it is far enough past due', () => {
    const state = applyRepayments(schedule, [], {
      asOf: '2026-06-01',
      defaultAfterDays: 90,
    });

    assert.equal(state.status, 'defaulted');
    assert.ok(state.daysPastDue >= 90);
  });
});

describe('settling early', () => {
  const schedule = buildTermLoanSchedule({
    principal: 50_000_000,
    monthlyInterestRate: 0.025,
    termMonths: 3,
    minimumMonthlyPrincipalRate: 0.1,
    disbursedOn: '2026-01-15',
  });

  it('rebates interest the borrower paid for months they never used', () => {
    // Pays instalment one on time, then clears the loan a fortnight later.
    const repayments = [{ paidOn: '2026-02-15', amount: 6_125_000 }];
    const quote = settlementQuote(schedule, repayments, { asOf: '2026-03-01' });

    // Thirty-one days on 50m plus fourteen on 45m, at 2.5% a month.
    const dailyRate = (0.025 * 12) / 365;
    const expectedEarned = Math.round(50_000_000 * dailyRate * 31 + 45_000_000 * dailyRate * 14);

    assert.equal(quote.interestEarned, expectedEarned);
    assert.equal(quote.interestPaid, 1_125_000);
    assert.equal(quote.principalOutstanding, 45_000_000);

    // The borrower gets back what they paid for and did not use.
    assert.ok(quote.interestRebate >= 0);
    assert.ok(quote.payoffAmount < schedule.totalRepayable - 6_125_000);
    assert.ok(quote.savingVersusSchedule > 0, 'settling early must cost less than running to maturity');
  });

  it('never charges more interest than the schedule promised', () => {
    const quote = settlementQuote(schedule, [], { asOf: '2027-01-01' });
    assert.ok(quote.interestEarned <= schedule.scheduledInterest);
  });

  it('can be turned off, in which case the schedule stands', () => {
    const repayments = [{ paidOn: '2026-02-15', amount: 6_125_000 }];
    const withRebate = settlementQuote(schedule, repayments, { asOf: '2026-02-20' });
    const without = settlementQuote(schedule, repayments, {
      asOf: '2026-02-20',
      rebateUnearnedInterest: false,
    });

    assert.ok(without.payoffAmount >= withRebate.payoffAmount);
    assert.equal(without.interestRebate, 0);
  });
});

describe('short-term loans', () => {
  it('charges the flat 5% the members agreed, whatever the duration', () => {
    const loan = buildShortTermLoan({
      principal: 5_000_000,
      flatRate: 0.05,
      days: 5,
      disbursedOn: '2026-02-01',
    });

    assert.equal(loan.fee, 250_000);
    assert.equal(loan.totalRepayable, 5_250_000);
    assert.equal(loan.dueOn, '2026-02-06');
  });

  it('exposes what the flat fee really costs on an annual basis', () => {
    const loan = buildShortTermLoan({
      principal: 5_000_000,
      flatRate: 0.05,
      days: 5,
      disbursedOn: '2026-02-01',
    });

    // 5% over five days is 365% a year. The member pays 250,000; the committee
    // should still see this number when it prices the product.
    assert.ok(Math.abs(loan.annualisedRate - 3.65) < 0.001);
  });

  it('can instead pro-rate the fee, which makes short loans genuinely cheap', () => {
    const loan = buildShortTermLoan({
      principal: 5_000_000,
      flatRate: 0.05,
      days: 5,
      disbursedOn: '2026-02-01',
      mode: 'prorated',
      proRataBasisDays: 30,
    });

    // A sixth of the thirty-day charge.
    assert.equal(loan.fee, 41_667);
    assert.ok(Math.abs(loan.annualisedRate - 0.6083) < 0.001);
  });

  it('respects a minimum fee when pro-rating', () => {
    const loan = buildShortTermLoan({
      principal: 5_000_000,
      flatRate: 0.05,
      days: 1,
      disbursedOn: '2026-02-01',
      mode: 'prorated',
      minimumFee: 20_000,
    });

    assert.equal(loan.fee, 20_000);
  });

  it('accrues a daily penalty once it is overdue', () => {
    const loan = buildShortTermLoan({
      principal: 5_000_000,
      flatRate: 0.05,
      days: 5,
      disbursedOn: '2026-02-01',
    });

    const state = shortTermLoanState(loan, [], { asOf: '2026-02-11', dailyPenaltyRate: 0.005 });

    assert.equal(state.status, 'overdue');
    assert.equal(state.daysPastDue, 5);
    assert.equal(state.outstanding, 5_250_000);
    assert.equal(state.penalty, Math.round(5_250_000 * 0.005 * 5));
  });

  it('settles on full repayment', () => {
    const loan = buildShortTermLoan({
      principal: 5_000_000,
      flatRate: 0.05,
      days: 5,
      disbursedOn: '2026-02-01',
    });

    const state = shortTermLoanState(loan, [{ paidOn: '2026-02-05', amount: 5_250_000 }], {
      asOf: '2026-02-06',
    });

    assert.equal(state.status, 'settled');
    assert.equal(state.payoffAmount, 0);
  });
});
