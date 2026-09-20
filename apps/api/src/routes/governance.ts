/**
 * Governance: the ledger, and deletion by vote.
 *
 * Every member can read every movement of money — that is what makes a circle
 * a circle rather than a cashier with a notebook. And every member can propose
 * that a record be removed, but nobody can remove one alone.
 *
 * The one thing a majority cannot do is erase the books. A vote against a
 * posted entry produces a balancing reversal and marks the original void; the
 * original stays visible, with the resolution that voided it attached. A
 * circle whose history can be rewritten by whoever holds the votes this week
 * has no history at all.
 */

import {
  castVote,
  deletionMode,
  financialPosition,
  incomeStatement,
  ledgerView,
  openProposal,
  resolveProposal,
  summariseProposal,
  tallyVotes,
  today,
  trialBalance,
  voidEntryByResolution,
  type DeletionProposal,
  type Vote,
} from '@mamogoro/core';

import {
  audit,
  buildBook,
  buildRegister,
  loadConfig,
  notify,
  notifyCircle,
} from '../circle.js';
import { type Db, newId, nowISO, transact } from '../db.js';
import { ApiError, type Router, enumField, str } from '../http.js';
import { findMember } from './members.js';

interface ProposalRow {
  id: string;
  kind: 'delete' | 'void_financial_record';
  entity_type: string;
  entity_id: string;
  reason: string;
  proposed_by: string;
  opened_on: string;
  closes_on: string;
  status: string;
  executed_on: string | null;
}

function toProposal(db: Db, row: ProposalRow): DeletionProposal {
  const votes = db
    .prepare('SELECT * FROM votes WHERE proposal_id = ? ORDER BY cast_on DESC, rowid DESC')
    .all(row.id) as unknown as {
    member_id: string;
    choice: Vote['choice'];
    cast_on: string;
    weight: number;
    reason: string | null;
  }[];

  return {
    id: row.id,
    kind: row.kind,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    proposedBy: row.proposed_by,
    openedOn: row.opened_on,
    closesOn: row.closes_on,
    status: row.status as DeletionProposal['status'],
    executedOn: row.executed_on,
    votes: votes.map((vote) => ({
      memberId: vote.member_id,
      choice: vote.choice,
      castOn: vote.cast_on,
      weight: vote.weight,
      reason: vote.reason ?? undefined,
    })),
  };
}

function loadProposal(db: Db, id: string): { row: ProposalRow; proposal: DeletionProposal } {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as unknown as
    | ProposalRow
    | undefined;
  if (!row) throw ApiError.notFound(`No proposal with id ${id}`);
  return { row, proposal: toProposal(db, row) };
}

/** Tables a passed `delete` proposal is allowed to act on. */
const DELETABLE_TABLES: Record<string, string> = {
  announcement: 'announcements',
  sponsorship_request: 'pledges',
  loan_application: 'loans',
  member_profile: 'members',
};

