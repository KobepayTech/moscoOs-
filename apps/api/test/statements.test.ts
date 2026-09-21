/**
 * The reports, over real HTTP, against the seeded circle.
 *
 * The point of these is not that the numbers are some particular value — the
 * seed moves with the calendar — but that they *agree*: the cash flow
 * statement must reconcile to the ledger's own cash balance, and a member's
 * statement must agree with the register and the loan book about what that
 * member holds and owes. A report that disagrees with the books is worse than
 * no report, because someone will act on it.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { addDays, addMonths } from '@mamogoro/core';

import { openDb, type Db } from '../src/db.js';
import { seed, type SeedSummary } from '../src/seed.js';
import { createApp } from '../src/server.js';

let db: Db;
let server: Server;
let base: string;
let circle: SeedSummary;
let token: string;

before(async () => {
  db = openDb({ location: ':memory:' });
  circle = seed(db, { quiet: true });

  server = createApp(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  token = await signIn('+255710000000');
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

describe('GET /reports/cash-flow', () => {
  it('reconciles to the cash the books say the circle holds', async () => {
    const [flow, position] = await Promise.all([
      call('/reports/cash-flow', { token }),
      call('/reports/position', { token }),
    ]);

    assert.equal(flow.status, 200);
    assert.equal(flow.body!.reconciles, true);

    const cash = position.body!.position.assets.find((row: { account: string }) => row.account === 'CASH');
    assert.equal(flow.body!.closingCash, cash.balance, 'the statement and the balance sheet agree');
  });

  it('returns the three sections a circle recognises', async () => {
    const { body } = await call('/reports/cash-flow', { token });

    assert.deepEqual(
      body!.sections.map((section: { name: string }) => section.name),
      ['lending', 'earnings', 'capital'],
    );
    assert.equal(
      body!.sections.reduce((total: number, section: { net: number }) => total + section.net, 0),
      body!.netMovement,
    );
  });

  it('shows the seeded circle putting its capital to work', async () => {
    const { body } = await call('/reports/cash-flow', { token });
    const lending = body!.sections.find((section: { name: string }) => section.name === 'lending');
    const capital = body!.sections.find((section: { name: string }) => section.name === 'capital');

    assert.ok(lending.outflow > 0, 'loans went out');
    assert.ok(capital.inflow >= circle.equityCapital, 'members put their own money up first');
    assert.ok(body!.movements > 0);
  });

  it('opens a window where the previous one closed', async () => {
    const whole = await call('/reports/cash-flow', { token });
    const to = whole.body!.asOf as string;

    // The windows must not overlap: `to` is inclusive, so the second opens
    // the day after the first closes.
    const split = addMonths(circle.startedOn, 4);
    const early = await call(`/reports/cash-flow?to=${split}`, { token });
    const late = await call(`/reports/cash-flow?from=${addDays(split, 1)}&to=${to}`, { token });

    assert.equal(late.body!.openingCash, early.body!.closingCash);
    assert.equal(
      early.body!.netMovement + late.body!.netMovement,
      whole.body!.netMovement,
      'consecutive windows add up to the whole',
    );
    assert.equal(late.body!.reconciles, true);
    assert.equal(early.body!.reconciles, true);
  });

  it('refuses a window that runs backwards, and says why', async () => {
    const { status, body } = await call('/reports/cash-flow?from=2030-01-01&to=2020-01-01', { token });

    assert.equal(status, 422);
    assert.match(body!.error.message as string, /before it begins/);
  });

  it('is open to every member, not just officers', async () => {
    const memberToken = await signIn('+255710001096');
    assert.equal((await call('/reports/cash-flow', { token: memberToken })).status, 200);
    assert.equal((await call('/reports/cash-flow')).status, 401, 'but not to a stranger');
  });
});

describe('GET /members/:id/statement', () => {
  it('agrees with the register about what the member holds', async () => {
    const memberId = circle.memberIds[0];
    const [statement, member] = await Promise.all([
      call(`/members/${memberId}/statement`, { token }),
      call(`/members/${memberId}`, { token }),
    ]);

    assert.equal(statement.status, 200);
    assert.equal(statement.body!.holding.shares, member.body!.shares);
    assert.equal(statement.body!.holding.shareValue, member.body!.shareValue);
    assert.equal(
      statement.body!.position.outstandingPrincipal,
      member.body!.outstandingPrincipal,
      'the statement and the loan book agree about what is owed',
    );
  });

  it('shows what a founding member paid for their seat', async () => {
    const { body } = await call(`/members/${circle.memberIds[0]}/statement`, { token });

    assert.ok(body!.totals.shares > 0, 'they paid in for shares');
    assert.equal(body!.rows.length > 0, true);
    assert.equal(
      body!.rows.at(-1).runningTotal,
      body!.totals.net,
      'the running total ends where the totals say',
    );
  });

  it('shows a borrower receiving the money and paying it back', async () => {
    const loans = await call('/loans', { token });
    const borrowers = [
      ...new Set(
        (loans.body!.loans as { memberId: string; status: string }[])
          .filter((loan) => loan.status === 'disbursed' || loan.status === 'settled')
          .map((loan) => loan.memberId),
      ),
    ];
    assert.ok(borrowers.length > 0, 'the seed lends to somebody');

    const statements = await Promise.all(
      borrowers.map((id) => call(`/members/${id}/statement`, { token }).then((r) => r.body!)),
    );

    const repaying = statements.find((body) => body.totals.repaid > 0);
    assert.ok(repaying, 'the seeded circle has taken repayments');

    assert.ok(repaying!.totals.borrowed > 0, 'money reached them');
    assert.ok(repaying!.totals.interest > 0, 'the circle earned on it');
    assert.ok(
      repaying!.rows.some((row: { kind: string }) => row.kind === 'borrowed'),
      'the disbursement is named as borrowing, not as a repayment',
    );
    assert.ok(
      repaying!.totals.repaid <= repaying!.totals.borrowed,
      'nobody has returned more principal than they took',
    );
  });

  it('quotes a sponsor’s live cover, not what they originally promised', async () => {
    const statements = await Promise.all(
      circle.memberIds
        .slice(0, 12)
        .map((id) => call(`/members/${id}/statement`, { token }).then((response) => response.body!)),
    );

    const sponsor = statements.find((body) => body.position.coverPledged > 0);
    assert.ok(sponsor, 'somebody in the seeded circle is standing behind a loan');

    assert.ok(sponsor!.position.coverLocked <= sponsor!.position.coverPledged);
    assert.equal(
      sponsor!.position.coverReleased,
      sponsor!.position.coverPledged - sponsor!.position.coverLocked,
    );
    assert.ok(
      sponsor!.position.coverReleased > 0,
      'the seeded circle has repaid something, so cover has been released',
    );
  });

  it('honours a window', async () => {
    const memberId = circle.memberIds[0];
    const whole = await call(`/members/${memberId}/statement`, { token });
    const narrow = await call(`/members/${memberId}/statement?from=2099-01-01`, { token });

    assert.ok(whole.body!.rows.length > 0);
    assert.equal(narrow.body!.rows.length, 0);
    assert.equal(narrow.body!.totals.net, 0);
  });

  it('is open to every member, and closed to strangers', async () => {
    const memberToken = await signIn('+255710001096');
    const other = circle.memberIds[0];

    assert.equal((await call(`/members/${other}/statement`, { token: memberToken })).status, 200);
    assert.equal((await call(`/members/${other}/statement`)).status, 401);
  });

  it('gives a clear 404 for a member who does not exist', async () => {
    const { status, body } = await call('/members/mem_nobody/statement', { token });
    assert.equal(status, 404);
    assert.match(body!.error.message as string, /No member with id/);
  });
});
