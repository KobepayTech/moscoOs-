import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountBalance,
  cashPosition,
  createBook,
  credit,
  debit,
  defaultWriteOffEntry,
  deployedPrincipal,
  disbursementEntry,
  facilityAccrualEntry,
  facilityDrawdownEntry,
  facilityPaymentEntry,
  feeEntry,
  financialPosition,
  incomeStatement,
  LedgerError,
  ledgerView,
  operatingExpenseEntry,
  postEntry,
  repaymentEntry,
  reverseEntry,
  shareSubscriptionEntry,
  trialBalance,
  voidEntryByResolution,
} from '../src/ledger.js';

describe('posting', () => {
  it('accepts a balanced entry', () => {
    const book = createBook();
    postEntry(book, {
      id: 'je_1',
      date: '2026-01-01',
      narration: 'Opening capital',
      lines: [debit('CASH', 5_000_000), credit('SHARE_CAPITAL', 5_000_000)],
    });

    assert.equal(book.entries.length, 1);
    assert.equal(cashPosition(book), 5_000_000);
  });

  it('refuses an entry that does not balance', () => {
    const book = createBook();
    assert.throws(
      () =>
        postEntry(book, {
          id: 'je_bad',
          date: '2026-01-01',
          narration: 'Wrong',
          lines: [debit('CASH', 5_000_000), credit('SHARE_CAPITAL', 4_000_000)],
        }),
      LedgerError,
    );
    assert.equal(book.entries.length, 0);
  });

  it('refuses a line that is both a debit and a credit', () => {
    const book = createBook();
    assert.throws(
      () =>
        postEntry(book, {
          id: 'je_bad',
          date: '2026-01-01',
          narration: 'Confused',
          lines: [{ account: 'CASH', debit: 100, credit: 100 }, credit('SHARE_CAPITAL', 0)],
        }),
      LedgerError,
    );
  });

  it('refuses negative amounts, which would hide the direction of a movement', () => {
    const book = createBook();
    assert.throws(
      () =>
        postEntry(book, {
          id: 'je_bad',
          date: '2026-01-01',
          narration: 'Negative',
          lines: [debit('CASH', -100), credit('SHARE_CAPITAL', -100)],
        }),
      LedgerError,
    );
  });

  it('refuses a duplicate entry id', () => {
    const book = createBook();
    const entry = {
      id: 'je_1',
      date: '2026-01-01',
      narration: 'Once',
      lines: [debit('CASH', 100), credit('FEE_INCOME', 100)],
    };
    postEntry(book, entry);
    assert.throws(() => postEntry(book, { ...entry }), LedgerError);
  });

  it('refuses an entry that moves no money', () => {
    const book = createBook();
    assert.throws(
      () =>
        postEntry(book, {
          id: 'je_zero',
          date: '2026-01-01',
          narration: 'Nothing',
          lines: [debit('CASH', 0), credit('FEE_INCOME', 0)],
        }),
      LedgerError,
    );
  });
});

/**
 * A full circle year in miniature: members subscribe, an investor lends,
 * a member borrows and repays, and the books must reconcile at every step.
 */
