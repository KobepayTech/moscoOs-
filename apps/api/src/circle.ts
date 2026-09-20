/**
 * The bridge between storage and the domain engine.
 *
 * `@mamogoro/core` is pure and holds no state, so everything it reasons about
 * has to be rebuilt from the tables on each request. That is deliberate: the
 * share register, the ledger and every loan's position are *derived* from the
 * recorded history, never stored as mutable balances that could drift away
 * from the transactions that produced them.
 *
 * A circle this size rebuilds in microseconds. If it ever stopped being fast
 * enough, the fix would be a cache keyed on the last transaction id — not a
 * stored balance.
 */

import {
  type BookSnapshot,
  type CircleConfig,
  type Facility,
  type LoanState,
  type Money,
  type Pledge,
  type ShareRegister,
  type ShortTermLoan,
  type SponsorshipRequest,
  type TermLoanSchedule,
  type Book,
  applyRepayments,
  assertValidConfig,
  buildShortTermLoan,
  buildTermLoanSchedule,
  createBook,
  createRegister,
  defaultCircleConfig,
  deployedPrincipal,
  issuedCapital,
  lendingHeadroom,
  mergeConfig,
  postEntry,
  selfCoverFor,
  sharesOf,
  shortTermLoanState,
  totalPledgedOut,
  today,
} from '@mamogoro/core';

import { type Db, newId, nowISO } from './db.js';
import { ApiError } from './http.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function loadConfig(db: Db): CircleConfig {
  const row = db.prepare('SELECT config_json FROM circle_config WHERE id = 1').get() as
    | { config_json: string }
    | undefined;

  if (!row) return defaultCircleConfig();

  try {
    return assertValidConfig(mergeConfig(defaultCircleConfig(), JSON.parse(row.config_json)));
  } catch (error) {
    throw new Error(`Stored circle configuration is invalid: ${(error as Error).message}`);
  }
}

export function saveConfig(db: Db, config: CircleConfig): CircleConfig {
  assertValidConfig(config);
  db.prepare(
    `INSERT INTO circle_config (id, config_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(config), nowISO());
  return config;
}

// ---------------------------------------------------------------------------
// The share register
// ---------------------------------------------------------------------------

interface ShareTxRow {
  id: string;
  member_id: string;
  kind: string;
  shares: number;
  amount: number;
  occurred_on: string;
  narration: string | null;
  loan_id: string | null;
}

/**
 * Rebuild the register by replaying every share movement in order.
 *
 * Replay rather than `subscribe()` because the recorded history is the
 * authority: a subscription that was valid when it was made must not start
 * failing because a later config change tightened the holding ceiling.
 */
export function buildRegister(db: Db, config: CircleConfig, asOf?: string): ShareRegister {
  const register = createRegister(config);

  const rows = (
    asOf
      ? db
          .prepare('SELECT * FROM share_transactions WHERE occurred_on <= ? ORDER BY occurred_on, rowid')
          .all(asOf)
      : db.prepare('SELECT * FROM share_transactions ORDER BY occurred_on, rowid').all()
  ) as unknown as ShareTxRow[];

  for (const row of rows) {
    const held = register.holdings.get(row.member_id) ?? 0;
    const after = held + row.shares;

    register.holdings.set(row.member_id, after < 0 ? 0 : after);

    if (row.shares < 0) {
      register.treasury += -row.shares;
    } else {
      register.treasury = Math.max(0, register.treasury - row.shares);
    }

    register.transactions.push({
      id: row.id,
      memberId: row.member_id,
      kind: row.kind as ShareTxRow['kind'] as never,
      shares: row.shares,
      amount: row.amount,
      occurredOn: row.occurred_on,
      narration: row.narration ?? undefined,
      relatedLoanId: row.loan_id ?? undefined,
    });
  }

  return register;
}

export function recordShareMovement(
  db: Db,
  input: {
    memberId: string;
    kind: string;
    shares: number;
    amount: Money;
    occurredOn: string;
    narration?: string;
    loanId?: string;
  },
): string {
  const id = newId('shr');
  db.prepare(
    `INSERT INTO share_transactions
       (id, member_id, kind, shares, amount, occurred_on, narration, loan_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.memberId,
    input.kind,
    input.shares,
    input.amount,
    input.occurredOn,
    input.narration ?? null,
    input.loanId ?? null,
    nowISO(),
  );
  return id;
}

// ---------------------------------------------------------------------------
// The books
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  entry_date: string;
  narration: string;
  reference: string | null;
  reversal_of: string | null;
  reversed_by: string | null;
  voided: number;
  posted_by: string | null;
}

interface LineRow {
  entry_id: string;
  account: string;
  debit: number;
  credit: number;
  member_id: string | null;
  loan_id: string | null;
  facility_id: string | null;
}

