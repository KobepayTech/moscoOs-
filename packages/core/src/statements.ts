/**
 * Statements: where the money went, and what one member's year looks like.
 *
 * The balance sheet and income statement in `ledger.ts` answer "what is the
 * circle worth" and "did it make a surplus". Neither answers the question a
 * circle actually argues about, which is **where did the cash go**. A circle
 * can post a healthy surplus and still have an empty account, because a
 * surplus counts interest earned while cash counts interest *received*, and
 * because the largest movements in a lending circle — money going out on loan
 * and coming back — never touch the income statement at all.
 *
 * ## The cash flow statement is derived, not accumulated
 *
 * There is no separate record of cash movements to drift out of step with the
 * ledger. Every movement is read off the `CASH` lines of entries that are
 * already posted: the signed cash on an entry is what moved, and the accounts
 * on the other side of that same entry say what it was for. That makes the
 * statement an audit of the books rather than a second opinion about them, and
 * it means `openingCash + netMovement === closingCash` is a fact rather than a
 * hope. `reconciles` asserts it anyway, because a statement that cannot prove
 * itself is worth less than no statement.
 *
 * ## Three sections, named for what members do
 *
 * The textbook split — operating, investing, financing — was written for a
 * company that makes things. For a circle whose whole business is lending, it
 * puts the single largest cash movement (a disbursement) in a footnote
 * category. These sections are named for what the members recognise instead:
 *
 *   - **Lending** — money going out to borrowers and principal coming back.
 *     Almost always negative in a growing circle, and that is health, not
 *     trouble: it is capital being put to work.
 *   - **Earnings** — interest and fees received, less what it cost to run the
 *     circle and to service external capital. This is the circle's income in
 *     the only form that can pay for anything: cash.
 *   - **Capital** — subscriptions, savings, facility drawdowns and
 *     repayments. Money arriving from or returning to the people who put it
 *     up, which the circle earned no part of.
 *
 * A circle whose lending is funded by *earnings* is compounding. One whose
 * lending is funded by *capital* is growing on borrowed strength — the same
 * closing balance, a completely different position. The section totals are
 * what make that difference visible.
 *
 * ## Member statements
 *
 * The same discipline, for one person: every shilling that passed between a
 * member and the circle, what they hold now, and what they still owe or still
 * stand behind. A member who cannot reconstruct their own position from what
 * the circle publishes has to take the cashier's word for it, and a circle
 * that runs on taking someone's word is one bad month from an argument.
 */

import {
  type AccountCode,
  type Book,
  type JournalEntry,
  CHART_OF_ACCOUNTS,
  accountBalance,
} from './ledger.js';
import { type ISODate, assertISODate, compareDates, isOnOrBefore } from './dates.js';
import { type Money, sum } from './money.js';

export class StatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementError';
  }
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

export type CashFlowSectionName = 'lending' | 'earnings' | 'capital';

/**
 * Which section a cash movement belongs to, by the account on the other side.
 *
 * Every account that can face cash appears here. `CASH` itself is absent
 * deliberately — a cash-to-cash transfer is not a movement of the circle's
 * money and must never be classified as one.
 */
const SECTION_OF: Partial<Record<AccountCode, CashFlowSectionName>> = {
  LOANS_RECEIVABLE: 'lending',
  INTEREST_RECEIVABLE: 'earnings',
  SPONSOR_RECEIVABLE: 'lending',

  INTEREST_INCOME: 'earnings',
  FEE_INCOME: 'earnings',
  PENALTY_INCOME: 'earnings',
  FACILITY_INTEREST_EXPENSE: 'earnings',
  OPERATING_EXPENSE: 'earnings',
  LOAN_LOSS: 'lending',

  FACILITY_PRINCIPAL: 'capital',
  FACILITY_INTEREST_PAYABLE: 'earnings',
  MEMBER_SAVINGS: 'capital',
  APPLICATION_FEES_HELD: 'earnings',
  SHARE_CAPITAL: 'capital',
  RETAINED_EARNINGS: 'capital',
};

export interface CashFlowLine {
  account: AccountCode;
  name: string;
  /** Cash received against this account over the window. */
  inflow: Money;
  /** Cash paid out against it. */
  outflow: Money;
  /** Positive when the circle ended up with more cash. */
  net: Money;
}

