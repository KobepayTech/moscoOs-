import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCircleConfig, mergeConfig, requiredEntryCapital, requiredEntryPayment } from '../src/config.js';
import {
  createRegister,
  dilute,
  distributeSurplus,
  isFullyPaidMember,
  issuedCapital,
  issuedShares,
  memberNetWorth,
  netAssetValuePerShare,
  ownershipRatio,
  ShareError,
  sharesOf,
  sharesOutstandingForMembership,
  subscribe,
  summariseRegister,
  unissuedShares,
} from '../src/shares.js';

const config = defaultCircleConfig();

function foundingRegister(memberCount = 30) {
  const register = createRegister(config);
  for (let i = 1; i <= memberCount; i += 1) {
    subscribe(register, config, { memberId: `mem_${i}`, shares: 50, occurredOn: '2026-01-01' });
  }
  return register;
}

describe('the founding capital structure', () => {
  it('asks 5,000,000 of each member for their fifty shares', () => {
    assert.equal(config.shares.parValue, 100_000);
    assert.equal(config.shares.minimumMembershipShares, 50);
    assert.equal(requiredEntryCapital(config), 5_000_000);
  });

  it('adds the opening fees on top of the share capital', () => {
    assert.equal(requiredEntryPayment(config), 5_000_000 + 20_000 + 50_000);
  });

  it('raises 150,000,000 from thirty members', () => {
    const register = foundingRegister();
    assert.equal(issuedShares(register), 1_500);
    assert.equal(issuedCapital(register), 150_000_000);
  });

  it('leaves plenty of the million authorised shares for later', () => {
    const register = foundingRegister();
    assert.equal(register.authorized, 1_000_000);
    assert.equal(unissuedShares(register), 998_500);
  });

  it('gives each founding member a thirtieth of the circle', () => {
    const register = foundingRegister();
    assert.ok(Math.abs(ownershipRatio(register, 'mem_1') - 1 / 30) < 1e-12);
  });
});

describe('subscribing for shares', () => {
  it('lets a member take up their standard seat however small the circle is', () => {
    const register = createRegister(config);
    // The first member necessarily holds 100% of a one-member register.
    assert.doesNotThrow(() =>
      subscribe(register, config, { memberId: 'mem_1', shares: 50, occurredOn: '2026-01-01' }),
    );
    assert.equal(sharesOf(register, 'mem_1'), 50);
  });

  it('stops a member concentrating beyond the ceiling once the circle is formed', () => {
    const register = foundingRegister();
    // 25% of a 1,500-share register is 375; buying to 500 is too much.
    assert.throws(
      () => subscribe(register, config, { memberId: 'mem_1', shares: 450, occurredOn: '2026-02-01' }),
      ShareError,
    );
  });

  it('allows extra shares below the ceiling', () => {
    const register = foundingRegister();
    subscribe(register, config, { memberId: 'mem_1', shares: 100, occurredOn: '2026-02-01' });
    assert.equal(sharesOf(register, 'mem_1'), 150);
  });

  it('refuses to issue beyond the authorised capital', () => {
    const register = createRegister(mergeConfig(config, { shares: { authorized: 100 } }));
    assert.throws(
      () =>
        subscribe(register, mergeConfig(config, { shares: { authorized: 100 } }), {
          memberId: 'mem_1',
          shares: 101,
          occurredOn: '2026-01-01',
        }),
      ShareError,
    );
  });

  it('refuses fractional or negative subscriptions', () => {
    const register = createRegister(config);
    assert.throws(
      () => subscribe(register, config, { memberId: 'mem_1', shares: 1.5, occurredOn: '2026-01-01' }),
      ShareError,
    );
    assert.throws(
      () => subscribe(register, config, { memberId: 'mem_1', shares: -5, occurredOn: '2026-01-01' }),
      ShareError,
    );
  });

  it('records every movement for the audit trail', () => {
    const register = foundingRegister(3);
    assert.equal(register.transactions.length, 3);
    assert.equal(register.transactions[0].kind, 'subscription');
    assert.equal(register.transactions[0].amount, 5_000_000);
  });

  it('draws down treasury shares before minting new ones', () => {
    const register = foundingRegister();
    dilute(register, 'mem_1', 2_000_000, '2026-06-01');
    assert.equal(register.treasury, 20);

    subscribe(register, config, { memberId: 'mem_31', shares: 50, occurredOn: '2026-07-01' });
    assert.equal(register.treasury, 0, 'the twenty forfeited shares were re-issued first');
  });
});

