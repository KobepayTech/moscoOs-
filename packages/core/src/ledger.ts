/**
 * The circle's books.
 *
 * Every movement of money is posted as a balanced double-entry journal. That
 * is not bureaucracy for its own sake: it is the only way a circle of thirty
 * members can prove, at any moment, that the cash it thinks it has and the
 * loans it thinks are out actually reconcile to the capital it was given.
 *
 * The public ledger the members read in the app is a projection of this
 * journal. Entries are append-only; a mistake is corrected by posting a
 * reversal, never by editing or deleting the original (see governance.ts).
 */

import { type ISODate, assertISODate, compareDates, isOnOrBefore } from './dates.js';
import { type Money, nonNegative, sum } from './money.js';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export type AccountCode =
  // Assets
  | 'CASH'
  | 'LOANS_RECEIVABLE'
  | 'INTEREST_RECEIVABLE'
  | 'SPONSOR_RECEIVABLE'
  // Liabilities
  | 'FACILITY_PRINCIPAL'
  | 'FACILITY_INTEREST_PAYABLE'
  | 'MEMBER_SAVINGS'
  // Equity
  | 'SHARE_CAPITAL'
  | 'RETAINED_EARNINGS'
  // Income
  | 'INTEREST_INCOME'
  | 'FEE_INCOME'
  | 'PENALTY_INCOME'
  // Expenses
  | 'FACILITY_INTEREST_EXPENSE'
  | 'OPERATING_EXPENSE'
  | 'LOAN_LOSS';

export interface Account {
  code: AccountCode;
  name: string;
  type: AccountType;
  /** Which side increases this account. */
  normalBalance: 'debit' | 'credit';
}

export const CHART_OF_ACCOUNTS: Record<AccountCode, Account> = {
  CASH: { code: 'CASH', name: 'Cash and bank', type: 'asset', normalBalance: 'debit' },
  LOANS_RECEIVABLE: {
    code: 'LOANS_RECEIVABLE',
    name: 'Loans to members',
    type: 'asset',
    normalBalance: 'debit',
  },
  INTEREST_RECEIVABLE: {
    code: 'INTEREST_RECEIVABLE',
    name: 'Interest receivable',
    type: 'asset',
    normalBalance: 'debit',
  },
  SPONSOR_RECEIVABLE: {
    code: 'SPONSOR_RECEIVABLE',
    name: 'Amounts due from sponsors',
    type: 'asset',
    normalBalance: 'debit',
  },
  FACILITY_PRINCIPAL: {
    code: 'FACILITY_PRINCIPAL',
    name: 'External capital facilities',
    type: 'liability',
    normalBalance: 'credit',
  },
  FACILITY_INTEREST_PAYABLE: {
    code: 'FACILITY_INTEREST_PAYABLE',
    name: 'Return payable to investors',
    type: 'liability',
    normalBalance: 'credit',
  },
  MEMBER_SAVINGS: {
    code: 'MEMBER_SAVINGS',
    name: 'Member savings balances',
    type: 'liability',
    normalBalance: 'credit',
  },
  SHARE_CAPITAL: { code: 'SHARE_CAPITAL', name: 'Share capital', type: 'equity', normalBalance: 'credit' },
  RETAINED_EARNINGS: {
    code: 'RETAINED_EARNINGS',
    name: 'Retained earnings',
    type: 'equity',
    normalBalance: 'credit',
  },
  INTEREST_INCOME: {
    code: 'INTEREST_INCOME',
    name: 'Interest on member loans',
    type: 'income',
    normalBalance: 'credit',
  },
  FEE_INCOME: { code: 'FEE_INCOME', name: 'Fees and subscriptions', type: 'income', normalBalance: 'credit' },
  PENALTY_INCOME: { code: 'PENALTY_INCOME', name: 'Penalties', type: 'income', normalBalance: 'credit' },
  FACILITY_INTEREST_EXPENSE: {
    code: 'FACILITY_INTEREST_EXPENSE',
    name: 'Return paid on external capital',
    type: 'expense',
    normalBalance: 'debit',
  },
  OPERATING_EXPENSE: {
    code: 'OPERATING_EXPENSE',
    name: 'Operating expenses',
    type: 'expense',
    normalBalance: 'debit',
  },
  LOAN_LOSS: { code: 'LOAN_LOSS', name: 'Loans written off', type: 'expense', normalBalance: 'debit' },
};

export interface JournalLine {
  account: AccountCode;
  debit: Money;
  credit: Money;
  memberId?: string;
  loanId?: string;
  facilityId?: string;
}