/** Rebuild the ledger from the journal tables. */
export function buildBook(db: Db, asOf?: string): Book {
  const book = createBook();

  const entries = (
    asOf
      ? db.prepare('SELECT * FROM journal_entries WHERE entry_date <= ? ORDER BY entry_date, rowid').all(asOf)
      : db.prepare('SELECT * FROM journal_entries ORDER BY entry_date, rowid').all()
  ) as unknown as EntryRow[];

  const lines = db
    .prepare('SELECT * FROM journal_lines ORDER BY id')
    .all() as unknown as LineRow[];

  const linesByEntry = new Map<string, LineRow[]>();
  for (const line of lines) {
    const bucket = linesByEntry.get(line.entry_id);
    if (bucket) bucket.push(line);
    else linesByEntry.set(line.entry_id, [line]);
  }

  for (const entry of entries) {
    book.entries.push({
      id: entry.id,
      date: entry.entry_date,
      narration: entry.narration,
      reference: entry.reference ?? undefined,
      reversalOf: entry.reversal_of,
      reversedBy: entry.reversed_by,
      voided: entry.voided === 1,
      postedBy: entry.posted_by ?? undefined,
      lines: (linesByEntry.get(entry.id) ?? []).map((line) => ({
        account: line.account as never,
        debit: line.debit,
        credit: line.credit,
        memberId: line.member_id ?? undefined,
        loanId: line.loan_id ?? undefined,
        facilityId: line.facility_id ?? undefined,
      })),
    });
    book.index.set(entry.id, book.entries[book.entries.length - 1]);
  }

  return book;
}

/**
 * Post a journal entry to storage.
 *
 * Validated through the core engine first, so an unbalanced entry can never
 * reach the database. The in-memory book passed in keeps the running state
 * consistent for callers posting several entries in one transaction.
 */
