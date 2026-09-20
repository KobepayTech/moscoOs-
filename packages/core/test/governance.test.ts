import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCircleConfig, mergeConfig } from '../src/config.js';
import { createRegister, subscribe } from '../src/shares.js';
import {
  castVote,
  deletionMode,
  GovernanceError,
  openProposal,
  resolveProposal,
  summariseProposal,
  tallyVotes,
  totalVotingWeight,
  votingWeight,
  type DeletionProposal,
} from '../src/governance.js';

const config = defaultCircleConfig();

function foundingRegister(memberCount = 30) {
  const register = createRegister(config);
  for (let i = 1; i <= memberCount; i += 1) {
    subscribe(register, config, { memberId: `mem_${i}`, shares: 50, occurredOn: '2026-01-01' });
  }
  return register;
}

function proposal(overrides: Partial<DeletionProposal> = {}): DeletionProposal {
  return openProposal(config, {
    id: 'prop_1',
    entityType: 'announcement',
    entityId: 'ann_9',
    reason: 'This announcement names the wrong meeting venue and is confusing members',
    proposedBy: 'mem_1',
    openedOn: '2026-03-01',
    ...overrides,
  });
}

describe('opening a proposal', () => {
  it('opens a plain deletion for an ordinary record', () => {
    const p = proposal();
    assert.equal(p.kind, 'delete');
    assert.equal(p.status, 'open');
    assert.equal(p.closesOn, '2026-03-04', '72 hours');
  });

  it('demands a reason a member can actually read', () => {
    assert.throws(
      () =>
        openProposal(config, {
          id: 'prop_2',
          entityType: 'announcement',
          entityId: 'ann_9',
          reason: 'bad',
          proposedBy: 'mem_1',
          openedOn: '2026-03-01',
        }),
      GovernanceError,
    );
  });

  it('refuses record types the circle never agreed could be removed', () => {
    assert.throws(
      () =>
        openProposal(config, {
          id: 'prop_3',
          entityType: 'member_password',
          entityId: 'x',
          reason: 'Trying to delete something that is not deletable',
          proposedBy: 'mem_1',
          openedOn: '2026-03-01',
        }),
      GovernanceError,
    );
  });
});

/**
 * The books are the one thing a majority cannot quietly erase. A vote against
 * a posted entry produces a reversal; the original stays visible.
 */
describe('financial records are never deleted, only reversed', () => {
  it('routes a ledger entry to a void-and-reverse proposal', () => {
    const mode = deletionMode(config, 'ledger_entry');
    assert.deepEqual(mode, { allowed: true, kind: 'void_financial_record' });

    const p = proposal({ id: 'prop_led', entityType: 'ledger_entry', entityId: 'je_12' });
    assert.equal(p.kind, 'void_financial_record');
  });

  it('does the same for repayments, share movements and facilities', () => {
    for (const entityType of ['loan_repayment', 'share_transaction', 'facility', 'contribution']) {
      assert.equal(deletionMode(config, entityType).allowed, true);
      assert.equal(
        (deletionMode(config, entityType) as { kind: string }).kind,
        'void_financial_record',
        entityType,
      );
    }
  });

  it('resolves to a void, not a delete, when the vote carries', () => {
    const register = foundingRegister();
    const p = proposal({ id: 'prop_led', entityType: 'ledger_entry', entityId: 'je_12' });

    for (let i = 1; i <= 25; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }

    const result = resolveProposal(p, config, register, '2026-03-05');
    assert.equal(result.action, 'void');
    assert.equal(p.status, 'executed');
  });

  it('can be switched off by a circle that wants hard deletes', () => {
    const permissive = mergeConfig(config, { governance: { financialRecordsAreImmutable: false } });
    assert.equal((deletionMode(permissive, 'ledger_entry') as { kind: string }).kind, 'delete');
  });
});