export interface JournalEntry {
  id: string;
  date: ISODate;
  narration: string;
  /** External reference: receipt number, mobile-money code, meeting minute. */
  reference?: string;
  lines: JournalLine[];
  /** Set when this entry reverses another. */
  reversalOf?: string | null;
  /** Set on the original when a reversal has been posted against it. */
  reversedBy?: string | null;
  /** True once a governance vote has voided it. The entry itself stays. */
  voided?: boolean;
  postedBy?: string;
}

export interface Book {
  entries: JournalEntry[];
  /** Fast lookup by entry id. */
  index: Map<string, JournalEntry>;
}

export function createBook(): Book {
  return { entries: [], index: new Map() };
}

export function debit(account: AccountCode, amount: Money, tags: Partial<JournalLine> = {}): JournalLine {
  return { account, debit: amount, credit: 0, ...tags };
}

export function credit(account: AccountCode, amount: Money, tags: Partial<JournalLine> = {}): JournalLine {
  return { account, debit: 0, credit: amount, ...tags };
}

/**
 * Post an entry, refusing anything that does not balance.
 *
 * This is the invariant the whole system rests on. If a caller can post an
 * unbalanced entry, every report downstream becomes a guess.
 */
export function postEntry(book: Book, entry: JournalEntry): JournalEntry {
  assertISODate(entry.date, 'entry.date');

  if (entry.lines.length < 2) {
    throw new LedgerError(`Entry ${entry.id} must carry at least two lines`);
  }
  if (book.index.has(entry.id)) {
    throw new LedgerError(`Entry ${entry.id} has already been posted`);
  }

  let debits = 0;
  let credits = 0;
  for (const line of entry.lines) {
    if (line.debit < 0 || line.credit < 0) {
      throw new LedgerError(`Entry ${entry.id} has a negative amount; post the opposite side instead`);
    }
    if (line.debit > 0 && line.credit > 0) {
      throw new LedgerError(`Entry ${entry.id} has a line that is both a debit and a credit`);
    }
    if (!(line.account in CHART_OF_ACCOUNTS)) {
      throw new LedgerError(`Entry ${entry.id} references unknown account ${line.account}`);
    }
    debits += line.debit;
    credits += line.credit;
  }

  if (debits !== credits) {
    throw new LedgerError(
      `Entry ${entry.id} does not balance: debits ${debits} against credits ${credits} (out by ${debits - credits})`,
    );
  }
  if (debits === 0) {
    throw new LedgerError(`Entry ${entry.id} moves no money`);
  }

  book.entries.push(entry);
  book.index.set(entry.id, entry);
  return entry;
}

/**
 * Reverse a posted entry.
 *
 * Swaps every debit and credit and links the two together. The original stays
 * in the book, flagged — which is what makes the circle's history auditable
 * even after a correction.
 */
export function reverseEntry(
  book: Book,
  entryId: string,
  options: { id: string; date: ISODate; reason: string; postedBy?: string },
): JournalEntry {
  const original = book.index.get(entryId);
  if (!original) throw new LedgerError(`Cannot reverse unknown entry ${entryId}`);
  if (original.reversedBy) {
    throw new LedgerError(`Entry ${entryId} was already reversed by ${original.reversedBy}`);
  }
  if (original.reversalOf) {
    throw new LedgerError(`Entry ${entryId} is itself a reversal and cannot be reversed again`);
  }

  const reversal: JournalEntry = {
    id: options.id,
    date: options.date,
    narration: `Reversal of ${original.id}: ${options.reason}`,
    reference: original.reference,
    reversalOf: original.id,
    postedBy: options.postedBy,
    lines: original.lines.map((line) => ({
      ...line,
      debit: line.credit,
      credit: line.debit,
    })),
  };

  postEntry(book, reversal);
  original.reversedBy = reversal.id;
  return reversal;
}

/** Mark an entry void after a governance vote, posting the balancing reversal. */
export function voidEntryByResolution(
  book: Book,
  entryId: string,
  options: { id: string; date: ISODate; proposalId: string; postedBy?: string },
): JournalEntry {
  const original = book.index.get(entryId);
  if (!original) throw new LedgerError(`Cannot void unknown entry ${entryId}`);

  const reversal = reverseEntry(book, entryId, {
    id: options.id,
    date: options.date,
    reason: `voided by member resolution ${options.proposalId}`,
    postedBy: options.postedBy,
  });
  original.voided = true;
  return reversal;
}

export interface AccountBalance {
  account: AccountCode;
  name: string;
  type: AccountType;
  debits: Money;
  credits: Money;
  /** Signed to the account's normal balance: positive means "as expected". */
  balance: Money;
}