export function post(
  db: Db,
  book: Book,
  entry: Parameters<typeof postEntry>[1],
): void {
  postEntry(book, entry);

  db.prepare(
    `INSERT INTO journal_entries
       (id, entry_date, narration, reference, reversal_of, reversed_by, voided, posted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    entry.id,
    entry.date,
    entry.narration,
    entry.reference ?? null,
    entry.reversalOf ?? null,
    entry.reversedBy ?? null,
    entry.postedBy ?? null,
    nowISO(),
  );

  const insertLine = db.prepare(
    `INSERT INTO journal_lines (entry_id, account, debit, credit, member_id, loan_id, facility_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const line of entry.lines) {
    insertLine.run(
      entry.id,
      line.account,
      line.debit,
      line.credit,
      line.memberId ?? null,
      line.loanId ?? null,
      line.facilityId ?? null,
    );
  }
}

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

interface FacilityRow {
  id: string;
  investor_member_id: string;
  principal: number;
  monthly_rate: number;
  seniority: number;
  funded_on: string;
  committed_until: string | null;
  repaid_principal: number;
  paid_interest: number;
  status: string;
}

export function loadFacilities(db: Db): Facility[] {
  const rows = db
    .prepare('SELECT * FROM facilities ORDER BY seniority, funded_on, id')
    .all() as unknown as FacilityRow[];

  return rows.map((row) => ({
    id: row.id,
    investorMemberId: row.investor_member_id,
    principal: row.principal,
    monthlyRate: row.monthly_rate,
    seniority: row.seniority,
    fundedOn: row.funded_on,
    committedUntil: row.committed_until,
    repaidPrincipal: row.repaid_principal,
    paidInterest: row.paid_interest,
    status: row.status as Facility['status'],
  }));
}

/**
 * Readings of the book, one per day money moved.
 *
 * These are what the investor's return is accrued against. They are written at
 * the moment of each disbursement and repayment, so the accrual reflects what
 * the circle actually did rather than a reconstruction after the fact.
 */
export function loadSnapshots(db: Db): BookSnapshot[] {
  const rows = db
    .prepare('SELECT snapshot_date, equity_pool, outstanding_deployed FROM book_snapshots ORDER BY snapshot_date')
    .all() as unknown as { snapshot_date: string; equity_pool: number; outstanding_deployed: number }[];

  return rows.map((row) => ({
    date: row.snapshot_date,
    equityPool: row.equity_pool,
    outstandingDeployed: row.outstanding_deployed,
  }));
}

/** Record where the book stands today, after money has moved. */
export function writeSnapshot(db: Db, config: CircleConfig, onDate: string): void {
  const register = buildRegister(db, config, onDate);
  const book = buildBook(db, onDate);

  db.prepare(
    `INSERT INTO book_snapshots (snapshot_date, equity_pool, outstanding_deployed, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(snapshot_date) DO UPDATE SET
       equity_pool = excluded.equity_pool,
       outstanding_deployed = excluded.outstanding_deployed`,
  ).run(onDate, issuedCapital(register), deployedPrincipal(book, onDate), nowISO());
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export interface LoanRow {
  id: string;
  member_id: string;
  product: 'term' | 'short_term';
  principal: number;
  purpose: string | null;
  status: string;
  monthly_rate: number | null;
  term_months: number | null;
  principal_step: number | null;
  flat_rate: number | null;
  term_days: number | null;
  coverage_ratio: number;
  applied_on: string;
  approved_on: string | null;
  disbursed_on: string | null;
  maturity_on: string | null;
  settled_on: string | null;
  defaulted_on: string | null;
  schedule_json: string | null;
  disbursed_by: string | null;
  decline_reason: string | null;
}

export function loadLoan(db: Db, loanId: string): LoanRow {
  const row = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as unknown as LoanRow | undefined;
  if (!row) throw ApiError.notFound(`No loan with id ${loanId}`);
  return row;
}

export function loadRepayments(db: Db, loanId: string) {
  return (
    db
      .prepare('SELECT id, amount, paid_on, reference FROM repayments WHERE loan_id = ? ORDER BY paid_on, rowid')
      .all(loanId) as unknown as { id: string; amount: number; paid_on: string; reference: string | null }[]
  ).map((row) => ({
    id: row.id,
    amount: row.amount,
    paidOn: row.paid_on,
    reference: row.reference ?? undefined,
  }));
}

/**
 * Rebuild a term loan's frozen schedule.
 *
 * Read back from `schedule_json` once disbursed, so a later change to the
 * circle's rate cannot rewrite what an existing borrower agreed to. Before
 * disbursement there is nothing frozen yet, so it is projected from current
 * pricing — which is exactly what an applicant should be quoted.
 */
export function scheduleFor(db: Db, config: CircleConfig, loan: LoanRow): TermLoanSchedule {
  if (loan.product !== 'term') {
    throw ApiError.badRequest(`Loan ${loan.id} is a short-term loan and has no instalment schedule`);
  }

  if (loan.schedule_json) {
    return JSON.parse(loan.schedule_json) as TermLoanSchedule;
  }

  return buildTermLoanSchedule({
    principal: loan.principal,
    monthlyInterestRate: loan.monthly_rate ?? config.termLoan.monthlyInterestRate,
    termMonths: loan.term_months ?? config.termLoan.defaultTermMonths,
    minimumMonthlyPrincipalRate: loan.principal_step ?? config.termLoan.minimumMonthlyPrincipalRate,
    disbursedOn: loan.disbursed_on ?? loan.applied_on,
    balloonGraceDays: config.termLoan.balloonGraceDays,
  });
}

export function shortTermFor(db: Db, config: CircleConfig, loan: LoanRow): ShortTermLoan {
  if (loan.product !== 'short_term') {
    throw ApiError.badRequest(`Loan ${loan.id} is not a short-term loan`);
  }

  if (loan.schedule_json) {
    return JSON.parse(loan.schedule_json) as ShortTermLoan;
  }

  return buildShortTermLoan({
    principal: loan.principal,
    flatRate: loan.flat_rate ?? config.shortTermLoan.flatRate,
    days: loan.term_days ?? config.shortTermLoan.maxDays,
    disbursedOn: loan.disbursed_on ?? loan.applied_on,
    mode: config.shortTermLoan.interestMode,
    minimumFee: config.shortTermLoan.minimumFee,
  });
}

/** Where a loan stands as at a date, whichever product it is. */
export function loanPosition(db: Db, config: CircleConfig, loan: LoanRow, asOf = today()) {
  const repayments = loadRepayments(db, loan.id);

  if (loan.product === 'term') {
    const schedule = scheduleFor(db, config, loan);
    const state = applyRepayments(schedule, repayments, {
      asOf,
      penaltyMonthlyRate: config.termLoan.penaltyMonthlyRate,
      accrualBasisDays: config.facility.accrualBasisDays,
    });
    return { product: 'term' as const, schedule, state, repayments };
  }

  const loan_ = shortTermFor(db, config, loan);
  const state = shortTermLoanState(loan_, repayments, {
    asOf,
    dailyPenaltyRate: config.shortTermLoan.dailyPenaltyRate,
  });
  return { product: 'short_term' as const, loan: loan_, state, repayments };
}

/** Principal a member currently owes across every live loan. */
export function memberOutstandingPrincipal(db: Db, config: CircleConfig, memberId: string, asOf = today()): Money {
  const loans = db
    .prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('disbursed','defaulted')")
    .all(memberId) as unknown as LoanRow[];

  let total = 0;
  for (const loan of loans) {
    const position = loanPosition(db, config, loan, asOf);
    total +=
      position.product === 'term'
        ? (position.state as LoanState).principalOutstanding
        : position.state.outstanding;
  }
  return total;
}

/** Principal out on loan across the whole circle. */
export function totalDeployed(db: Db, asOf = today()): Money {
  return deployedPrincipal(buildBook(db, asOf), asOf);
}

export function headroom(db: Db, config: CircleConfig, asOf = today()) {
  const register = buildRegister(db, config, asOf);
  return lendingHeadroom(config, issuedCapital(register), totalDeployed(db, asOf), loadFacilities(db), asOf);
}

// ---------------------------------------------------------------------------
// Sponsorship
// ---------------------------------------------------------------------------

interface PledgeRow {
  id: string;
  loan_id: string;
  sponsor_id: string;
  amount: number;
  status: string;
  requested_on: string;
  responded_on: string | null;
  expires_on: string;
  note: string | null;
}

function toPledge(row: PledgeRow): Pledge {
  return {
    id: row.id,
    loanId: row.loan_id,
    sponsorId: row.sponsor_id,
    amount: row.amount,
    status: row.status as Pledge['status'],
    requestedOn: row.requested_on,
    respondedOn: row.responded_on,
    expiresOn: row.expires_on,
    note: row.note ?? undefined,
  };
}

export function loadPledges(db: Db, loanId: string): Pledge[] {
  const rows = db
    .prepare('SELECT * FROM pledges WHERE loan_id = ? ORDER BY requested_on, rowid')
    .all(loanId) as unknown as PledgeRow[];
  return rows.map(toPledge);
}

/** Every live pledge a member has made across all loans. */
export function loadPledgesBySponsor(db: Db, sponsorId: string): Pledge[] {
  const rows = db
    .prepare('SELECT * FROM pledges WHERE sponsor_id = ? ORDER BY requested_on DESC, rowid DESC')
    .all(sponsorId) as unknown as PledgeRow[];
  return rows.map(toPledge);
}

export function sponsorshipRequestFor(db: Db, loan: LoanRow): SponsorshipRequest {
  return {
    loanId: loan.id,
    borrowerId: loan.member_id,
    principal: loan.principal,
    coverageRatio: loan.coverage_ratio,
    openedOn: loan.applied_on,
    pledges: loadPledges(db, loan.id),
  };
}

/** Cover a borrower brings from their own uncommitted shares. */
export function selfCoverForMember(db: Db, config: CircleConfig, memberId: string, asOf = today()): Money {
  const register = buildRegister(db, config, asOf);
  const pledgedOut = totalPledgedOut(loadPledgesBySponsor(db, memberId), memberId);
  const owed = memberOutstandingPrincipal(db, config, memberId, asOf);
  return selfCoverFor(config, register, memberId, pledgedOut, owed);
}

/**
 * A member's exposure, as the sponsorship engine wants it.
 *
 * `excludePledgeId` leaves one pledge out of the "already committed" figure.
 * That matters when re-checking a sponsor at the moment they accept: the
 * pending pledge they are answering is itself in the table, and counting it
 * against their own capacity would make every acceptance fail.
 */
export function exposureOf(
  db: Db,
  config: CircleConfig,
  memberId: string,
  asOf = today(),
  options: { excludePledgeId?: string } = {},
) {
  const register = buildRegister(db, config, asOf);
  const pledges = loadPledgesBySponsor(db, memberId).filter(
    (pledge) => pledge.id !== options.excludePledgeId,
  );

  return {
    memberId,
    sharesOwned: sharesOf(register, memberId),
    pledgedOut: totalPledgedOut(pledges, memberId),
    ownOutstandingPrincipal: memberOutstandingPrincipal(db, config, memberId, asOf),
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function notify(
  db: Db,
  input: {
    memberId: string;
    kind: string;
    title: string;
    body: string;
    payload?: unknown;
    actionUrl?: string;
  },
): string {
  const id = newId('ntf');
  db.prepare(
    `INSERT INTO notifications (id, member_id, kind, title, body, payload, action_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.memberId,
    input.kind,
    input.title,
    input.body,
    input.payload ? JSON.stringify(input.payload) : null,
    input.actionUrl ?? null,
    nowISO(),
  );
  return id;
}

/** Notify every active member except those named. */
export function notifyCircle(
  db: Db,
  input: { kind: string; title: string; body: string; exclude?: string[]; actionUrl?: string },
): void {
  const excluded = new Set(input.exclude ?? []);
  const members = db
    .prepare("SELECT id FROM members WHERE status = 'active'")
    .all() as unknown as { id: string }[];

  for (const member of members) {
    if (excluded.has(member.id)) continue;
    notify(db, { ...input, memberId: member.id });
  }
}

export function audit(
  db: Db,
  input: { actorId?: string; action: string; entityType?: string; entityId?: string; detail?: unknown },
): void {
  db.prepare(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.actorId ?? null,
    input.action,
    input.entityType ?? null,
    input.entityId ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
    nowISO(),
  );
}