export interface CashFlowSection {
  name: CashFlowSectionName;
  label: string;
  lines: CashFlowLine[];
  inflow: Money;
  outflow: Money;
  net: Money;
}

export interface CashFlowStatement {
  from: ISODate | null;
  to: ISODate | null;
  openingCash: Money;
  closingCash: Money;
  sections: CashFlowSection[];
  totalInflow: Money;
  totalOutflow: Money;
  /** Closing less opening. Equals the sum of the sections in a sound book. */
  netMovement: Money;
  /** True when the statement ties back to the ledger's own cash balance. */
  reconciles: boolean;
  /** How many entries moved cash in the window. */
  movements: number;
}

const SECTION_LABELS: Record<CashFlowSectionName, string> = {
  lending: 'Lending',
  earnings: 'Earnings',
  capital: 'Capital',
};

const SECTION_ORDER: CashFlowSectionName[] = ['lending', 'earnings', 'capital'];

/** The signed cash movement on an entry: positive is money in. */
function cashOf(entry: JournalEntry): Money {
  let movement = 0;
  for (const line of entry.lines) {
    if (line.account !== 'CASH') continue;
    movement += line.debit - line.credit;
  }
  return movement;
}

/**
 * Where the cash went, over a window.
 *
 * A reversal is an ordinary entry here rather than a special case: it moved
 * cash the other way on the day it was posted, and that is what the statement
 * should show. A voided entry is *not* excluded either — voiding marks a
 * record as repudiated, but the reversal that accompanies it is what undoes
 * the money. Dropping the original would double the correction.
 */
export function cashFlowStatement(
  book: Book,
  options: { from?: ISODate; to?: ISODate } = {},
): CashFlowStatement {
  const { from, to } = options;
  if (from !== undefined) assertISODate(from, 'from');
  if (to !== undefined) assertISODate(to, 'to');
  if (from && to && compareDates(from, to) > 0) {
    throw new StatementError(`Statement window ends (${to}) before it begins (${from})`);
  }

  // Opening cash is the balance the day before the window starts. With no
  // start date the window is the circle's whole life, so it opens at nothing.
  const openingCash = from ? cashBefore(book, from) : 0;
  const closingCash = accountBalance(book, 'CASH', to).balance;

  const buckets = new Map<CashFlowSectionName, Map<AccountCode, CashFlowLine>>();
  for (const name of SECTION_ORDER) buckets.set(name, new Map());

  let movements = 0;

  for (const entry of book.entries) {
    if (from && compareDates(entry.date, from) < 0) continue;
    if (to && !isOnOrBefore(entry.date, to)) continue;

    const movement = cashOf(entry);
    if (movement === 0) continue;

    // Split the movement across the accounts facing cash, in proportion to
    // what each carried. Almost every entry has exactly one, but a repayment
    // splits across principal and interest, and that split is the whole point
    // of the statement. Zero-value lines are dropped first, so the remainder
    // below can never land on a line that carried nothing.
    const facing = entry.lines.filter((line) => line.account !== 'CASH' && line.debit + line.credit > 0);
    const weight = sum(facing.map((line) => line.debit + line.credit));
    if (weight === 0) continue;

    movements += 1;

    let assigned = 0;
    facing.forEach((line, index) => {
      const section = SECTION_OF[line.account];
      if (!section) {
        throw new StatementError(
          `Account ${line.account} faces cash in entry ${entry.id} but has no cash flow section`,
        );
      }

      // Largest-remainder is overkill for two or three lines; giving the last
      // line whatever is left keeps the section totals exact to the shilling.
      const share = line.debit + line.credit;
      const portion =
        index === facing.length - 1
          ? movement - assigned
          : Math.round((movement * share) / weight);
      assigned += portion;
      if (portion === 0) return;

      const bucket = buckets.get(section)!;
      const row =
        bucket.get(line.account) ??
        {
          account: line.account,
          name: CHART_OF_ACCOUNTS[line.account].name,
          inflow: 0,
          outflow: 0,
          net: 0,
        };

      if (portion > 0) row.inflow += portion;
      else row.outflow += -portion;
      row.net += portion;
      bucket.set(line.account, row);
    });
  }

  const sections: CashFlowSection[] = SECTION_ORDER.map((name) => {
    const lines = [...buckets.get(name)!.values()]
      .filter((line) => line.inflow !== 0 || line.outflow !== 0)
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name));

    return {
      name,
      label: SECTION_LABELS[name],
      lines,
      inflow: sum(lines.map((line) => line.inflow)),
      outflow: sum(lines.map((line) => line.outflow)),
      net: sum(lines.map((line) => line.net)),
    };
  });

  const totalInflow = sum(sections.map((section) => section.inflow));
  const totalOutflow = sum(sections.map((section) => section.outflow));
  const netMovement = closingCash - openingCash;

  return {
    from: from ?? null,
    to: to ?? null,
    openingCash,
    closingCash,
    sections,
    totalInflow,
    totalOutflow,
    netMovement,
    reconciles: sum(sections.map((section) => section.net)) === netMovement,
    movements,
  };
}