describe('voting weight', () => {
  it('follows shares by default', () => {
    const register = foundingRegister();
    subscribe(register, config, { memberId: 'mem_1', shares: 100, occurredOn: '2026-02-01' });

    assert.equal(votingWeight(config, register, 'mem_1'), 150);
    assert.equal(votingWeight(config, register, 'mem_2'), 50);
    assert.equal(totalVotingWeight(config, register), 1_600);
  });

  it('can instead give every member one vote', () => {
    const perMember = mergeConfig(config, { governance: { weighting: 'per-member' } });
    const register = foundingRegister();
    subscribe(register, config, { memberId: 'mem_1', shares: 100, occurredOn: '2026-02-01' });

    assert.equal(votingWeight(perMember, register, 'mem_1'), 1);
    assert.equal(totalVotingWeight(perMember, register), 30);
  });

  it('gives no weight to someone holding nothing', () => {
    const register = foundingRegister();
    assert.equal(votingWeight(config, register, 'mem_stranger'), 0);
  });
});

describe('counting a vote', () => {
  it('needs both quorum and the threshold to carry', () => {
    const register = foundingRegister();
    const p = proposal();

    // Ten of thirty members: 500 of 1,500 shares, a third — below the 50% quorum.
    for (let i = 1; i <= 10; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.approvalRatio, 1, 'everyone who voted was in favour');
    assert.equal(tally.quorumMet, false);
    assert.equal(tally.passed, false, 'unanimous is not enough without quorum');
  });

  it('carries with quorum and a two-thirds majority', () => {
    const register = foundingRegister();
    const p = proposal();

    for (let i = 1; i <= 16; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }
    for (let i = 17; i <= 20; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'against', castOn: '2026-03-02' });
    }

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.turnout, 20 / 30);
    assert.equal(tally.quorumMet, true);
    assert.equal(tally.approvalRatio, 0.8);
    assert.equal(tally.passed, true);
  });

  it('fails a simple majority that falls short of two thirds', () => {
    const register = foundingRegister();
    const p = proposal();

    for (let i = 1; i <= 12; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }
    for (let i = 13; i <= 22; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'against', castOn: '2026-03-02' });
    }

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.quorumMet, true);
    assert.ok(tally.approvalRatio > 0.5 && tally.approvalRatio < 2 / 3);
    assert.equal(tally.passed, false);
  });

  it('counts abstentions toward quorum but not toward the threshold', () => {
    const register = foundingRegister();
    const p = proposal();

    for (let i = 1; i <= 8; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }
    castVote(p, config, register, { memberId: 'mem_9', choice: 'against', castOn: '2026-03-02' });
    for (let i = 10; i <= 20; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'abstain', castOn: '2026-03-02' });
    }

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.quorumMet, true, 'abstentions helped reach quorum');
    assert.equal(tally.approvalRatio, 8 / 9, 'abstentions did not dilute the majority');
    assert.equal(tally.passed, true);
  });

  it('lets a member change their mind while the window is open', () => {
    const register = foundingRegister();
    const p = proposal();

    castVote(p, config, register, { memberId: 'mem_1', choice: 'for', castOn: '2026-03-02' });
    castVote(p, config, register, { memberId: 'mem_1', choice: 'against', castOn: '2026-03-03' });

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.voterCount, 1, 'one member, one vote');
    assert.equal(tally.forWeight, 0);
    assert.equal(tally.againstWeight, 50);
  });

  it('refuses a vote after the window has closed', () => {
    const register = foundingRegister();
    const p = proposal();

    assert.throws(
      () => castVote(p, config, register, { memberId: 'mem_1', choice: 'for', castOn: '2026-03-10' }),
      GovernanceError,
    );
  });

  it('refuses a vote from someone with no stake', () => {
    const register = foundingRegister();
    const p = proposal();

    assert.throws(
      () => castVote(p, config, register, { memberId: 'mem_outsider', choice: 'for', castOn: '2026-03-02' }),
      GovernanceError,
    );
  });

  it('can bar the proposer from voting on their own proposal', () => {
    const strict = mergeConfig(config, { governance: { proposerMayVote: false } });
    const register = foundingRegister();
    const p = openProposal(strict, {
      id: 'prop_x',
      entityType: 'announcement',
      entityId: 'ann_1',
      reason: 'Duplicate of the announcement posted the same morning',
      proposedBy: 'mem_1',
      openedOn: '2026-03-01',
    });

    assert.throws(
      () => castVote(p, strict, register, { memberId: 'mem_1', choice: 'for', castOn: '2026-03-02' }),
      GovernanceError,
    );
  });

  it('freezes a vote’s weight at the moment it was cast', () => {
    const register = foundingRegister();
    const p = proposal();

    castVote(p, config, register, { memberId: 'mem_1', choice: 'for', castOn: '2026-03-02' });
    // The member buys more shares afterwards; the vote already cast does not grow.
    subscribe(register, config, { memberId: 'mem_1', shares: 100, occurredOn: '2026-03-03' });

    assert.equal(tallyVotes(p, config, register).forWeight, 50);
  });
});