export function registerGovernanceRoutes(router: Router, db: Db): void {
  // -------------------------------------------------------------------------
  // The public ledger
  // -------------------------------------------------------------------------

  router.get('/ledger', ({ query }) => {
    const asOf = query.get('asOf') ?? undefined;
    const memberId = query.get('memberId') ?? undefined;
    const book = buildBook(db, asOf);

    return {
      asOf: asOf ?? today(),
      entries: ledgerView(book, { asOf, memberId }),
      position: financialPosition(book, asOf),
      trialBalance: trialBalance(book, asOf),
    };
  });

  router.get('/ledger/:entryId', ({ params }) => {
    const book = buildBook(db);
    const entry = book.index.get(params.entryId);
    if (!entry) throw ApiError.notFound(`No ledger entry with id ${params.entryId}`);
    return entry;
  });

  router.get('/reports/income', ({ query }) => {
    const book = buildBook(db);
    return incomeStatement(book, query.get('from') ?? undefined, query.get('to') ?? undefined);
  });

  router.get('/reports/position', ({ query }) => {
    const asOf = query.get('asOf') ?? undefined;
    const book = buildBook(db, asOf);
    const balance = trialBalance(book, asOf);

    return {
      position: financialPosition(book, asOf),
      trialBalance: balance,
      // Surfaced rather than asserted: if this ever goes false the circle
      // needs to know immediately, not when someone next runs a report.
      booksBalance: balance.balanced,
    };
  });

  // -------------------------------------------------------------------------
  // Announcements — the simplest deletable record, and a worked example
  // -------------------------------------------------------------------------

  router.get('/announcements', () => {
    const rows = db
      .prepare('SELECT * FROM announcements ORDER BY posted_on DESC, rowid DESC')
      .all() as unknown as {
      id: string;
      title: string;
      body: string;
      posted_by: string;
      posted_on: string;
    }[];

    return {
      announcements: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        postedBy: row.posted_by,
        postedByName: findMember(db, row.posted_by).full_name,
        postedOn: row.posted_on,
      })),
    };
  });

  router.post('/announcements', ({ body, principal }) => {
    const title = str(body, 'title', { max: 160 });
    const text = str(body, 'body', { max: 4000 });
    const id = newId('ann');

    db.prepare(
      'INSERT INTO announcements (id, title, body, posted_by, posted_on, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, title, text, principal!.memberId, today(), nowISO());

    notifyCircle(db, {
      kind: 'announcement',
      title,
      body: text.slice(0, 200),
      exclude: [principal!.memberId],
      actionUrl: '/announcements',
    });

    return { id, title };
  });

  // -------------------------------------------------------------------------
  // Deletion by vote
  // -------------------------------------------------------------------------

  /**
   * Propose that a record be removed.
   *
   * Any member may open one. The kind of proposal is decided by what is being
   * targeted, not by what the proposer asks for: point it at a ledger entry
   * and you get a void-and-reverse, whatever you intended.
   */
  router.post('/proposals', ({ body, principal }) => {
    const config = loadConfig(db);
    const entityType = str(body, 'entityType');
    const entityId = str(body, 'entityId');
    const reason = str(body, 'reason', { max: 1000 });

    const mode = deletionMode(config, entityType);
    if (!mode.allowed) throw ApiError.unprocessable(mode.reason);

    const existing = db
      .prepare("SELECT id FROM proposals WHERE entity_type = ? AND entity_id = ? AND status = 'open'")
      .get(entityType, entityId);
    if (existing) {
      throw ApiError.conflict('There is already an open proposal against that record');
    }

    const proposal = openProposal(config, {
      id: newId('prop'),
      entityType,
      entityId,
      reason,
      proposedBy: principal!.memberId,
      openedOn: today(),
    });

    db.prepare(
      `INSERT INTO proposals
         (id, kind, entity_type, entity_id, reason, proposed_by, opened_on, closes_on, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      proposal.id,
      proposal.kind,
      proposal.entityType,
      proposal.entityId,
      proposal.reason,
      proposal.proposedBy,
      proposal.openedOn,
      proposal.closesOn,
      nowISO(),
    );

    notifyCircle(db, {
      kind: 'proposal_opened',
      title: `${principal!.name} has proposed removing a ${entityType.replace(/_/g, ' ')}`,
      body:
        `${proposal.kind === 'void_financial_record' ? 'This is a financial record, so a successful vote ' +
          'reverses it and leaves it visible rather than deleting it. ' : ''}` +
        `Reason: ${reason} Voting closes ${proposal.closesOn}.`,
      exclude: [principal!.memberId],
      actionUrl: `/proposals/${proposal.id}`,
    });

    audit(db, {
      actorId: principal!.memberId,
      action: 'proposal_opened',
      entityType: 'proposal',
      entityId: proposal.id,
      detail: { targetType: entityType, targetId: entityId, kind: proposal.kind },
    });

    return proposal;
  });

  router.get('/proposals', ({ query }) => {
    const config = loadConfig(db);
    const register = buildRegister(db, config);
    const asOf = today();
    const status = query.get('status');

    const rows = (
      status
        ? db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY opened_on DESC').all(status)
        : db.prepare('SELECT * FROM proposals ORDER BY opened_on DESC').all()
    ) as unknown as ProposalRow[];

    return {
      proposals: rows.map((row) => {
        const proposal = toProposal(db, row);
        return {
          ...summariseProposal(proposal, config, register, asOf),
          proposedByName: findMember(db, proposal.proposedBy).full_name,
        };
      }),
    };
  });

  router.get('/proposals/:id', ({ params }) => {
    const config = loadConfig(db);
    const register = buildRegister(db, config);
    const { proposal } = loadProposal(db, params.id);

    return {
      ...summariseProposal(proposal, config, register, today()),
      proposedByName: findMember(db, proposal.proposedBy).full_name,
      votes: proposal.votes.map((vote) => ({
        ...vote,
        memberName: findMember(db, vote.memberId).full_name,
      })),
    };
  });

  /**
   * Vote.
   *
   * Weight is frozen at the moment of casting, so buying shares after a vote
   * has been cast cannot retroactively strengthen it.
   */
  router.post('/proposals/:id/votes', ({ params, body, principal }) => {
    const config = loadConfig(db);
    const register = buildRegister(db, config);
    const choice = enumField(body, 'choice', ['for', 'against', 'abstain'] as const);
    const reason = str(body, 'reason', { optional: true, max: 500 });
    const { proposal } = loadProposal(db, params.id);
    const castOn = today();

    const vote = castVote(proposal, config, register, {
      memberId: principal!.memberId,
      choice,
      castOn,
      reason: reason || undefined,
    });

    return transact(db, () => {
      db.prepare(
        `INSERT INTO votes (proposal_id, member_id, choice, cast_on, weight, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(proposal_id, member_id) DO UPDATE SET
           choice = excluded.choice, cast_on = excluded.cast_on,
           weight = excluded.weight, reason = excluded.reason`,
      ).run(proposal.id, vote.memberId, vote.choice, vote.castOn, vote.weight, vote.reason ?? null, nowISO());

      // Re-read and see whether the result is now settled; if it is, act on it
      // immediately rather than making members wait out the clock.
      const refreshed = toProposal(db, loadProposal(db, proposal.id).row);
      const outcome = resolveProposal(refreshed, config, register, castOn);

      if (outcome.action !== 'none') {
        executeProposal(db, refreshed, outcome.action, castOn, principal!.memberId);
      } else if (refreshed.status !== 'open') {
        db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(refreshed.status, refreshed.id);
      }

      audit(db, {
        actorId: principal!.memberId,
        action: 'vote_cast',
        entityType: 'proposal',
        entityId: proposal.id,
        detail: { choice, weight: vote.weight },
      });

      return {
        vote,
        tally: tallyVotes(refreshed, config, register, { asOf: castOn }),
        outcome: outcome.action,
      };
    });
  });

  /** Close out proposals whose voting window has passed. */
  router.post('/proposals/resolve-due', ({ principal }) => {
    const config = loadConfig(db);
    const register = buildRegister(db, config);
    const asOf = today();

    const rows = db
      .prepare("SELECT * FROM proposals WHERE status = 'open' AND closes_on < ?")
      .all(asOf) as unknown as ProposalRow[];

    const resolved: unknown[] = [];

    for (const row of rows) {
      const proposal = toProposal(db, row);
      const outcome = resolveProposal(proposal, config, register, asOf);

      if (outcome.action !== 'none') {
        executeProposal(db, proposal, outcome.action, asOf, principal!.memberId);
      } else {
        db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(proposal.status, proposal.id);
      }

      resolved.push({ id: proposal.id, status: proposal.status, action: outcome.action });
    }

    return { resolved };
  });
}

/**
 * Carry out a passed proposal.
 *
 * Deletion keeps a snapshot of what was removed, so "the circle voted this
 * away" never becomes "nobody can remember what it said". Voiding posts a
 * reversal and leaves the entry in place.
 */
function executeProposal(
  db: Db,
  proposal: DeletionProposal,
  action: 'delete' | 'void',
  asOf: string,
  actorId: string,
): void {
  if (action === 'void') {
    const book = buildBook(db);
    if (!book.index.has(proposal.entityId)) {
      throw ApiError.notFound(`Ledger entry ${proposal.entityId} no longer exists`);
    }

    const reversal = voidEntryByResolution(book, proposal.entityId, {
      id: newId('je'),
      date: asOf,
      proposalId: proposal.id,
      postedBy: actorId,
    });

    db.prepare(
      `INSERT INTO journal_entries
         (id, entry_date, narration, reference, reversal_of, voided, posted_by, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(reversal.id, reversal.date, reversal.narration, reversal.reference ?? null, proposal.entityId, actorId, nowISO());

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (entry_id, account, debit, credit, member_id, loan_id, facility_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const line of reversal.lines) {
      insertLine.run(
        reversal.id,
        line.account,
        line.debit,
        line.credit,
        line.memberId ?? null,
        line.loanId ?? null,
        line.facilityId ?? null,
      );
    }

    db.prepare('UPDATE journal_entries SET voided = 1, reversed_by = ? WHERE id = ?').run(
      reversal.id,
      proposal.entityId,
    );
  } else {
    const table = DELETABLE_TABLES[proposal.entityType];
    if (!table) {
      throw ApiError.unprocessable(
        `The circle voted to delete a ${proposal.entityType}, but this system does not know how to remove one`,
      );
    }

    const snapshot = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(proposal.entityId);
    if (snapshot) {
      db.prepare(
        `INSERT INTO deleted_records (id, entity_type, entity_id, proposal_id, snapshot, deleted_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('del'),
        proposal.entityType,
        proposal.entityId,
        proposal.id,
        JSON.stringify(snapshot),
        asOf,
        nowISO(),
      );

      // A member is never actually deleted: their share history has to remain
      // for the register to reconcile. They are marked as exited instead.
      if (table === 'members') {
        db.prepare("UPDATE members SET status = 'exited' WHERE id = ?").run(proposal.entityId);
      } else {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(proposal.entityId);
      }
    }
  }

  db.prepare("UPDATE proposals SET status = 'executed', executed_on = ? WHERE id = ?").run(asOf, proposal.id);

  notifyCircle(db, {
    kind: 'proposal_executed',
    title:
      action === 'void'
        ? `A ledger entry was reversed by resolution of the circle`
        : `A ${proposal.entityType.replace(/_/g, ' ')} was removed by resolution of the circle`,
    body:
      action === 'void'
        ? `Entry ${proposal.entityId} has been reversed and marked void. It remains visible in the ledger, ` +
          `with proposal ${proposal.id} attached.`
        : `Record ${proposal.entityId} was removed on ${asOf}. Reason given: ${proposal.reason}`,
    actionUrl: `/proposals/${proposal.id}`,
  });

  audit(db, {
    actorId,
    action: `proposal_${action}`,
    entityType: 'proposal',
    entityId: proposal.id,
    detail: { targetType: proposal.entityType, targetId: proposal.entityId },
  });
}