function entriesUpTo(book: Book, asOf?: ISODate): JournalEntry[] {
  const entries = asOf ? book.entries.filter((entry) => isOnOrBefore(entry.date, asOf)) : book.entries;
  return entries.slice().sort((a, b) => compareDates(a.date, b.date) || (a.id < b.id ? -1 : 1));
}

export function accountBalance(book: Book, account: AccountCode, asOf?: ISODate): AccountBalance {
  const meta = CHART_OF_ACCOUNTS[account];
  let debits = 0;
  let credits = 0;

  for (const entry of entriesUpTo(book, asOf)) {
    for (const line of entry.lines) {
      if (line.account !== account) continue;
      debits += line.debit;
      credits += line.credit;
    }
  }

  return {
    account,
    name: meta.name,
    type: meta.type,
    debits,
    credits,
    balance: meta.normalBalance === 'debit' ? debits - credits : credits - debits,
  };
}

export interface TrialBalance {
  asOf: ISODate | null;
  rows: AccountBalance[];
  totalDebits: Money;
  totalCredits: Money;
  /** Zero in a healthy book. Anything else is a bug worth stopping for. */
  difference: Money;
  balanced: boolean;
}

export function trialBalance(book: Book, asOf?: ISODate): TrialBalance {
  const rows = (Object.keys(CHART_OF_ACCOUNTS) as AccountCode[])
    .map((code) => accountBalance(book, code, asOf))
    .filter((row) => row.debits !== 0 || row.credits !== 0);

  const totalDebits = sum(rows.map((row) => row.debits));
  const totalCredits = sum(rows.map((row) => row.credits));

  return {
    asOf: asOf ?? null,
    rows,
    totalDebits,
    totalCredits,
    difference: totalDebits - totalCredits,
    balanced: totalDebits === totalCredits,
  };
}

export interface FinancialPosition {
  asOf: ISODate | null;
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  equity: AccountBalance[];
  totalAssets: Money;
  totalLiabilities: Money;
  /** Share capital plus retained earnings plus the period's surplus. */
  totalEquity: Money;
  /** Income less expenses for the whole period covered. */
  surplus: Money;
  balanced: boolean;
}