describe('a circle’s books end to end', () => {
  function foundedCircle() {
    const book = createBook();
    let seq = 0;
    const next = (date: string) => ({ id: `je_${++seq}`, date });

    // Thirty members take up fifty shares each.
    for (let i = 1; i <= 30; i += 1) {
      postEntry(
        book,
        shareSubscriptionEntry(next('2026-01-01'), { memberId: `mem_${i}`, amount: 5_000_000 }),
      );
      postEntry(
        book,
        feeEntry(next('2026-01-01'), {
          memberId: `mem_${i}`,
          amount: 70_000,
          description: 'Joining fee and annual subscription',
        }),
      );
    }

    // One member advances external capital.
    postEntry(
      book,
      facilityDrawdownEntry(next('2026-01-10'), {
        facilityId: 'fac_1',
        investorMemberId: 'mem_30',
        amount: 200_000_000,
      }),
    );

    return { book, next };
  }

  it('raises 150,000,000 of share capital and holds 200,000,000 as a liability', () => {
    const { book } = foundedCircle();

    assert.equal(accountBalance(book, 'SHARE_CAPITAL').balance, 150_000_000);
    assert.equal(accountBalance(book, 'FACILITY_PRINCIPAL').balance, 200_000_000);
    assert.equal(accountBalance(book, 'FEE_INCOME').balance, 2_100_000);
    assert.equal(cashPosition(book), 150_000_000 + 2_100_000 + 200_000_000);
  });

  it('moves cash into loans on disbursement without changing the total', () => {
    const { book, next } = foundedCircle();
    const before = financialPosition(book).totalAssets;

    postEntry(
      book,
      disbursementEntry(next('2026-02-01'), {
        loanId: 'loan_1',
        memberId: 'mem_1',
        principal: 50_000_000,
      }),
    );

    assert.equal(deployedPrincipal(book), 50_000_000);
    assert.equal(financialPosition(book).totalAssets, before, 'a disbursement moves assets, it does not create them');
    assert.equal(trialBalance(book).balanced, true);
  });

  it('recognises interest as income only when it is collected', () => {
    const { book, next } = foundedCircle();

    postEntry(
      book,
      disbursementEntry(next('2026-02-01'), { loanId: 'loan_1', memberId: 'mem_1', principal: 50_000_000 }),
    );
    postEntry(
      book,
      repaymentEntry(next('2026-03-01'), {
        loanId: 'loan_1',
        memberId: 'mem_1',
        principal: 5_000_000,
        interest: 1_125_000,
      }),
    );

    assert.equal(deployedPrincipal(book), 45_000_000);
    assert.equal(accountBalance(book, 'INTEREST_INCOME').balance, 1_125_000);
    assert.equal(incomeStatement(book).interestIncome, 1_125_000);
  });

  it('books a penalty separately from interest', () => {
    const { book, next } = foundedCircle();

    postEntry(
      book,
      disbursementEntry(next('2026-02-01'), { loanId: 'loan_1', memberId: 'mem_1', principal: 10_000_000 }),
    );
    postEntry(
      book,
      repaymentEntry(next('2026-04-01'), {
        loanId: 'loan_1',
        memberId: 'mem_1',
        principal: 1_000_000,
        interest: 250_000,
        penalty: 40_000,
      }),
    );

    assert.equal(accountBalance(book, 'PENALTY_INCOME').balance, 40_000);
    assert.equal(accountBalance(book, 'INTEREST_INCOME').balance, 250_000);
  });

  it('accrues then pays the investor, clearing the liability', () => {
    const { book, next } = foundedCircle();

    postEntry(
      book,
      facilityAccrualEntry(next('2026-02-28'), {
        facilityId: 'fac_1',
        investorMemberId: 'mem_30',
        amount: 500_000,
        period: 'February 2026',
      }),
    );

    assert.equal(accountBalance(book, 'FACILITY_INTEREST_PAYABLE').balance, 500_000);
    assert.equal(accountBalance(book, 'FACILITY_INTEREST_EXPENSE').balance, 500_000);

    postEntry(
      book,
      facilityPaymentEntry(next('2026-03-05'), {
        facilityId: 'fac_1',
        investorMemberId: 'mem_30',
        interest: 500_000,
        principal: 0,
      }),
    );

    assert.equal(accountBalance(book, 'FACILITY_INTEREST_PAYABLE').balance, 0);
    assert.equal(trialBalance(book).balanced, true);
  });

  it('shows the surplus as income less expenses', () => {
    const { book, next } = foundedCircle();

    postEntry(
      book,
      disbursementEntry(next('2026-02-01'), { loanId: 'loan_1', memberId: 'mem_1', principal: 50_000_000 }),
    );
    postEntry(
      book,
      repaymentEntry(next('2026-03-01'), {
        loanId: 'loan_1',
        memberId: 'mem_1',
        principal: 5_000_000,
        interest: 1_125_000,
      }),
    );
    postEntry(
      book,
      facilityAccrualEntry(next('2026-02-28'), {
        facilityId: 'fac_1',
        investorMemberId: 'mem_30',
        amount: 400_000,
        period: 'February 2026',
      }),
    );
    postEntry(
      book,
      operatingExpenseEntry(next('2026-02-28'), { amount: 300_000, description: 'Airtime and stationery' }),
    );

    const statement = incomeStatement(book);
    assert.equal(statement.totalIncome, 1_125_000 + 2_100_000);
    assert.equal(statement.totalExpense, 700_000);
    assert.equal(statement.surplus, statement.totalIncome - statement.totalExpense);
    assert.equal(financialPosition(book).surplus, statement.surplus);
  });

  it('keeps the balance sheet balanced through a default write-off', () => {
    const { book, next } = foundedCircle();

    postEntry(
      book,
      disbursementEntry(next('2026-02-01'), { loanId: 'loan_1', memberId: 'mem_1', principal: 20_000_000 }),
    );

    // Borrower and sponsors cover 15,000,000 through shares, 2,000,000 is
    // chased personally, 3,000,000 is the circle's own loss.
    postEntry(
      book,
      defaultWriteOffEntry(next('2026-08-01'), {
        loanId: 'loan_1',
        memberId: 'mem_1',
        outstandingPrincipal: 20_000_000,
        recoveredFromShares: 15_000_000,
        sponsorReceivable: 2_000_000,
        writtenOff: 3_000_000,
      }),
    );

    assert.equal(deployedPrincipal(book), 0);
    assert.equal(accountBalance(book, 'SHARE_CAPITAL').balance, 135_000_000, 'members carried the loss');
    assert.equal(accountBalance(book, 'SPONSOR_RECEIVABLE').balance, 2_000_000);
    assert.equal(accountBalance(book, 'LOAN_LOSS').balance, 3_000_000);

    const position = financialPosition(book);
    assert.equal(position.balanced, true);
    assert.equal(trialBalance(book).balanced, true);
  });

  it('always balances, whatever sequence of transactions runs through it', () => {
    const { book, next } = foundedCircle();

    for (let i = 1; i <= 10; i += 1) {
      postEntry(
        book,
        disbursementEntry(next('2026-02-01'), {
          loanId: `loan_${i}`,
          memberId: `mem_${i}`,
          principal: i * 1_000_000,
        }),
      );
      postEntry(
        book,
        repaymentEntry(next('2026-03-01'), {
          loanId: `loan_${i}`,
          memberId: `mem_${i}`,
          principal: i * 100_000,
          interest: i * 25_000,
          penalty: i * 1_000,
        }),
      );
    }

    const tb = trialBalance(book);
    assert.equal(tb.difference, 0);
    assert.equal(tb.balanced, true);
    assert.equal(financialPosition(book).balanced, true);
  });
});

