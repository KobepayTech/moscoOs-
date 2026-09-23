/**
 * The capital exchange, over real HTTP.
 *
 * The thing being proved is that an offer becomes an ordinary facility and
 * nothing else: same ledger entry, same utilisation waterfall, same repayment
 * queue. A capital market with its own accounting would be a capital market
 * nobody could audit.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { addMonths, today } from '@mamogoro/core';

import { openDb, type Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';

let db: Db;
let server: Server;
let base: string;
let chair: string;
let cashier: string;

before(async () => {
  db = openDb({ location: ':memory:' });
  seed(db, { quiet: true });
  server = createApp(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  chair = await signIn(phoneOf(0));
  cashier = await signIn(phoneOf(1));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function call(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

async function signIn(phone: string): Promise<string> {
  const response = await call('/auth/login', { method: 'POST', body: { phone, password: 'mamogoro123' } });
  assert.equal(response.status, 200, `sign-in failed for ${phone}`);
  return response.body!.token as string;
}

function phoneOf(index: number): string {
  return `+2557${String(10000000 + index * 137).slice(0, 8)}`;
}

/** Terms a circle lending at 2.5% can actually keep. */
function soundCall(overrides: Record<string, unknown> = {}) {
  return {
    purpose: 'Fund the approved loan queue',
    target: 20_000_000,
    minimumOffer: 1_000_000,
    termMonths: 4,
    monthlyRate: 0.015,
    closesOn: addMonths(today(), 1),
    ...overrides,
  };
}

describe('deciding whether to ask the members', () => {
  it('says what the circle needs and on what terms, to everyone', async () => {
    const member = await signIn(phoneOf(10));
    const { status, body } = await call('/exchange/need', { token: member });

    assert.equal(status, 200);
    assert.equal(body!.enabled, true);

    // A member being asked to lend is entitled to the same figure the
    // committee saw when it decided to ask.
    assert.equal(body!.minimumTermMonths, 4, '3-month loans plus a 1-month buffer');
    assert.equal(body!.maximumMonthlyRate, 0.015, '2.5% lending less the 1% spread');
    assert.ok('gap' in body!);
  });

  it('is closed to a stranger', async () => {
    assert.equal((await call('/exchange/need')).status, 401);
  });
});

describe('publishing a call', () => {
  it('refuses to pay members more than the lending rate can carry', async () => {
    const { status, body } = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: soundCall({ monthlyRate: 0.022 }),
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /rate_too_high/);
    assert.match(JSON.stringify(body), /most it can afford is 1\.50%/);
  });

  it('refuses to borrow shorter than it lends', async () => {
    const { status, body } = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: soundCall({ termMonths: 2 }),
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /term_too_short/);
  });

  it('insists a rate be stated at all', async () => {
    const withoutRate = soundCall();
    delete (withoutRate as Record<string, unknown>).monthlyRate;

    const { status, body } = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: withoutRate,
    });

    assert.equal(status, 400);
    assert.match(body!.error.message as string, /members must be told what they will earn/);
  });

  it('is not an ordinary member’s to publish', async () => {
    const member = await signIn(phoneOf(10));
    const { status } = await call('/exchange/calls', {
      method: 'POST',
      token: member,
      body: soundCall(),
    });

    assert.equal(status, 403);
  });

  it('publishes sound terms and tells the circle', async () => {
    const { status, body } = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: soundCall(),
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body!.call.target, 20_000_000);
    assert.equal(body!.offered, 0);
    assert.match(body!.headline as string, /still needed/);

    const member = await signIn(phoneOf(12));
    const inbox = await call('/notifications?unread=true', { token: member });
    const alert = (inbox.body!.notifications as { kind: string; body: string }[]).find(
      (entry) => entry.kind === 'funding_call',
    );

    assert.ok(alert, 'every member hears about it');
    // A member who reads "1.5% a month" and assumes that is what their money
    // earns has not been told the truth.
    assert.match(alert!.body, /earns on what is actually lent out/);
  });
});

