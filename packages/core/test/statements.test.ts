import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type Book,
  applicationFeeEarnedEntry,
  applicationFeeHeldEntry,
  createBook,
  disbursementEntry,
  facilityDrawdownEntry,
  facilityPaymentEntry,
  operatingExpenseEntry,
  postEntry,
  repaymentEntry,
  reverseEntry,
  savingsContributionEntry,
  shareSubscriptionEntry,
  cashPosition,
} from '../src/ledger.js';
import { cashFlowStatement, memberStatement, StatementError } from '../src/statements.js';

/**
 * The circle's own worked example, posted to a book.
 *
 * Elia takes TSh 50,000,000 over three months at 2.5%: three instalments of
 * 6,125,000 and then a flat 35,000,000. Everything in this file is asserted
 * against those numbers rather than against whatever the code produces.
 */
function workedExample(): Book {
  const book = createBook();

  postEntry(
    book,
    shareSubscriptionEntry({ id: 'je_01', date: '2026-01-05' }, { memberId: 'mem_elia', amount: 5_000_000 }),
  );
  postEntry(
    book,
    facilityDrawdownEntry(
      { id: 'je_02', date: '2026-01-10' },
      { facilityId: 'fac_1', investorMemberId: 'mem_juma', amount: 200_000_000 },
    ),
  );
  postEntry(
    book,
    applicationFeeHeldEntry(
      { id: 'je_03', date: '2026-01-14' },
      { memberId: 'mem_elia', loanId: 'loan_1', net: 47_500 },
    ),
  );
  postEntry(
    book,
    applicationFeeEarnedEntry(
      { id: 'je_04', date: '2026-01-15' },
      { memberId: 'mem_elia', loanId: 'loan_1', net: 47_500 },
    ),
  );
  postEntry(
    book,
    disbursementEntry(
      { id: 'je_05', date: '2026-01-15' },
      { loanId: 'loan_1', memberId: 'mem_elia', principal: 50_000_000 },
    ),
  );

  // Three instalments: 5,000,000 of principal and 1,125,000 of interest each.
  for (const [index, date] of ['2026-02-15', '2026-03-15', '2026-04-15'].entries()) {
    postEntry(
      book,
      repaymentEntry(
        { id: `je_1${index}`, date },
        { loanId: 'loan_1', memberId: 'mem_elia', principal: 5_000_000, interest: 1_125_000 },
      ),
    );
  }

  // The balloon: flat, no interest on it.
  postEntry(
    book,
    repaymentEntry(
      { id: 'je_20', date: '2026-04-15' },
      { loanId: 'loan_1', memberId: 'mem_elia', principal: 35_000_000, interest: 0 },
    ),
  );

  return book;
}

describe('cash flow — the worked example', () => {
  it('reconciles to the ledger’s own cash balance', () => {
    const book = workedExample();
    const statement = cashFlowStatement(book);

    assert.equal(statement.reconciles, true);
    assert.equal(statement.closingCash, cashPosition(book));
    assert.equal(statement.openingCash, 0);
    assert.equal(statement.netMovement, statement.closingCash);
  });

  it('shows the loan going out and all of it coming back', () => {
    const lending = section(cashFlowStatement(workedExample()), 'lending');

    assert.equal(lending.outflow, 50_000_000, 'the disbursement');
    assert.equal(lending.inflow, 50_000_000, '15,000,000 in instalments and the 35,000,000 balloon');
    assert.equal(lending.net, 0, 'a fully repaid loan is cash-neutral on principal');
  });

  it('keeps interest out of lending and in earnings', () => {
    const statement = cashFlowStatement(workedExample());

    // 3 × 1,125,000. Declining balance, so 3,375,000 — not 3,750,000 flat.
    assert.equal(section(statement, 'earnings').net, 3_375_000 + 47_500);
    assert.equal(
      line(statement, 'earnings', 'INTEREST_INCOME').inflow,
      3_375_000,
      'every shilling of interest arrived as cash',
    );
    assert.equal(
      section(statement, 'lending').lines.some((row) => row.account === 'INTEREST_INCOME'),
      false,
    );
  });

  it('separates the interest and principal inside a single repayment', () => {
    const statement = cashFlowStatement(workedExample(), { from: '2026-02-15', to: '2026-02-15' });

    // One entry of 6,125,000 arrived, and the statement splits it.
    assert.equal(statement.movements, 1);
    assert.equal(statement.totalInflow, 6_125_000);
    assert.equal(line(statement, 'lending', 'LOANS_RECEIVABLE').inflow, 5_000_000);
    assert.equal(line(statement, 'earnings', 'INTEREST_INCOME').inflow, 1_125_000);
  });

  it('puts the facility and the share subscription in capital', () => {
    const capital = section(cashFlowStatement(workedExample()), 'capital');

    assert.equal(capital.inflow, 205_000_000);
    assert.equal(capital.outflow, 0);
    assert.equal(line(cashFlowStatement(workedExample()), 'capital', 'FACILITY_PRINCIPAL').net, 200_000_000);
  });

  it('holds an application fee in earnings at its net, never its gross', () => {
    const statement = cashFlowStatement(workedExample(), { from: '2026-01-14', to: '2026-01-14' });

    assert.equal(statement.totalInflow, 47_500, 'the 50,000 gross never reached the circle');
  });
});