describe('correcting a mistake', () => {
  function bookWithEntry() {
    const book = createBook();
    postEntry(book, {
      id: 'je_1',
      date: '2026-02-01',
      narration: 'Contribution recorded twice',
      reference: 'MPESA-993',
      lines: [debit('CASH', 100_000, { memberId: 'mem_4' }), credit('FEE_INCOME', 100_000, { memberId: 'mem_4' })],
    });
    return book;
  }

  it('reverses rather than edits, leaving the original in place', () => {
    const book = bookWithEntry();
    reverseEntry(book, 'je_1', { id: 'je_2', date: '2026-02-03', reason: 'duplicate receipt' });

    assert.equal(book.entries.length, 2, 'both the original and the reversal are on the record');
    assert.equal(book.index.get('je_1')?.reversedBy, 'je_2');
    assert.equal(book.index.get('je_2')?.reversalOf, 'je_1');
    assert.equal(cashPosition(book), 0, 'the net effect is nil');
    assert.equal(trialBalance(book).balanced, true);
  });

  it('refuses to reverse the same entry twice', () => {
    const book = bookWithEntry();
    reverseEntry(book, 'je_1', { id: 'je_2', date: '2026-02-03', reason: 'duplicate' });

    assert.throws(
      () => reverseEntry(book, 'je_1', { id: 'je_3', date: '2026-02-04', reason: 'again' }),
      LedgerError,
    );
  });

  it('refuses to reverse a reversal', () => {
    const book = bookWithEntry();
    reverseEntry(book, 'je_1', { id: 'je_2', date: '2026-02-03', reason: 'duplicate' });

    assert.throws(
      () => reverseEntry(book, 'je_2', { id: 'je_3', date: '2026-02-04', reason: 'undo the undo' }),
      LedgerError,
    );
  });

  it('marks an entry void when the members resolve to remove it, but keeps it visible', () => {
    const book = bookWithEntry();
    voidEntryByResolution(book, 'je_1', { id: 'je_2', date: '2026-03-01', proposalId: 'prop_7' });

    const original = book.index.get('je_1');
    assert.equal(original?.voided, true);
    assert.ok(book.entries.some((entry) => entry.id === 'je_1'), 'the record itself is never removed');
    assert.match(book.index.get('je_2')?.narration ?? '', /prop_7/);
  });
});

describe('the members’ ledger book', () => {
  function populated() {
    const book = createBook();
    postEntry(book, shareSubscriptionEntry({ id: 'je_1', date: '2026-01-01' }, { memberId: 'mem_1', amount: 5_000_000 }));
    postEntry(book, shareSubscriptionEntry({ id: 'je_2', date: '2026-01-01' }, { memberId: 'mem_2', amount: 5_000_000 }));
    postEntry(
      book,
      disbursementEntry({ id: 'je_3', date: '2026-02-01' }, { loanId: 'loan_1', memberId: 'mem_1', principal: 3_000_000 }),
    );
    return book;
  }

  it('shows every movement to every member', () => {
    const rows = ledgerView(populated());
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.id), ['je_1', 'je_2', 'je_3']);
  });

  it('can be filtered to one member’s own history', () => {
    const rows = ledgerView(populated(), { memberId: 'mem_1' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.memberIds.includes('mem_1')));
  });

  it('can be read as at a past date', () => {
    const rows = ledgerView(populated(), { asOf: '2026-01-15' });
    assert.equal(rows.length, 2);
  });

  it('flags voided rows rather than hiding them', () => {
    const book = populated();
    voidEntryByResolution(book, 'je_2', { id: 'je_4', date: '2026-03-01', proposalId: 'prop_1' });

    const rows = ledgerView(book);
    const voided = rows.find((row) => row.id === 'je_2');
    assert.equal(voided?.voided, true);
    assert.equal(voided?.reversedBy, 'je_4');
  });
});