describe('offering capital', () => {
  let callId: string;

  before(async () => {
    const created = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: soundCall({ purpose: 'Offers test', target: 10_000_000 }),
    });
    callId = created.body!.call.id as string;
  });

  it('lets any member offer, and quotes the best case as the best case', async () => {
    const member = await signIn(phoneOf(12));
    const { status, body } = await call(`/exchange/calls/${callId}/offers`, {
      method: 'POST',
      token: member,
      body: { amount: 4_000_000 },
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body!.bestCase, 240_000, '1.5% × 4 months on 4,000,000');
    // The explanation of how a facility earns must reach a member whether or
    // not the call happens to be oversubscribed.
    assert.match(body!.note as string, /idle capital earns nothing/);
  });

  it('refuses an offer below the minimum', async () => {
    const member = await signIn(phoneOf(13));
    const { status, body } = await call(`/exchange/calls/${callId}/offers`, {
      method: 'POST',
      token: member,
      body: { amount: 500_000 },
    });

    assert.equal(status, 422);
    assert.match(body!.error.message as string, /smallest offer/);
  });

  it('replaces a member’s earlier offer rather than holding two', async () => {
    const member = await signIn(phoneOf(12));
    await call(`/exchange/calls/${callId}/offers`, {
      method: 'POST',
      token: member,
      body: { amount: 6_000_000 },
    });

    const { body } = await call(`/exchange/calls/${callId}`, { token: member });
    const live = (body!.offers as { memberId: string; status: string }[]).filter(
      (offer) => offer.memberId === 'mem_13' && offer.status === 'offered',
    );

    assert.equal(live.length, 1, 'the register never holds two numbers for one person');
    assert.equal(body!.yourOffer.amount, 6_000_000);
  });

  it('shows the whole circle who is funding it', async () => {
    const other = await signIn(phoneOf(14));
    const { body } = await call(`/exchange/calls/${callId}`, { token: other });

    // Who lends the circle money is not a private matter between one member
    // and the committee.
    assert.ok((body!.offers as unknown[]).length > 0);
    assert.ok((body!.offers as { memberName: string }[])[0].memberName);
  });

  it('warns an offerer when the call is already oversubscribed', async () => {
    const member = await signIn(phoneOf(15));
    const { body } = await call(`/exchange/calls/${callId}/offers`, {
      method: 'POST',
      token: member,
      body: { amount: 9_000_000 },
    });

    assert.ok(body!.call.oversubscribedBy > 0);
    assert.match(body!.warning as string, /scaled back pro rata/);
    assert.match(body!.note as string, /idle capital earns nothing/, 'and still explains the terms');
  });

  it('lets a member withdraw, but only their own offer', async () => {
    const mine = await signIn(phoneOf(15));
    const theirs = await signIn(phoneOf(16));

    const detail = await call(`/exchange/calls/${callId}`, { token: mine });
    const offerId = detail.body!.yourOffer.id as string;

    assert.equal((await call(`/exchange/offers/${offerId}/withdraw`, { method: 'POST', token: theirs })).status, 403);
    assert.equal((await call(`/exchange/offers/${offerId}/withdraw`, { method: 'POST', token: mine })).status, 200);
  });
});