describe('cash flow — windows', () => {
  it('opens at the balance carried in, not at zero', () => {
    const book = workedExample();

    const whole = cashFlowStatement(book);
    const after = cashFlowStatement(book, { from: '2026-02-01' });
    const before = cashFlowStatement(book, { to: '2026-01-31' });

    assert.equal(before.openingCash, 0);
    assert.equal(after.openingCash, before.closingCash, 'one window opens where the last one closed');
    assert.equal(after.closingCash, whole.closingCash);
    assert.equal(after.reconciles, true);
    assert.equal(before.reconciles, true);
  });

  it('adds up across consecutive windows', () => {
    const book = workedExample();
    const windows = [
      cashFlowStatement(book, { to: '2026-01-31' }),
      cashFlowStatement(book, { from: '2026-02-01', to: '2026-03-31' }),
      cashFlowStatement(book, { from: '2026-04-01' }),
    ];

    const moved = windows.reduce((total, statement) => total + statement.netMovement, 0);
    assert.equal(moved, cashFlowStatement(book).netMovement);
    assert.ok(windows.every((statement) => statement.reconciles));
  });

  it('counts nothing in an empty window', () => {
    const statement = cashFlowStatement(workedExample(), { from: '2026-06-01', to: '2026-06-30' });

    assert.equal(statement.movements, 0);
    assert.equal(statement.totalInflow, 0);
    assert.equal(statement.totalOutflow, 0);
    assert.equal(statement.netMovement, 0);
    assert.equal(statement.openingCash, statement.closingCash);
    assert.equal(statement.reconciles, true);
  });

  it('refuses a window that ends before it begins', () => {
    assert.throws(
      () => cashFlowStatement(workedExample(), { from: '2026-04-01', to: '2026-01-01' }),
      StatementError,
    );
  });
});

describe('cash flow — corrections and costs', () => {
  it('shows a reversal as a movement the other way, and still reconciles', () => {
    const book = workedExample();
    reverseEntry(book, 'je_10', { id: 'je_90', date: '2026-05-01', reason: 'Receipt was entered twice' });

    const statement = cashFlowStatement(book);
    assert.equal(statement.reconciles, true);

    const may = cashFlowStatement(book, { from: '2026-05-01' });
    assert.equal(may.totalOutflow, 6_125_000, 'the money went back out');
    assert.equal(section(may, 'lending').net, -5_000_000);
    assert.equal(section(may, 'earnings').net, -1_125_000);
  });

  it('books running costs and the investor’s return against earnings', () => {
    const book = workedExample();
    postEntry(
      book,
      operatingExpenseEntry({ id: 'je_30', date: '2026-04-30' }, { amount: 400_000, description: 'Airtime and bank charges' }),
    );
    postEntry(
      book,
      facilityPaymentEntry(
        { id: 'je_31', date: '2026-04-30' },
        { facilityId: 'fac_1', investorMemberId: 'mem_juma', interest: 900_000, principal: 10_000_000 },
      ),
    );

    const april = cashFlowStatement(book, { from: '2026-04-30' });
    assert.equal(section(april, 'earnings').net, -(400_000 + 900_000), 'costs of earning');
    assert.equal(section(april, 'capital').net, -10_000_000, 'capital returned to the investor');
    assert.equal(april.reconciles, true);
  });

  it('ignores entries that move no cash', () => {
    const book = workedExample();
    const withCash = cashFlowStatement(book).movements;

    // The fee being earned is a liability becoming income: no cash moves.
    assert.equal(
      cashFlowStatement(book, { from: '2026-01-15', to: '2026-01-15' }).movements,
      1,
      'only the disbursement moved cash that day',
    );
    assert.equal(withCash, 8);
  });
});

