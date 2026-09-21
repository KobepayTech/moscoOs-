/**
 * The approval gate, over real HTTP.
 *
 * The rule being proved here is the one the circle decided: sponsorship
 * approves a loan, a committee does not — *and* full cover on its own is not
 * enough. These tests drive a loan to complete cover and then check that the
 * gate still has something to say about the cash, the ceiling and the
 * borrower, and that a person only ever touches the exceptional case.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { openDb, type Db } from '../src/db.js';
import { seed, type SeedSummary } from '../src/seed.js';
import { createApp } from '../src/server.js';

let db: Db;
let server: Server;
let base: string;
let circle: SeedSummary;
let chair: string;
let cashier: string;

before(async () => {
  db = openDb({ location: ':memory:' });
  circle = seed(db, { quiet: true });
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

/**
 * Take a loan all the way to full sponsor cover and stop there.
 *
 * Returns the loan and the gate's verdict on the last acceptance, which is
 * the moment the whole design turns on.
 */
/**
 * Members, by the phone index the seed gives them.
 *
 * Needed because sponsors are found by capacity rather than chosen by hand —
 * the seed's commitments shift as these tests run, and hard-coded ids go
 * stale in ways that look like gate failures.
 */
let indexOfMember: Map<string, number> | null = null;

async function memberIndex(): Promise<Map<string, number>> {
  if (indexOfMember) return indexOfMember;
  const { body } = await call('/members', { token: chair });
  // The register is sorted by name, not by phone, so the index comes from the
  // phone number the seed generated rather than from the row order.
  indexOfMember = new Map(
    (body!.members as { id: string; phone: string }[]).map((member) => [
      member.id,
      Math.round((Number(member.phone.replace('+2557', '')) - 10000000) / 137),
    ]),
  );
  return indexOfMember;
}