/** Cash held the day before a window opens. */
function cashBefore(book: Book, from: ISODate): Money {
  let balance = 0;
  for (const entry of book.entries) {
    if (compareDates(entry.date, from) >= 0) continue;
    balance += cashOf(entry);
  }
  return balance;
}

// ---------------------------------------------------------------------------
// Member statements
// ---------------------------------------------------------------------------

export interface MemberStatementRow {
  entryId: string;
  date: ISODate;
  narration: string;
  reference?: string;
  /** Positive when the member paid the circle; negative when they were paid. */
  amount: Money;
  /** What the movement was against, in the member's own terms. */
  kind: MemberFlowKind;
  accounts: AccountCode[];
  loanIds: string[];
  voided: boolean;
  reversalOf?: string | null;
  reversedBy?: string | null;
  /** Running total of `amount` down the statement. */
  runningTotal: Money;
}

export type MemberFlowKind =
  | 'shares'
  | 'savings'
  | 'borrowed'
  | 'repaid'
  | 'interest'
  | 'fees'
  | 'sponsor_called'
  | 'investor'
  | 'other';

const KIND_OF: Partial<Record<AccountCode, MemberFlowKind>> = {
  SHARE_CAPITAL: 'shares',
  MEMBER_SAVINGS: 'savings',
  LOANS_RECEIVABLE: 'repaid',
  INTEREST_INCOME: 'interest',
  INTEREST_RECEIVABLE: 'interest',
  FEE_INCOME: 'fees',
  APPLICATION_FEES_HELD: 'fees',
  PENALTY_INCOME: 'fees',
  SPONSOR_RECEIVABLE: 'sponsor_called',
  FACILITY_PRINCIPAL: 'investor',
  FACILITY_INTEREST_PAYABLE: 'investor',
  FACILITY_INTEREST_EXPENSE: 'investor',
  LOAN_LOSS: 'sponsor_called',
};

export interface MemberStatementTotals {
  /** Paid for shares. */
  shares: Money;
  savings: Money;
  /** Received as loan principal. */
  borrowed: Money;
  /** Principal returned. */
  repaid: Money;
  interest: Money;
  fees: Money;
  /** Paid because someone they sponsored defaulted. */
  sponsorCalled: Money;
  /** Lent to the circle, and the return received on it. */
  investor: Money;
  /** Everything the member has paid the circle, less everything received. */
  net: Money;
}

export interface MemberStatement {
  memberId: string;
  from: ISODate | null;
  to: ISODate | null;
  rows: MemberStatementRow[];
  totals: MemberStatementTotals;
  /** What they paid in, over the window. */
  paidIn: Money;
  /** What they took out. */
  paidOut: Money;
}

/**
 * One member's account with the circle.
 *
 * Only entries carrying that member's id on a line are included, so the rows
 * are exactly the movements the circle recorded as theirs. The sign follows
 * the member's point of view rather than the ledger's: money they handed over
 * is positive, money they received is negative. That is the opposite of the
 * cash flow statement above, and deliberately so — it is the member's
 * statement, not the circle's.
 */