describe('settling a result early', () => {
  it('knows the outcome once no remaining vote could change it', () => {
    const register = foundingRegister();
    const p = proposal();

    // 25 of 30 in favour: quorum is met and the rest cannot drag it below 2/3.
    for (let i = 1; i <= 25; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.decided, true);
    assert.equal(tally.passed, true);
  });

  it('knows a proposal is lost once the threshold is out of reach', () => {
    const register = foundingRegister();
    const p = proposal();

    // 15 against out of 30: even every remaining vote in favour is 15/30.
    for (let i = 1; i <= 15; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'against', castOn: '2026-03-02' });
    }

    const tally = tallyVotes(p, config, register);
    assert.equal(tally.decided, true);
    assert.equal(tally.passed, false);
  });

  it('stays open while the result is genuinely in the balance', () => {
    const register = foundingRegister();
    const p = proposal();

    for (let i = 1; i <= 5; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }

    assert.equal(tallyVotes(p, config, register, { asOf: '2026-03-02' }).decided, false);
    assert.equal(resolveProposal(p, config, register, '2026-03-02').action, 'none');
    assert.equal(p.status, 'open');
  });
});

describe('resolving', () => {
  it('deletes when a vote on an ordinary record carries', () => {
    const register = foundingRegister();
    const p = proposal();

    for (let i = 1; i <= 25; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }

    const result = resolveProposal(p, config, register, '2026-03-05');
    assert.equal(result.action, 'delete');
    assert.equal(p.status, 'executed');
    assert.equal(p.executedOn, '2026-03-05');
  });

  it('lapses a proposal nobody turned out for', () => {
    const register = foundingRegister();
    const p = proposal();

    castVote(p, config, register, { memberId: 'mem_1', choice: 'for', castOn: '2026-03-02' });

    const result = resolveProposal(p, config, register, '2026-03-06');
    assert.equal(result.action, 'none');
    assert.equal(p.status, 'expired');
  });

  it('rejects a proposal that met quorum but not the threshold', () => {
    const register = foundingRegister();
    const p = proposal();

    for (let i = 1; i <= 10; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }
    for (let i = 11; i <= 20; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'against', castOn: '2026-03-02' });
    }

    const result = resolveProposal(p, config, register, '2026-03-05');
    assert.equal(result.action, 'none');
    assert.equal(p.status, 'rejected');
  });

  it('does nothing to a proposal that is already closed', () => {
    const register = foundingRegister();
    const p = proposal();
    p.status = 'withdrawn';

    assert.equal(resolveProposal(p, config, register, '2026-03-05').action, 'none');
    assert.equal(p.status, 'withdrawn');
  });
});

describe('explaining a vote to members', () => {
  it('says what is still needed while a proposal is short of quorum', () => {
    const register = foundingRegister();
    const p = proposal();
    castVote(p, config, register, { memberId: 'mem_1', choice: 'for', castOn: '2026-03-02' });

    const summary = summariseProposal(p, config, register, '2026-03-02');
    assert.match(summary.headline, /more turnout to reach quorum/);
  });

  it('says a carried proposal carried, and by how much', () => {
    const register = foundingRegister();
    const p = proposal();
    for (let i = 1; i <= 25; i += 1) {
      castVote(p, config, register, { memberId: `mem_${i}`, choice: 'for', castOn: '2026-03-02' });
    }
    resolveProposal(p, config, register, '2026-03-05');

    const summary = summariseProposal(p, config, register, '2026-03-05');
    assert.match(summary.headline, /^Carried/);
  });
});
