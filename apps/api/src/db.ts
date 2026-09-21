/**
 * Storage.
 *
 * SQLite through Node's own `node:sqlite`, so the whole platform runs with no
 * native build step and no database server. A circle of thirty members
 * generates a few thousand rows a year; the constraint that matters is not
 * throughput but that a treasurer can copy the file onto a USB stick and hand
 * it to the next treasurer.
 *
 * Two rules the schema enforces rather than trusts:
 *   - money columns are INTEGER shillings, never REAL;
 *   - journal lines cascade from their entry, and nothing else cascades at
 *     all, because financial history must not disappear when a row upstream
 *     is tidied away.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

export interface DbOptions {
  /** File path, or `:memory:` for tests. */
  location?: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS circle_config (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  config_json  TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id                   TEXT PRIMARY KEY,
  full_name            TEXT    NOT NULL,
  phone                TEXT    NOT NULL UNIQUE,
  email                TEXT,
  national_id          TEXT,
  role                 TEXT    NOT NULL DEFAULT 'member'
                         CHECK (role IN ('member','cashier','secretary','chair')),
  password_hash        TEXT    NOT NULL,
  joined_on            TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('pending','active','suspended','exited')),
  suspended_reason     TEXT,
  annual_fee_paid_on   TEXT,
  created_at           TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);