export function memberStatement(
  book: Book,
  memberId: string,
  options: { from?: ISODate; to?: ISODate } = {},
): MemberStatement {
  if (!memberId) throw new StatementError('A member statement needs a member id');

  const { from, to } = options;
  if (from !== undefined) assertISODate(from, 'from');
  if (to !== undefined) assertISODate(to, 'to');
  if (from && to && compareDates(from, to) > 0) {
    throw new StatementError(`Statement window ends (${to}) before it begins (${from})`);
  }

  const relevant = book.entries
    .filter((entry) => entry.lines.some((line) => line.memberId === memberId))
    .filter((entry) => !from || compareDates(entry.date, from) >= 0)
    .filter((entry) => !to || isOnOrBefore(entry.date, to))
    .slice()
    .sort((a, b) => compareDates(a.date, b.date) || (a.id < b.id ? -1 : 1));

  const totals: MemberStatementTotals = {
    shares: 0,
    savings: 0,
    borrowed: 0,
    repaid: 0,
    interest: 0,
    fees: 0,
    sponsorCalled: 0,
    investor: 0,
    net: 0,
  };

  let runningTotal = 0;
  const rows: MemberStatementRow[] = [];

  for (const entry of relevant) {
    // The cash line is the circle's side of the transaction even when it
    // carries the member's id — the id is there so the movement can be traced
    // back to them, not because the cash is theirs. Counting it would net
    // every entry to nothing: a share subscription debits cash and credits
    // share capital, both tagged with the same member.
    const mine = entry.lines.filter((line) => line.memberId === memberId && line.account !== 'CASH');
    if (mine.length === 0) continue;

    // What is left is the member's own position, read from their side. A
    // credit to share capital is money they paid in; a debit to loans
    // receivable is money they took out.
    let amount = 0;
    for (const line of mine) amount += line.credit - line.debit;

    const accounts = [...new Set(mine.map((line) => line.account))];
    const loanIds = [...new Set(mine.map((line) => line.loanId).filter(Boolean) as string[])];

    // The row gets one label, because that is what the member reads: an
    // instalment is "a repayment". The totals follow the *lines*, because an
    // instalment is principal and interest in one payment and a statement
    // that folded the interest into "principal repaid" would overstate what
    // the loan has cost and understate what the circle earned.
    for (const line of mine) {
      const value = line.credit - line.debit;
      switch (classify([line.account], value)) {
        case 'shares':
          totals.shares += value;
          break;
        case 'savings':
          totals.savings += value;
          break;
        case 'borrowed':
          totals.borrowed += -value;
          break;
        case 'repaid':
          totals.repaid += value;
          break;
        case 'interest':
          totals.interest += value;
          break;
        case 'fees':
          totals.fees += value;
          break;
        case 'sponsor_called':
          totals.sponsorCalled += value;
          break;
        case 'investor':
          totals.investor += value;
          break;
        default:
          break;
      }
    }

    const kind = classify(accounts, amount);
    runningTotal += amount;
    rows.push({
      entryId: entry.id,
      date: entry.date,
      narration: entry.narration,
      reference: entry.reference,
      amount,
      kind,
      accounts,
      loanIds,
      voided: entry.voided === true,
      reversalOf: entry.reversalOf ?? null,
      reversedBy: entry.reversedBy ?? null,
      runningTotal,
    });
  }

  totals.net = runningTotal;

  return {
    memberId,
    from: from ?? null,
    to: to ?? null,
    rows,
    totals,
    paidIn: sum(rows.filter((row) => row.amount > 0).map((row) => row.amount)),
    paidOut: sum(rows.filter((row) => row.amount < 0).map((row) => -row.amount)),
  };
}

/**
 * Name a movement the way the member would.
 *
 * Loans receivable is the one account that means two different things
 * depending on direction: money going out to them is borrowing, money coming
 * back is a repayment. Everything else reads the same both ways.
 */
function classify(accounts: AccountCode[], amount: Money): MemberFlowKind {
  if (accounts.includes('LOANS_RECEIVABLE')) {
    return amount < 0 ? 'borrowed' : 'repaid';
  }
  for (const account of accounts) {
    const kind = KIND_OF[account];
    if (kind) return kind;
  }
  return 'other';
}