describe('membership standing', () => {
  it('recognises a member who has completed their subscription', () => {
    const register = foundingRegister(1);
    assert.equal(isFullyPaidMember(register, config, 'mem_1'), true);
    assert.equal(sharesOutstandingForMembership(register, config, 'mem_1'), 0);
  });

  it('counts what a part-paid member still owes', () => {
    const register = createRegister(config);
    subscribe(register, config, { memberId: 'mem_1', shares: 20, occurredOn: '2026-01-01' });

    assert.equal(isFullyPaidMember(register, config, 'mem_1'), false);
    assert.equal(sharesOutstandingForMembership(register, config, 'mem_1'), 30);
  });
});

describe('dilution', () => {
  it('rounds up to whole shares, since shares do not divide', () => {
    const register = foundingRegister(2);
    // 120,000 needs two whole shares at 100,000 each.
    const result = dilute(register, 'mem_1', 120_000, '2026-06-01');

    assert.equal(result.sharesForfeited, 2);
    assert.equal(result.valueRecovered, 200_000);
    assert.equal(result.shortfall, 0);
    assert.equal(sharesOf(register, 'mem_1'), 48);
  });

  it('takes everything a member has and reports what it could not cover', () => {
    const register = foundingRegister(2);
    const result = dilute(register, 'mem_1', 8_000_000, '2026-06-01');

    assert.equal(result.sharesForfeited, 50);
    assert.equal(result.valueRecovered, 5_000_000);
    assert.equal(result.shortfall, 3_000_000);
    assert.equal(sharesOf(register, 'mem_1'), 0);
  });

  it('does nothing to a member who holds no shares', () => {
    const register = foundingRegister(2);
    const result = dilute(register, 'mem_nobody', 1_000_000, '2026-06-01');

    assert.equal(result.sharesForfeited, 0);
    assert.equal(result.shortfall, 1_000_000);
  });

  it('moves forfeited shares to treasury, keeping the circle’s capital intact', () => {
    const register = foundingRegister(2);
    const before = issuedShares(register);

    dilute(register, 'mem_1', 1_000_000, '2026-06-01');

    assert.equal(register.treasury, 10);
    assert.equal(issuedShares(register), before - 10);
  });
});

describe('sharing out the surplus', () => {
  it('splits pro rata by holding', () => {
    const register = foundingRegister();
    subscribe(register, config, { memberId: 'mem_1', shares: 25, occurredOn: '2026-02-01' });

    // mem_1 holds 75 of 1,525 shares; everyone else holds 50.
    const distribution = distributeSurplus(register, 1_525_000);
    const byMember = new Map(distribution.map((row) => [row.memberId, row.amount]));

    assert.equal(byMember.get('mem_1'), 75_000, 'a shilling per share');
    assert.equal(byMember.get('mem_2'), 50_000);
    assert.equal(byMember.get('mem_30'), 50_000);
  });

  it('never leaves a stray shilling unallocated', () => {
    const register = foundingRegister(7);
    const surplus = 1_000_000;
    const distribution = distributeSurplus(register, surplus);
    const total = distribution.reduce((sum, row) => sum + row.amount, 0);

    assert.equal(total, surplus, 'the parts must sum to exactly the surplus declared');
  });

  it('leaves out members who hold nothing', () => {
    const register = foundingRegister(3);
    dilute(register, 'mem_3', 5_000_000, '2026-06-01');

    const distribution = distributeSurplus(register, 1_000_000);
    assert.equal(distribution.length, 2);
    assert.ok(!distribution.some((row) => row.memberId === 'mem_3'));
  });
});

describe('what a share is worth', () => {
  it('is par value before the circle has earned anything', () => {
    const register = foundingRegister();
    assert.equal(netAssetValuePerShare(register, 0), 100_000);
  });

  it('rises with retained earnings — this is the members’ return', () => {
    const register = foundingRegister();
    // 30,000,000 retained on 1,500 shares adds 20,000 a share.
    assert.equal(netAssetValuePerShare(register, 30_000_000), 120_000);
  });

  it('values a member’s whole stake at current worth', () => {
    const register = foundingRegister();
    assert.equal(memberNetWorth(register, 'mem_1', 30_000_000), 6_000_000);
  });
});

describe('summarising the register', () => {
  it('reports the founding position at a glance', () => {
    const summary = summariseRegister(foundingRegister());

    assert.equal(summary.authorized, 1_000_000);
    assert.equal(summary.issued, 1_500);
    assert.equal(summary.unissued, 998_500);
    assert.equal(summary.memberCount, 30);
    assert.equal(summary.issuedCapital, 150_000_000);
    assert.ok(Math.abs(summary.largestHoldingRatio - 1 / 30) < 1e-12);
  });
});