-- Every movement of shares. The register is derived from this, never stored
-- as a mutable balance, so the register can always be rebuilt from history.
CREATE TABLE IF NOT EXISTS share_transactions (
  id           TEXT PRIMARY KEY,
  member_id    TEXT    NOT NULL REFERENCES members(id),
  kind         TEXT    NOT NULL,
  shares       INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  occurred_on  TEXT    NOT NULL,
  narration    TEXT,
  loan_id      TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_tx_member ON share_transactions(member_id);

CREATE TABLE IF NOT EXISTS contributions (
  id           TEXT PRIMARY KEY,
  member_id    TEXT    NOT NULL REFERENCES members(id),
  period       TEXT    NOT NULL,           -- YYYY-MM
  amount       INTEGER NOT NULL,
  paid_on      TEXT    NOT NULL,
  reference    TEXT,
  recorded_by  TEXT    NOT NULL REFERENCES members(id),
  created_at   TEXT    NOT NULL,
  UNIQUE (member_id, period)
);

CREATE TABLE IF NOT EXISTS fees (
  id           TEXT PRIMARY KEY,
  member_id    TEXT    NOT NULL REFERENCES members(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('joining','annual','penalty','other')),
  amount       INTEGER NOT NULL,
  paid_on      TEXT    NOT NULL,
  period       TEXT,
  reference    TEXT,
  created_at   TEXT    NOT NULL
);

-- External capital. A liability of the circle, never equity.
CREATE TABLE IF NOT EXISTS facilities (
  id                 TEXT PRIMARY KEY,
  investor_member_id TEXT    NOT NULL REFERENCES members(id),
  principal          INTEGER NOT NULL CHECK (principal > 0),
  monthly_rate       REAL    NOT NULL,
  seniority          INTEGER NOT NULL DEFAULT 0,
  funded_on          TEXT    NOT NULL,
  committed_until    TEXT,
  repaid_principal   INTEGER NOT NULL DEFAULT 0,
  paid_interest      INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','repaid','cancelled')),
  note               TEXT,
  created_at         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id                TEXT PRIMARY KEY,
  member_id         TEXT    NOT NULL REFERENCES members(id),
  product           TEXT    NOT NULL CHECK (product IN ('term','short_term')),
  principal         INTEGER NOT NULL CHECK (principal > 0),
  purpose           TEXT,
  status            TEXT    NOT NULL
                      CHECK (status IN ('draft','awaiting_sponsors','awaiting_capital',
                                        'needs_authorisation','approved','disbursed',
                                        'settled','defaulted','declined','cancelled')),
  -- Term-loan pricing
  monthly_rate      REAL,
  term_months       INTEGER,
  principal_step    REAL,
  -- Short-term pricing
  flat_rate         REAL,
  term_days         INTEGER,
  coverage_ratio    REAL    NOT NULL,
  applied_on        TEXT    NOT NULL,
  approved_on       TEXT,
  disbursed_on      TEXT,
  maturity_on       TEXT,
  settled_on        TEXT,
  defaulted_on      TEXT,
  -- The schedule is frozen at disbursement: what the member agreed to cannot
  -- drift because a config value changed afterwards.
  schedule_json     TEXT,
  disbursed_by      TEXT REFERENCES members(id),
  decline_reason    TEXT,
  created_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);

CREATE TABLE IF NOT EXISTS pledges (
  id            TEXT PRIMARY KEY,
  loan_id       TEXT    NOT NULL REFERENCES loans(id),
  sponsor_id    TEXT    NOT NULL REFERENCES members(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  status        TEXT    NOT NULL
                  CHECK (status IN ('pending','accepted','declined','expired','withdrawn','called')),
  requested_on  TEXT    NOT NULL,
  responded_on  TEXT,
  expires_on    TEXT    NOT NULL,
  note          TEXT,
  created_at    TEXT    NOT NULL,
  UNIQUE (loan_id, sponsor_id)
);

CREATE INDEX IF NOT EXISTS idx_pledges_sponsor ON pledges(sponsor_id, status);

CREATE TABLE IF NOT EXISTS repayments (
  id           TEXT PRIMARY KEY,
  loan_id      TEXT    NOT NULL REFERENCES loans(id),
  member_id    TEXT    NOT NULL REFERENCES members(id),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  paid_on      TEXT    NOT NULL,
  reference    TEXT,
  recorded_by  TEXT    NOT NULL REFERENCES members(id),
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repayments_loan ON repayments(loan_id);

-- The books. Append-only: corrections are reversals, never edits.
CREATE TABLE IF NOT EXISTS journal_entries (
  id           TEXT PRIMARY KEY,
  entry_date   TEXT    NOT NULL,
  narration    TEXT    NOT NULL,
  reference    TEXT,
  reversal_of  TEXT REFERENCES journal_entries(id),
  reversed_by  TEXT REFERENCES journal_entries(id),
  voided       INTEGER NOT NULL DEFAULT 0,
  posted_by    TEXT REFERENCES members(id),
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    TEXT    NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account     TEXT    NOT NULL,
  debit       INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  member_id   TEXT,
  loan_id     TEXT,
  facility_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_member ON journal_lines(member_id);

-- A reading of the book each time money moved, so investor returns are
-- accrued against what actually happened rather than a month-end estimate.
CREATE TABLE IF NOT EXISTS book_snapshots (
  snapshot_date        TEXT PRIMARY KEY,
  equity_pool          INTEGER NOT NULL,
  outstanding_deployed INTEGER NOT NULL,
  created_at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('delete','void_financial_record')),
  entity_type  TEXT    NOT NULL,
  entity_id    TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  proposed_by  TEXT    NOT NULL REFERENCES members(id),
  opened_on    TEXT    NOT NULL,
  closes_on    TEXT    NOT NULL,
  status       TEXT    NOT NULL
                 CHECK (status IN ('open','passed','rejected','expired','executed','withdrawn')),
  executed_on  TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS votes (
  proposal_id  TEXT    NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  member_id    TEXT    NOT NULL REFERENCES members(id),
  choice       TEXT    NOT NULL CHECK (choice IN ('for','against','abstain')),
  cast_on      TEXT    NOT NULL,
  weight       INTEGER NOT NULL,
  reason       TEXT,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (proposal_id, member_id)
);

-- Records deleted by resolution are kept here rather than vanishing, so the
-- circle can always answer "what was removed, and who agreed to it".
CREATE TABLE IF NOT EXISTS deleted_records (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT    NOT NULL,
  entity_id    TEXT    NOT NULL,
  proposal_id  TEXT    NOT NULL REFERENCES proposals(id),
  snapshot     TEXT    NOT NULL,
  deleted_on   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  posted_by   TEXT NOT NULL REFERENCES members(id),
  posted_on   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  member_id   TEXT    NOT NULL REFERENCES members(id),
  kind        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  payload     TEXT,
  action_url  TEXT,
  read_at     TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id, read_at);

-- Money arriving through a payment rail.
--
-- The idempotency_key column is the whole point of this table: a USSD push
-- that the handset retries, or a webhook the provider delivers twice, must
-- never produce two charges or two ledger postings. The unique index makes a
-- repeat a no-op at the storage layer rather than something every handler has
-- to remember to guard.
CREATE TABLE IF NOT EXISTS payment_intents (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  purpose          TEXT    NOT NULL
                     CHECK (purpose IN ('loan_application_fee','platform_subscription',
                                        'contribution','membership_fee','loan_repayment')),
  member_id        TEXT    NOT NULL REFERENCES members(id),
  loan_id          TEXT REFERENCES loans(id),
  -- What the member pays, what the rail keeps, what reaches the recipient.
  gross_amount     INTEGER NOT NULL CHECK (gross_amount > 0),
  fee_amount       INTEGER NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  net_amount       INTEGER NOT NULL CHECK (net_amount >= 0),
  -- Who ends up with the net: the circle, or the platform operator.
  beneficiary      TEXT    NOT NULL CHECK (beneficiary IN ('circle','operator')),
  provider         TEXT    NOT NULL,
  provider_ref     TEXT,
  status           TEXT    NOT NULL
                     CHECK (status IN ('pending','initiated','confirmed','failed','expired','refunded')),
  -- Subscription payments name the month they cover.
  period           TEXT,
  failure_reason   TEXT,
  -- Manual payments carry the cashier's evidence instead of a provider ref.
  proof_reference  TEXT,
  recorded_by      TEXT REFERENCES members(id),
  -- Set once the confirmation has posted, so it can never post a second time.
  ledger_entry_id  TEXT REFERENCES journal_entries(id),
  refund_entry_id  TEXT REFERENCES journal_entries(id),
  created_at       TEXT    NOT NULL,
  initiated_at     TEXT,
  confirmed_at     TEXT,
  settled_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_member ON payment_intents(member_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_loan ON payment_intents(loan_id, purpose, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ref
  ON payment_intents(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- A member's platform subscription, month by month.
--
-- Deliberately not in the ledger: this is the operator's revenue, and the
-- circle is not a party to it. Recording it in the circle's books would
-- overstate what the circle earns.
CREATE TABLE IF NOT EXISTS platform_subscriptions (
  id          TEXT PRIMARY KEY,
  member_id   TEXT    NOT NULL REFERENCES members(id),
  period      TEXT    NOT NULL,              -- YYYY-MM
  amount      INTEGER NOT NULL,
  paid_on     TEXT    NOT NULL,
  payment_id  TEXT REFERENCES payment_intents(id),
  created_at  TEXT    NOT NULL,
  UNIQUE (member_id, period)
);

-- Every automated approval decision, with the checks that produced it.
--
-- Written whether the loan was approved or not: a member refused by a rule is
-- owed the same explanation as one approved by it, and a decision nobody can
-- reconstruct is indistinguishable from an opinion.
CREATE TABLE IF NOT EXISTS loan_decisions (
  id             TEXT PRIMARY KEY,
  loan_id        TEXT    NOT NULL REFERENCES loans(id),
  outcome        TEXT    NOT NULL,
  headline       TEXT    NOT NULL,
  -- The full gate list as assessed, so the decision can be read back exactly
  -- as it was made rather than re-derived against today's rules.
  checks_json    TEXT    NOT NULL,
  policy_version TEXT    NOT NULL,
  assessed_on    TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_loan ON loan_decisions(loan_id);

-- Exceptions a person authorised, against a named gate.
--
-- An exception with nobody's name on it is not an exception, it is a hole.
CREATE TABLE IF NOT EXISTS loan_authorisations (
  id             TEXT PRIMARY KEY,
  loan_id        TEXT    NOT NULL REFERENCES loans(id),
  gate           TEXT    NOT NULL,
  authorised_by  TEXT    NOT NULL REFERENCES members(id),
  authorised_on  TEXT    NOT NULL,
  reason         TEXT    NOT NULL,
  revoked_on     TEXT,
  created_at     TEXT    NOT NULL,
  UNIQUE (loan_id, gate)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
`;

/** Open (and if needed create) the circle's database. */
export function openDb(options: DbOptions = {}): Db {
  const location = options.location ?? process.env.MAMOGORO_DB ?? './data/mamogoro.db';

  if (location !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true });
  }

  const db = new DatabaseSync(location);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Bring an existing database up to the current schema.
 *
 * SQLite cannot alter a CHECK constraint in place, so widening the set of
 * loan statuses means rebuilding the table. Detected from the stored DDL
 * rather than a version counter, so a database that has already been rebuilt
 * is left alone and the check is free on every subsequent open.
 */
function migrate(db: Db): void {
  const loans = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'loans'")
    .get() as unknown as { sql: string } | undefined;

  if (!loans || loans.sql.includes('awaiting_capital')) return;

  // The approval gate introduced two states between "covered" and "approved".
  // Older databases predate them and would reject the UPDATE at runtime.
  const widened = loans.sql.replace(
    /CHECK \(status IN \([^)]*\)\)/,
    "CHECK (status IN ('draft','awaiting_sponsors','awaiting_capital'," +
      "'needs_authorisation','approved','disbursed','settled','defaulted'," +
      "'declined','cancelled'))",
  );

  db.exec('PRAGMA foreign_keys = OFF');
  transact(db, () => {
    db.exec(widened.replace('CREATE TABLE loans', 'CREATE TABLE loans_migrated'));
    db.exec('INSERT INTO loans_migrated SELECT * FROM loans');
    db.exec('DROP TABLE loans');
    db.exec('ALTER TABLE loans_migrated RENAME TO loans');
    db.exec('CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status)');
  });
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Run `work` inside a transaction, rolling back if it throws.
 *
 * Disbursing a loan touches loans, journal entries, journal lines,
 * notifications and the snapshot table. Half of that landing would leave the
 * books unbalanced, so every multi-table operation goes through here.
 */
export function transact<T>(db: Db, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the one worth surfacing.
    }
    throw error;
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}

let counter = 0;

/** Short, sortable, human-quotable id: `loan_m9x2f1_7`. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 100_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}`;
}