/** The circle's balance sheet, with the running surplus folded into equity. */
export function financialPosition(book: Book, asOf?: ISODate): FinancialPosition {
  const balances = (Object.keys(CHART_OF_ACCOUNTS) as AccountCode[]).map((code) =>
    accountBalance(book, code, asOf),
  );

  const byType = (type: AccountType) => balances.filter((row) => row.type === type && row.balance !== 0);

  const assets = byType('asset');
  const liabilities = byType('liability');
  const equity = byType('equity');

  const income = sum(byType('income').map((row) => row.balance));
  const expenses = sum(byType('expense').map((row) => row.balance));
  const surplus = income - expenses;

  const totalAssets = sum(assets.map((row) => row.balance));
  const totalLiabilities = sum(liabilities.map((row) => row.balance));
  const totalEquity = sum(equity.map((row) => row.balance)) + surplus;

  return {
    asOf: asOf ?? null,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    surplus,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

export interface IncomeStatement {
  from: ISODate | null;
  to: ISODate | null;
  interestIncome: Money;
  feeIncome: Money;
  penaltyIncome: Money;
  totalIncome: Money;
  facilityInterestExpense: Money;
  operatingExpense: Money;
  loanLoss: Money;
  totalExpense: Money;
  surplus: Money;
}

export function incomeStatement(book: Book, from?: ISODate, to?: ISODate): IncomeStatement {
  const inWindow = (entry: JournalEntry) =>
    (!from || compareDates(entry.date, from) >= 0) && (!to || isOnOrBefore(entry.date, to));

  const total = (account: AccountCode): Money => {
    const meta = CHART_OF_ACCOUNTS[account];
    let debits = 0;
    let credits = 0;
    for (const entry of book.entries) {
      if (!inWindow(entry)) continue;
      for (const line of entry.lines) {
        if (line.account !== account) continue;
        debits += line.debit;
        credits += line.credit;
      }
    }
    return meta.normalBalance === 'debit' ? debits - credits : credits - debits;
  };

  const interestIncome = total('INTEREST_INCOME');
  const feeIncome = total('FEE_INCOME');
  const penaltyIncome = total('PENALTY_INCOME');
  const facilityInterestExpense = total('FACILITY_INTEREST_EXPENSE');
  const operatingExpense = total('OPERATING_EXPENSE');
  const loanLoss = total('LOAN_LOSS');

  const totalIncome = interestIncome + feeIncome + penaltyIncome;
  const totalExpense = facilityInterestExpense + operatingExpense + loanLoss;

  return {
    from: from ?? null,
    to: to ?? null,
    interestIncome,
    feeIncome,
    penaltyIncome,
    totalIncome,
    facilityInterestExpense,
    operatingExpense,
    loanLoss,
    totalExpense,
    surplus: totalIncome - totalExpense,
  };
}

// ---------------------------------------------------------------------------
// Entry builders — the standard transactions of a circle
// ---------------------------------------------------------------------------

export interface EntryContext {
  id: string;
  date: ISODate;
  reference?: string;
  postedBy?: string;
}

/** A member takes up shares: cash in, share capital up. */
export function shareSubscriptionEntry(
  ctx: EntryContext,
  args: { memberId: string; amount: Money },
): JournalEntry {
  return {
    ...ctx,
    narration: `Share subscription by ${args.memberId}`,
    lines: [
      debit('CASH', args.amount, { memberId: args.memberId }),
      credit('SHARE_CAPITAL', args.amount, { memberId: args.memberId }),
    ],
  };
}

/** Joining fee or annual subscription: income, not capital. */
export function feeEntry(
  ctx: EntryContext,
  args: { memberId: string; amount: Money; description: string },
): JournalEntry {
  return {
    ...ctx,
    narration: `${args.description} — ${args.memberId}`,
    lines: [
      debit('CASH', args.amount, { memberId: args.memberId }),
      credit('FEE_INCOME', args.amount, { memberId: args.memberId }),
    ],
  };
}

/** An investor advances external capital: cash in, liability up. */
export function facilityDrawdownEntry(
  ctx: EntryContext,
  args: { facilityId: string; investorMemberId: string; amount: Money },
): JournalEntry {
  return {
    ...ctx,
    narration: `External capital received from ${args.investorMemberId} (${args.facilityId})`,
    lines: [
      debit('CASH', args.amount, { memberId: args.investorMemberId, facilityId: args.facilityId }),
      credit('FACILITY_PRINCIPAL', args.amount, {
        memberId: args.investorMemberId,
        facilityId: args.facilityId,
      }),
    ],
  };
}

/** Money goes out to a borrower: cash down, loan receivable up. */
export function disbursementEntry(
  ctx: EntryContext,
  args: { loanId: string; memberId: string; principal: Money },
): JournalEntry {
  return {
    ...ctx,
    narration: `Loan ${args.loanId} disbursed to ${args.memberId}`,
    lines: [
      debit('LOANS_RECEIVABLE', args.principal, { memberId: args.memberId, loanId: args.loanId }),
      credit('CASH', args.principal, { memberId: args.memberId, loanId: args.loanId }),
    ],
  };
}

/**
 * A borrower repays.
 *
 * Interest and penalties are recognised as income at the moment they are
 * collected; only the principal part reduces the receivable.
 */
export function repaymentEntry(
  ctx: EntryContext,
  args: {
    loanId: string;
    memberId: string;
    principal: Money;
    interest: Money;
    penalty?: Money;
  },
): JournalEntry {
  const penalty = args.penalty ?? 0;
  const tags = { memberId: args.memberId, loanId: args.loanId };
  const lines: JournalLine[] = [debit('CASH', args.principal + args.interest + penalty, tags)];

  if (args.principal > 0) lines.push(credit('LOANS_RECEIVABLE', args.principal, tags));
  if (args.interest > 0) lines.push(credit('INTEREST_INCOME', args.interest, tags));
  if (penalty > 0) lines.push(credit('PENALTY_INCOME', penalty, tags));

  return { ...ctx, narration: `Repayment on loan ${args.loanId} by ${args.memberId}`, lines };
}

/** Recognise the return owed to external capital for a period. */
export function facilityAccrualEntry(
  ctx: EntryContext,
  args: { facilityId: string; investorMemberId: string; amount: Money; period: string },
): JournalEntry {
  const tags = { memberId: args.investorMemberId, facilityId: args.facilityId };
  return {
    ...ctx,
    narration: `Return accrued on ${args.facilityId} for ${args.period}`,
    lines: [
      debit('FACILITY_INTEREST_EXPENSE', args.amount, tags),
      credit('FACILITY_INTEREST_PAYABLE', args.amount, tags),
    ],
  };
}

/** Pay an investor: return first, then capital. */
export function facilityPaymentEntry(
  ctx: EntryContext,
  args: { facilityId: string; investorMemberId: string; interest: Money; principal: Money },
): JournalEntry {
  const tags = { memberId: args.investorMemberId, facilityId: args.facilityId };
  const lines: JournalLine[] = [];

  if (args.interest > 0) lines.push(debit('FACILITY_INTEREST_PAYABLE', args.interest, tags));
  if (args.principal > 0) lines.push(debit('FACILITY_PRINCIPAL', args.principal, tags));
  lines.push(credit('CASH', args.interest + args.principal, tags));

  return {
    ...ctx,
    narration: `Payment to investor ${args.investorMemberId} on ${args.facilityId}`,
    lines,
  };
}

/**
 * Write off a defaulted loan and book what the cascade recovered.
 *
 * Share value taken from the borrower and their sponsors is a reduction in
 * share capital, not cash: the circle keeps the money it already had and the
 * members who stood behind the loan carry the loss in their holdings.
 */
export function defaultWriteOffEntry(
  ctx: EntryContext,
  args: {
    loanId: string;
    memberId: string;
    outstandingPrincipal: Money;
    recoveredFromShares: Money;
    sponsorReceivable: Money;
    writtenOff: Money;
  },
): JournalEntry {
  const tags = { memberId: args.memberId, loanId: args.loanId };
  const lines: JournalLine[] = [];

  if (args.recoveredFromShares > 0) lines.push(debit('SHARE_CAPITAL', args.recoveredFromShares, tags));
  if (args.sponsorReceivable > 0) lines.push(debit('SPONSOR_RECEIVABLE', args.sponsorReceivable, tags));
  if (args.writtenOff > 0) lines.push(debit('LOAN_LOSS', args.writtenOff, tags));

  lines.push(credit('LOANS_RECEIVABLE', args.outstandingPrincipal, tags));

  return { ...ctx, narration: `Default on loan ${args.loanId} (${args.memberId})`, lines };
}

/** A running operating cost. */
export function operatingExpenseEntry(
  ctx: EntryContext,
  args: { amount: Money; description: string },
): JournalEntry {
  return {
    ...ctx,
    narration: args.description,
    lines: [debit('OPERATING_EXPENSE', args.amount), credit('CASH', args.amount)],
  };
}

/** A monthly contribution that accrues to savings rather than buying shares. */
export function savingsContributionEntry(
  ctx: EntryContext,
  args: { memberId: string; amount: Money },
): JournalEntry {
  return {
    ...ctx,
    narration: `Monthly contribution from ${args.memberId}`,
    lines: [
      debit('CASH', args.amount, { memberId: args.memberId }),
      credit('MEMBER_SAVINGS', args.amount, { memberId: args.memberId }),
    ],
  };
}

export interface LedgerView {
  id: string;
  date: ISODate;
  narration: string;
  reference?: string;
  amount: Money;
  voided: boolean;
  reversalOf?: string | null;
  reversedBy?: string | null;
  accounts: AccountCode[];
  memberIds: string[];
  loanIds: string[];
}

/**
 * The members' ledger book: one readable row per entry.
 *
 * Every member can see every row. That visibility is the point — a circle
 * where only the cashier knows what moved is a circle that will eventually
 * have an argument nobody can settle.
 */
export function ledgerView(book: Book, options: { asOf?: ISODate; memberId?: string } = {}): LedgerView[] {
  return entriesUpTo(book, options.asOf)
    .filter((entry) =>
      options.memberId ? entry.lines.some((line) => line.memberId === options.memberId) : true,
    )
    .map((entry) => ({
      id: entry.id,
      date: entry.date,
      narration: entry.narration,
      reference: entry.reference,
      amount: sum(entry.lines.map((line) => line.debit)),
      voided: entry.voided === true,
      reversalOf: entry.reversalOf ?? null,
      reversedBy: entry.reversedBy ?? null,
      accounts: [...new Set(entry.lines.map((line) => line.account))],
      memberIds: [...new Set(entry.lines.map((line) => line.memberId).filter(Boolean) as string[])],
      loanIds: [...new Set(entry.lines.map((line) => line.loanId).filter(Boolean) as string[])],
    }));
}

/** Cash the circle holds — what the cashier should be able to count. */
export function cashPosition(book: Book, asOf?: ISODate): Money {
  return accountBalance(book, 'CASH', asOf).balance;
}

/** Principal currently out on loan, across the whole book. */
export function deployedPrincipal(book: Book, asOf?: ISODate): Money {
  return nonNegative(accountBalance(book, 'LOANS_RECEIVABLE', asOf).balance);
}