describe('closing a call turns offers into facilities', () => {
  let callId: string;

  before(async () => {
    const created = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: soundCall({ purpose: 'Closing test', target: 10_000_000, minimumOffer: 1_000_000 }),
    });
    callId = created.body!.call.id as string;

    // Oversubscribed, and one member far ahead of the others, so both the
    // pro-rata scaling and the concentration cap are exercised.
    for (const [index, amount] of [
      [17, 9_000_000],
      [18, 5_000_000],
      [19, 5_000_000],
    ] as const) {
      const token = await signIn(phoneOf(index));
      const response = await call(`/exchange/calls/${callId}/offers`, {
        method: 'POST',
        token,
        body: { amount },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
  });

  it('allocates to the shilling and caps one member’s share', async () => {
    const { status, body } = await call(`/exchange/calls/${callId}/close`, {
      method: 'POST',
      token: cashier,
      body: {},
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body!.raised, 10_000_000, 'exactly the target, nothing orphaned');
    assert.equal(body!.status, 'filled');

    const allocations = body!.allocations as { memberId: string; allocated: number; reason: string }[];
    const largest = Math.max(...allocations.map((entry) => entry.allocated));

    // 40% of a 10,000,000 call.
    assert.equal(largest, 4_000_000);
    assert.ok(allocations.some((entry) => /ceiling on one member's share/.test(entry.reason)));
  });

  it('creates ordinary facilities, with the term as a real commitment date', async () => {
    const { body } = await call('/facilities', { token: chair });
    const fromExchange = (body!.facilities as { note: string | null; committedUntil: string; monthlyRate: number }[])
      .filter((facility) => facility.note?.includes('Closing test'));

    assert.equal(fromExchange.length, 3);
    assert.ok(fromExchange.every((facility) => facility.monthlyRate === 0.015));

    // The whole reason the maturity check matters: the date before which a
    // member cannot ask for the money back.
    assert.ok(fromExchange.every((facility) => facility.committedUntil === addMonths(today(), 4)));
  });

  it('posts the drawdowns to the books, and the books still balance', async () => {
    const { body } = await call('/reports/position', { token: chair });
    assert.equal(body!.booksBalance, true);

    const ledger = await call('/ledger', { token: chair });
    const drawdowns = (ledger.body!.entries as { narration: string }[]).filter((entry) =>
      entry.narration.includes('External capital received'),
    );

    // Three from this call, plus the seeded investor's original facility.
    assert.ok(drawdowns.length >= 4, `expected the drawdowns to be posted, saw ${drawdowns.length}`);
  });

  it('tells each member what they were taken up on and why', async () => {
    const member = await signIn(phoneOf(17));
    const { body } = await call('/notifications?unread=true', { token: member });
    const alert = (body!.notifications as { kind: string; body: string }[]).find(
      (entry) => entry.kind === 'capital_accepted',
    );

    assert.ok(alert);
    assert.match(alert!.body, /ceiling on one member's share|Scaled pro rata/);
    assert.match(alert!.body, /nothing on the part that sits idle/);
  });

  it('will not close twice', async () => {
    const { status } = await call(`/exchange/calls/${callId}/close`, {
      method: 'POST',
      token: cashier,
      body: {},
    });

    assert.equal(status, 409);
  });

  it('refuses to withdraw an offer that is already a facility', async () => {
    const member = await signIn(phoneOf(17));
    const detail = await call(`/exchange/calls/${callId}`, { token: member });
    const taken = (detail.body!.offers as { id: string; memberId: string; status: string }[]).find(
      (offer) => offer.status === 'accepted' || offer.status === 'scaled',
    )!;

    const owner = await signIn(
      phoneOf(
        Math.round(
          (Number(
            (
              (await call('/members', { token: chair })).body!.members as { id: string; phone: string }[]
            ).find((m) => m.id === taken.memberId)!.phone.replace('+2557', ''),
          ) -
            10000000) /
            137,
        ),
      ),
    );

    const { status, body } = await call(`/exchange/offers/${taken.id}/withdraw`, {
      method: 'POST',
      token: owner,
    });

    assert.equal(status, 409);
    assert.match(body!.error.message as string, /already been taken up and is now a facility/);
  });
});

describe('cancelling a call', () => {
  it('lapses every offer, because nobody’s money was ever taken', async () => {
    const created = await call('/exchange/calls', {
      method: 'POST',
      token: cashier,
      body: soundCall({ purpose: 'Cancel test', target: 5_000_000 }),
    });
    const callId = created.body!.call.id as string;

    const member = await signIn(phoneOf(20));
    await call(`/exchange/calls/${callId}/offers`, {
      method: 'POST',
      token: member,
      body: { amount: 2_000_000 },
    });

    assert.equal(
      (await call(`/exchange/calls/${callId}/cancel`, { method: 'POST', token: cashier })).status,
      200,
    );

    const detail = await call(`/exchange/calls/${callId}`, { token: member });
    assert.equal(detail.body!.call.status, 'cancelled');
    assert.ok((detail.body!.offers as { status: string }[]).every((offer) => offer.status === 'declined'));
  });

  it('refuses an offer on a call that is no longer open', async () => {
    const calls = await call('/exchange/calls', { token: chair });
    const closed = (calls.body!.calls as { call: { id: string; status: string } }[]).find(
      (entry) => entry.call.status === 'cancelled' || entry.call.status === 'filled',
    )!;

    const member = await signIn(phoneOf(21));
    const { status } = await call(`/exchange/calls/${closed.call.id}/offers`, {
      method: 'POST',
      token: member,
      body: { amount: 2_000_000 },
    });

    assert.equal(status, 409);
  });
});