describe('member statements', () => {
  it('reads the borrower’s side from the borrower’s point of view', () => {
    const statement = memberStatement(workedExample(), 'mem_elia');

    assert.equal(statement.totals.shares, 5_000_000, 'paid in for a seat');
    assert.equal(statement.totals.borrowed, 50_000_000, 'received');
    assert.equal(statement.totals.repaid, 50_000_000, 'principal returned');
    assert.equal(statement.totals.interest, 3_375_000);
    assert.equal(statement.totals.fees, 47_500, 'the application fee, net of what the rail took');
  });

  it('nets out to what the member is ahead or behind', () => {
    const statement = memberStatement(workedExample(), 'mem_elia');

    // Paid: 5,000,000 shares + 47,500 fee + 53,375,000 repaid.
    // Received: 50,000,000 of loan. The difference is their own capital plus
    // the interest the circle earned from them.
    assert.equal(statement.paidIn, 5_000_000 + 47_500 + 53_375_000);
    assert.equal(statement.paidOut, 50_000_000);
    assert.equal(statement.totals.net, 8_422_500);
    assert.equal(
      statement.rows.at(-1)!.runningTotal,
      statement.totals.net,
      'the running total ends where the totals say',
    );
  });

  it('names a loan going out as borrowing and money coming back as repayment', () => {
    const rows = memberStatement(workedExample(), 'mem_elia').rows;

    assert.equal(rows.find((row) => row.entryId === 'je_05')!.kind, 'borrowed');
    assert.equal(rows.find((row) => row.entryId === 'je_05')!.amount, -50_000_000);
    assert.equal(rows.find((row) => row.entryId === 'je_20')!.kind, 'repaid');
    assert.equal(rows.find((row) => row.entryId === 'je_20')!.amount, 35_000_000);
  });

  it('splits a repayment’s principal and interest into one row the member can read', () => {
    const row = memberStatement(workedExample(), 'mem_elia').rows.find((r) => r.entryId === 'je_10')!;

    assert.equal(row.amount, 6_125_000, 'what actually left their hand');
    assert.deepEqual(row.accounts.sort(), ['INTEREST_INCOME', 'LOANS_RECEIVABLE']);
    assert.deepEqual(row.loanIds, ['loan_1']);
  });

  it('shows the investor lending to the circle rather than subscribing to it', () => {
    const statement = memberStatement(workedExample(), 'mem_juma');

    assert.equal(statement.totals.investor, 200_000_000);
    assert.equal(statement.totals.shares, 0, 'a facility is a loan, not equity');
    assert.equal(statement.rows.length, 1);
    assert.equal(statement.rows[0].kind, 'investor');
  });

  it('carries a monthly contribution as savings', () => {
    const book = workedExample();
    postEntry(
      book,
      savingsContributionEntry({ id: 'je_40', date: '2026-05-05' }, { memberId: 'mem_neema', amount: 100_000 }),
    );

    const statement = memberStatement(book, 'mem_neema');
    assert.equal(statement.totals.savings, 100_000);
    assert.equal(statement.rows[0].kind, 'savings');
  });

  it('keeps one member’s statement free of everyone else’s money', () => {
    const statement = memberStatement(workedExample(), 'mem_juma');
    assert.ok(statement.rows.every((row) => !row.loanIds.includes('loan_1')));
  });

  it('marks a reversed row rather than hiding it', () => {
    const book = workedExample();
    reverseEntry(book, 'je_10', { id: 'je_90', date: '2026-05-01', reason: 'Receipt was entered twice' });

    const rows = memberStatement(book, 'mem_elia').rows;
    const original = rows.find((row) => row.entryId === 'je_10')!;
    const reversal = rows.find((row) => row.entryId === 'je_90')!;

    assert.equal(original.reversedBy, 'je_90');
    assert.equal(reversal.reversalOf, 'je_10');
    assert.equal(reversal.amount, -original.amount, 'the correction cancels the original');
  });

  it('honours a window', () => {
    const statement = memberStatement(workedExample(), 'mem_elia', { from: '2026-04-01' });

    assert.equal(statement.rows.length, 2, 'the last instalment and the balloon');
    assert.equal(statement.totals.repaid, 40_000_000);
    assert.equal(statement.totals.borrowed, 0);
  });

  it('returns an empty statement for a member with no movements', () => {
    const statement = memberStatement(workedExample(), 'mem_nobody');

    assert.deepEqual(statement.rows, []);
    assert.equal(statement.totals.net, 0);
    assert.equal(statement.paidIn, 0);
  });

  it('refuses a statement with no member', () => {
    assert.throws(() => memberStatement(workedExample(), ''), StatementError);
  });
});

// --- helpers ---------------------------------------------------------------

function section(statement: ReturnType<typeof cashFlowStatement>, name: string) {
  const found = statement.sections.find((candidate) => candidate.name === name);
  assert.ok(found, `no ${name} section`);
  return found;
}

function line(statement: ReturnType<typeof cashFlowStatement>, sectionName: string, account: string) {
  const found = section(statement, sectionName).lines.find((candidate) => candidate.account === account);
  assert.ok(found, `no ${account} line in ${sectionName}`);
  return found;
}