async function coverALoan(options: {
  borrowerIndex: number;
  principal: number;
  sponsors?: { index: number; memberId: string; amount: number }[];
}) {
  const borrower = await signIn(phoneOf(options.borrowerIndex));

  const applied = await call('/loans', {
    method: 'POST',
    token: borrower,
    body: { product: 'term', principal: options.principal, purpose: 'Stock for the season' },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const loanId = applied.body!.id as string;

  // The fee is what buys circulation to sponsors.
  const started = await call(`/loans/${loanId}/application-fee`, {
    method: 'POST',
    token: borrower,
    body: {},
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const confirmed = await call(`/payments/${started.body!.payment.id}/confirm`, {
    method: 'POST',
    token: cashier,
    body: { proof: `KOBEPAY-${loanId}` },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  // Left unspecified, the sponsors are whoever the circle says has the
  // capacity — which is what a borrower would actually do.
  let sponsors = options.sponsors;
  if (!sponsors) {
    const suggested = await call(`/loans/${loanId}/sponsor-suggestions`, { token: borrower });
    const byId = await memberIndex();
    sponsors = (suggested.body!.suggestions as { memberId: string; suggestedPledge: number }[])
      .filter((entry) => entry.suggestedPledge > 0)
      .map((entry) => ({
        index: byId.get(entry.memberId)!,
        memberId: entry.memberId,
        amount: entry.suggestedPledge,
      }));
    assert.ok(sponsors.length > 0, 'nobody in the circle can cover this');
  }

  const asked = await call(`/loans/${loanId}/sponsors`, {
    method: 'POST',
    token: borrower,
    body: { sponsors: sponsors.map((s) => ({ sponsorId: s.memberId, amount: s.amount })) },
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));

  let last;
  for (const sponsor of sponsors) {
    // The borrower's own shares count towards cover, so a loan can reach full
    // cover before every sponsor has answered. Once it has, the remaining
    // requests are moot and answering them is a conflict.
    const state = await call(`/loans/${loanId}`, { token: borrower });
    if (state.body!.status !== 'awaiting_sponsors') break;

    const token = await signIn(phoneOf(sponsor.index));
    const inbox = await call('/sponsorships', { token });
    const pledge = (inbox.body!.pledges as { id: string; loanId: string; status: string }[]).find(
      (entry) => entry.loanId === loanId && entry.status === 'pending',
    )!;
    assert.ok(pledge, `no pending pledge for sponsor ${sponsor.memberId}`);

    last = await call(`/sponsorships/${pledge.id}/respond`, {
      method: 'POST',
      token,
      body: { decision: 'accept' },
    });
    assert.equal(last.status, 200, JSON.stringify(last.body));
  }

  assert.ok(last, 'no sponsor was ever asked to answer');
  return { loanId, borrower, response: last };
}

describe('every decision explains itself', () => {
  it('records the gate list, not just the answer', async () => {
    const { loanId, response } = await coverALoan({
      borrowerIndex: 4,
      principal: 3_000_000,
      sponsors: [
        { index: 12, memberId: 'mem_13', amount: 1_500_000 },
        { index: 13, memberId: 'mem_14', amount: 1_500_000 },
      ],
    });

    assert.equal(response.body!.approvedNow, true, JSON.stringify(response.body!.assessment));

    const { status, body } = await call(`/loans/${loanId}/decision`, { token: chair });
    assert.equal(status, 200);
    assert.equal(body!.outcome, 'approved');
    assert.equal(body!.checks.length, 8, 'every gate is on the record, passed or failed');
    assert.ok(body!.checks.every((check: { outcome: string }) => check.outcome === 'pass'));
  });

  it('stamps the policy that made the decision', async () => {
    const loans = await call('/loans', { token: chair });
    const approved = (loans.body!.loans as { id: string; status: string }[]).find(
      (loan) => loan.status === 'approved' || loan.status === 'disbursed',
    )!;

    const { body } = await call(`/loans/${approved.id}/decision`, { token: chair });
    if (body!.decision === null) return; // seeded loans predate the gate

    assert.equal(body!.policyVersion, '2026.09');
    assert.ok(body!.assessedOn);
  });

  it('is readable by every member, not only officers', async () => {
    const member = await signIn(phoneOf(10));
    const loans = await call('/loans', { token: member });
    const any = (loans.body!.loans as { id: string }[])[0];

    assert.equal((await call(`/loans/${any.id}/decision`, { token: member })).status, 200);
    assert.equal((await call(`/loans/${any.id}/decision`)).status, 401);
  });
});

describe('cover alone does not approve a loan', () => {
  it('holds a fully covered loan when the cash is not there', async () => {
    // Raise the reserve above the circle's whole cash position, so nothing
    // can be paid out however well covered it is.
    const before = await call('/config', { token: chair });
    const raised = await call('/config', {
      method: 'PATCH',
      token: chair,
      body: { approval: { minimumCashReserve: 10_000_000_000 } },
    });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));

    try {
      const { loanId, response } = await coverALoan({
        borrowerIndex: 5,
        principal: 2_000_000,
        sponsors: [
          { index: 14, memberId: 'mem_15', amount: 1_000_000 },
          { index: 17, memberId: 'mem_18', amount: 1_000_000 },
        ],
      });

      assert.equal(response.body!.approvedNow, false, 'covered, but there is no money');
      assert.equal(response.body!.assessment.outcome, 'awaiting_capital');

      const detail = await call(`/loans/${loanId}`, { token: chair });
      assert.equal(detail.body!.status, 'awaiting_capital');

      const decision = await call(`/loans/${loanId}/decision`, { token: chair });
      const cash = decision.body!.checks.find((check: { code: string }) => check.code === 'spendable_cash');
      assert.equal(cash.outcome, 'fail');
      assert.equal(cash.exceptionable, false, 'nobody can authorise cash into existence');
    } finally {
      await call('/config', {
        method: 'PATCH',
        token: chair,
        body: { approval: { minimumCashReserve: before.body!.approval.minimumCashReserve } },
      });
    }
  });

  it('refuses to let anyone authorise past missing cash', async () => {
    const loans = await call('/loans', { token: chair });
    const held = (loans.body!.loans as { id: string; status: string }[]).find(
      (loan) => loan.status === 'awaiting_capital',
    );
    if (!held) return;

    const { status, body } = await call(`/loans/${held.id}/authorise`, {
      method: 'POST',
      token: chair,
      body: { gate: 'spendable_cash', reason: 'We will find the money somewhere' },
    });

    assert.equal(status, 422);
    assert.match(body!.error.message as string, /cover and cash are not policies to relax/);
  });
});

describe('exceptions go to a person, normal loans do not', () => {
  let exceptional: string;

  it('routes a request above the ceiling for authorisation', async () => {
    // The seeded ceiling is 25% of capital — far more than any one member's
    // shares can cover, so the ceiling is lowered here to something the
    // circle's own sponsors can actually stand behind. It is the *rule* being
    // exercised, not the arithmetic.
    const lowered = await call('/config', {
      method: 'PATCH',
      token: chair,
      body: { termLoan: { maxPrincipal: 2_000_000 } },
    });
    assert.equal(lowered.status, 200, JSON.stringify(lowered.body));

    const { loanId, response } = await coverALoan({
      borrowerIndex: 26,
      principal: 3_000_000,
      sponsors: [
        { index: 15, memberId: 'mem_16', amount: 1_500_000 },
        { index: 16, memberId: 'mem_17', amount: 1_500_000 },
      ],
    });

    exceptional = loanId;

    assert.equal(response.body!.approvedNow, false);
    assert.equal(response.body!.assessment.outcome, 'needs_authorisation');
    assert.deepEqual(response.body!.assessment.awaitingAuthorisation, ['within_ceiling']);

    const detail = await call(`/loans/${loanId}`, { token: chair });
    assert.equal(detail.body!.status, 'needs_authorisation');
  });

  it('tells the authoriser, and only the authoriser', async () => {
    const { body } = await call('/notifications?unread=true', { token: chair });
    const alerts = body!.notifications as { kind: string; title: string }[];
    assert.ok(alerts.some((alert) => alert.kind === 'authorisation_required'));

    const ordinary = await signIn(phoneOf(20));
    const theirs = await call('/notifications?unread=true', { token: ordinary });
    assert.ok(
      !(theirs.body!.notifications as { kind: string }[]).some(
        (alert) => alert.kind === 'authorisation_required',
      ),
      'an exception is not everybody’s inbox problem',
    );
  });

  it('will not let the cashier authorise', async () => {
    const { status, body } = await call(`/loans/${exceptional}/authorise`, {
      method: 'POST',
      token: cashier,
      body: { gate: 'within_ceiling', reason: 'Seems fine to me, they are good for it' },
    });

    assert.equal(status, 403);
    assert.match(body!.error.message as string, /Only the chair may authorise/);
  });

  it('insists on a reason somebody can read back', async () => {
    const { status, body } = await call(`/loans/${exceptional}/authorise`, {
      method: 'POST',
      token: chair,
      body: { gate: 'within_ceiling', reason: 'ok' },
    });

    assert.equal(status, 422);
    assert.match(body!.error.message as string, /needs a reason/);
  });

  it('approves once the chair authorises, and says who did', async () => {
    const { status, body } = await call(`/loans/${exceptional}/authorise`, {
      method: 'POST',
      token: chair,
      body: {
        gate: 'within_ceiling',
        reason: 'Confirmed stock order against a signed contract with the importer',
      },
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body!.approvedNow, true);

    const decision = await call(`/loans/${exceptional}/decision`, { token: chair });
    assert.equal(decision.body!.outcome, 'approved');

    const ceiling = decision.body!.checks.find((check: { code: string }) => check.code === 'within_ceiling');
    assert.equal(ceiling.outcome, 'pass');
    assert.match(ceiling.detail as string, /authorised$/, 'the record shows a person cleared it');

    assert.equal(decision.body!.authorisations.length, 1);
    assert.match(decision.body!.authorisations[0].reason as string, /signed contract/);
  });

  it('tells the circle that an exception was made', async () => {
    const member = await signIn(phoneOf(21));
    const { body } = await call('/notifications', { token: member });
    const alerts = body!.notifications as { title: string }[];

    assert.ok(
      alerts.some((alert) => alert.title.includes('authorised an exception')),
      'an exception is the circle’s business, not a private arrangement',
    );
  });

  it('will not let a member authorise their own loan', async () => {
    // The chair borrows, then tries to wave their own request through.
    const { loanId } = await coverALoan({ borrowerIndex: 0, principal: 3_000_000 });

    const { status, body } = await call(`/loans/${loanId}/authorise`, {
      method: 'POST',
      token: chair,
      body: { gate: 'within_ceiling', reason: 'I am good for it, obviously' },
    });

    assert.equal(status, 403);
    assert.match(body!.error.message as string, /your own loan/);
  });
});
