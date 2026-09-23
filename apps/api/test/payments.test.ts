/**
 * The two money flows that are not the circle's ordinary money.
 *
 * These test the parts that are easy to get wrong and expensive to get wrong:
 * that the fee actually gates the sponsor request, that only the net reaches
 * the circle's books, that the liability becomes income exactly when the
 * circle earns it, that a refund gives back what was received, and that
 * nothing charges or posts twice however many times it is called.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { monthKey, today } from '@mamogoro/core';

import { openDb, type Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';

let db: Db;
let server: Server;
let base: string;

before(async () => {
  db = openDb({ location: ':memory:' });
  seed(db, { quiet: true });
  server = createApp(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function signIn(phone: string): Promise<string> {
  const response = await call('/auth/login', { method: 'POST', body: { phone, password: 'mamogoro123' } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token as string;
}

const phoneOf = (index: number) => `+2557${String(10000000 + index * 137).slice(0, 8)}`;

function accountBalance(account: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(debit), 0) AS d, COALESCE(SUM(credit), 0) AS c
         FROM journal_lines WHERE account = ?`,
    )
    .get(account) as unknown as { d: number; c: number };
  // Both accounts under test are credit-normal liabilities or income.
  return row.c - row.d;
}

function booksBalance(): boolean {
  const row = db
    .prepare('SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines')
    .get() as unknown as { d: number; c: number };
  return row.d === row.c;
}

/** Apply for a loan and return its id. */
async function apply(token: string, principal = 8_000_000): Promise<string> {
  const response = await call('/loans', {
    method: 'POST',
    token,
    body: { product: 'term', principal, purpose: 'Stock for the shop' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.id as string;
}

describe('the application fee gates the sponsor request', () => {
  let borrower: string;
  let loanId: string;

  before(async () => {
    borrower = await signIn(phoneOf(16));
    loanId = await apply(borrower);
  });

  it('lets a member apply and be quoted for nothing', async () => {
    // Applying is free; the fee buys the circulation, not the calculation.
    const quote = await call('/loans/quote', {
      method: 'POST',
      token: borrower,
      body: { product: 'term', principal: 8_000_000 },
    });
    assert.equal(quote.status, 200);
  });

  it('refuses to send sponsor requests until the fee is paid', async () => {
    const { status, body } = await call(`/loans/${loanId}/sponsors`, {
      method: 'POST',
      token: borrower,
      body: { sponsors: [{ sponsorId: 'mem_19', amount: 4_000_000 }] },
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /must be paid before your request can be sent/);
    assert.equal(body.error.detail.applicationFee.required, 50_000);
    assert.equal(body.error.detail.applicationFee.state, 'unpaid');
  });

  it('quotes the split before the member commits', async () => {
    const { status, body } = await call(`/loans/${loanId}/application-fee`, {
      method: 'POST',
      token: borrower,
      body: {},
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.split.gross, 50_000);
    assert.equal(body.split.processingFee, 2_500);
    assert.equal(body.split.net, 47_500);
    assert.match(body.explanation, /not recoverable/);
  });

  it('still refuses while the payment is unconfirmed', async () => {
    const { status, body } = await call(`/loans/${loanId}/sponsors`, {
      method: 'POST',
      token: borrower,
      body: { sponsors: [{ sponsorId: 'mem_19', amount: 4_000_000 }] },
    });

    assert.equal(status, 422);
    assert.equal(body.error.detail.applicationFee.state, 'awaiting_confirmation');
  });

  it('does not start a second charge when the member taps again', async () => {
    const first = await call(`/loans/${loanId}/application-fee`, { method: 'POST', token: borrower, body: {} });
    assert.equal(first.status, 200);
    assert.equal(first.body.alreadyInFlight, true);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM payment_intents WHERE loan_id = ? AND purpose = 'loan_application_fee'")
      .get(loanId) as unknown as { n: number };
    assert.equal(count.n, 1, 'a second intent was created');
  });

  it('will not let a member pay someone else’s application fee', async () => {
    const other = await signIn(phoneOf(20));
    const { status } = await call(`/loans/${loanId}/application-fee`, {
      method: 'POST',
      token: other,
      body: {},
    });
    assert.equal(status, 403);
  });

  it('posts only the net to the books when the cashier confirms', async () => {
    const cashier = await signIn(phoneOf(1));
    const payment = db
      .prepare("SELECT id FROM payment_intents WHERE loan_id = ? AND purpose = 'loan_application_fee'")
      .get(loanId) as unknown as { id: string };

    const heldBefore = accountBalance('APPLICATION_FEES_HELD');

    const { status, body } = await call(`/payments/${payment.id}/confirm`, {
      method: 'POST',
      token: cashier,
      body: { proof: 'KOBEPAY-8891', paidOn: today() },
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.posted, true);

    // 47,500 — never the 50,000 the member paid. The 2,500 was settled
    // between the member and the rail and is not the circle's money.
    assert.equal(accountBalance('APPLICATION_FEES_HELD') - heldBefore, 47_500);
    assert.ok(booksBalance());
  });

  it('holds it as a liability, not income, while the loan is undecided', async () => {
    assert.equal(accountBalance('APPLICATION_FEES_HELD'), 47_500);
  });

  it('now lets the sponsor requests go out', async () => {
    const { status, body } = await call(`/loans/${loanId}/sponsors`, {
      method: 'POST',
      token: borrower,
      body: {
        sponsors: [
          { sponsorId: 'mem_19', amount: 4_000_000 },
          { sponsorId: 'mem_24', amount: 4_000_000 },
        ],
      },
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((body.requested as unknown[]).length, 2);
  });

  it('does not confirm the same payment twice', async () => {
    const cashier = await signIn(phoneOf(1));
    const payment = db
      .prepare("SELECT id FROM payment_intents WHERE loan_id = ? AND purpose = 'loan_application_fee'")
      .get(loanId) as unknown as { id: string };

    const before = accountBalance('APPLICATION_FEES_HELD');
    const { body } = await call(`/payments/${payment.id}/confirm`, {
      method: 'POST',
      token: cashier,
      body: { proof: 'KOBEPAY-8891-again' },
    });

    assert.equal(body.alreadyConfirmed, true);
    assert.equal(accountBalance('APPLICATION_FEES_HELD'), before, 'the fee posted twice');
  });

  it('turns the held fee into income when the loan is approved', async () => {
    const incomeBefore = accountBalance('FEE_INCOME');

    // Both sponsors accept, which completes cover and approves the loan.
    for (const index of [18, 23]) {
      const sponsor = await signIn(phoneOf(index));
      const inbox = await call('/sponsorships', { token: sponsor });
      const pledge = (inbox.body.pledges as { id: string; loanId: string; status: string }[]).find(
        (entry) => entry.loanId === loanId && entry.status === 'pending',
      );
      if (!pledge) continue;
      await call(`/sponsorships/${pledge.id}/respond`, {
        method: 'POST',
        token: sponsor,
        body: { decision: 'accept' },
      });
    }

    const loan = await call(`/loans/${loanId}`, { token: borrower });
    assert.equal(loan.body.status, 'approved', 'expected the loan to approve itself');

    // The liability has become income: the circle did what the fee paid for.
    assert.equal(accountBalance('APPLICATION_FEES_HELD'), 0);
    assert.equal(accountBalance('FEE_INCOME') - incomeBefore, 47_500);
    assert.ok(booksBalance());
  });
});

describe('the fee comes back when the loan does not go ahead', () => {
  let borrower: string;
  let loanId: string;

  before(async () => {
    borrower = await signIn(phoneOf(21));
    loanId = await apply(borrower, 3_000_000);

    await call(`/loans/${loanId}/application-fee`, { method: 'POST', token: borrower, body: {} });

    const cashier = await signIn(phoneOf(1));
    const payment = db
      .prepare("SELECT id FROM payment_intents WHERE loan_id = ? AND purpose = 'loan_application_fee'")
      .get(loanId) as unknown as { id: string };
    await call(`/payments/${payment.id}/confirm`, {
      method: 'POST',
      token: cashier,
      body: { proof: 'KOBEPAY-9001' },
    });
  });

  it('is held while the application is live', () => {
    assert.equal(accountBalance('APPLICATION_FEES_HELD'), 47_500);
  });

  it('refunds the net when the borrower withdraws', async () => {
    const { status, body } = await call(`/loans/${loanId}/cancel`, {
      method: 'POST',
      token: borrower,
      body: { reason: 'Found the stock cheaper elsewhere' },
    });

    assert.equal(status, 200, JSON.stringify(body));

    // What the circle received, not what the member paid: it never held the
    // rail's 2,500 and cannot give back what it did not have.
    assert.equal(body.applicationFeeRefunded, 47_500);
    assert.equal(accountBalance('APPLICATION_FEES_HELD'), 0);
    assert.ok(booksBalance());
  });

  it('tells the member the charge is not recoverable', async () => {
    const { body } = await call('/notifications', { token: borrower });
    const refund = (body.notifications as { kind: string; body: string }[]).find(
      (entry) => entry.kind === 'application_fee_refunded',
    );

    assert.ok(refund, 'expected a refund notification');
    assert.match(refund.body, /TSh 47,500/);
    assert.match(refund.body, /not recoverable/);
  });

  it('does not refund twice', async () => {
    const before = accountBalance('APPLICATION_FEES_HELD');
    const { status } = await call(`/loans/${loanId}/cancel`, {
      method: 'POST',
      token: borrower,
      body: { reason: 'again' },
    });

    assert.equal(status, 409, 'a cancelled loan cannot be cancelled again');
    assert.equal(accountBalance('APPLICATION_FEES_HELD'), before);
  });

  it('releases the sponsors', async () => {
    const pledges = db
      .prepare("SELECT status FROM pledges WHERE loan_id = ?")
      .all(loanId) as unknown as { status: string }[];

    for (const pledge of pledges) {
      assert.ok(['withdrawn', 'declined', 'expired'].includes(pledge.status), pledge.status);
    }
  });
});

describe('the platform subscription is the operator’s, not the circle’s', () => {
  it('reports what is owed and says plainly whose money it is', async () => {
    const token = await signIn(phoneOf(25));
    const { status, body } = await call('/subscription', { token });

    assert.equal(status, 200);
    assert.equal(body.operator, 'KobeTech');
    assert.equal(body.provider, 'palmpesa');
    assert.match(body.note, /not a contribution to the circle/);
    assert.match(body.note, /does not appear in the circle/);
  });

  it('never posts to the circle’s books', async () => {
    const token = await signIn(phoneOf(25));
    const cashier = await signIn(phoneOf(1));
    const period = monthKey(today());

    const cashBefore = db
      .prepare("SELECT COALESCE(SUM(debit),0) AS d FROM journal_lines WHERE account = 'CASH'")
      .get() as unknown as { d: number };

    const started = await call('/subscription/pay', { method: 'POST', token, body: { period } });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const confirmed = await call(`/payments/${started.body.payment.id}/confirm`, {
      method: 'POST',
      token: cashier,
      body: { proof: 'PALMPESA-5512' },
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const cashAfter = db
      .prepare("SELECT COALESCE(SUM(debit),0) AS d FROM journal_lines WHERE account = 'CASH'")
      .get() as unknown as { d: number };

    // The circle's cash is untouched: this money went to the operator.
    assert.equal(cashAfter.d, cashBefore.d, 'a subscription payment reached the circle’s books');
    assert.ok(booksBalance());

    // But it is recorded, so the platform knows the member is current.
    const status = await call('/subscription', { token });
    assert.ok((status.body.paidPeriods as string[]).includes(period));
  });

  it('refuses to charge the same month twice', async () => {
    const token = await signIn(phoneOf(25));
    const { status } = await call('/subscription/pay', {
      method: 'POST',
      token,
      body: { period: monthKey(today()) },
    });

    assert.equal(status, 409);
  });
});

describe('the payment rails', () => {
  it('reports which are wired and what each still needs', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/payments/providers', { token });

    const providers = body.providers as {
      name: string;
      configured: boolean;
      supportsRefund: boolean;
      missing: string[];
    }[];
    const byName = new Map(providers.map((provider) => [provider.name, provider]));

    // Cash always works; a circle must be able to take money when an API is down.
    assert.equal(byName.get('manual')!.configured, true);

    // PalmPesa is implemented but needs credentials, and says which.
    const palmpesa = byName.get('palmpesa')!;
    assert.equal(palmpesa.configured, false, 'no token is set in the test environment');
    assert.ok(palmpesa.missing.some((item) => item.includes('PALMPESA_API_TOKEN')));

    // It cannot reverse a collection, and says so rather than failing later.
    assert.equal(palmpesa.supportsRefund, false);

    // KobePay is where the net settles, not something the circle calls.
    assert.equal(byName.has('kobepay'), false, 'KobePay is a settlement account, not a rail');
  });

  it('rejects an unsigned callback', async () => {
    const { status } = await call('/webhooks/palmpesa', {
      method: 'POST',
      body: { reference: 'anything', payment_status: 'COMPLETED' },
    });

    // Without a verified signature anyone who can reach this endpoint could
    // credit any account.
    assert.equal(status, 401);
  });

  it('rejects a callback for an unknown provider', async () => {
    const { status } = await call('/webhooks/not-a-rail', {
      method: 'POST',
      body: { reference: 'x', payment_status: 'COMPLETED' },
    });

    assert.ok(status >= 400);
  });

  it('still answers on the original callback path', async () => {
    const { status } = await call('/payments/callback/palmpesa', {
      method: 'POST',
      body: { reference: 'anything', payment_status: 'COMPLETED' },
    });

    assert.equal(status, 401, 'reachable, and still refuses an unsigned body');
  });
});

describe('reconciliation', () => {
  it('reports the circle and the operator separately', async () => {
    const token = await signIn(phoneOf(1));
    const { status, body } = await call('/payments/reconciliation', { token });

    assert.equal(status, 200);

    // Application fees: gross collected, the rail's charge, and the net that
    // actually reached the circle.
    assert.ok(body.circle.grossCollected >= 50_000);
    assert.equal(body.circle.grossCollected, body.circle.railCharges + body.circle.netReceived);

    // Subscriptions are counted against the operator, not the circle.
    assert.ok(body.operator.collected > 0);
  });

  it('finds no discrepancies in a healthy book', async () => {
    const token = await signIn(phoneOf(1));
    const { body } = await call('/payments/reconciliation', { token });

    assert.deepEqual(body.discrepancies.confirmedButNotPosted, []);
    assert.equal(body.clean, true);
  });
});

describe('settlement — proving the money actually arrived', () => {
  it('imports statement lines, and refuses to count the same statement twice', async () => {
    const token = await signIn(phoneOf(1));

    const statement = {
      account: 'kobepay',
      lines: [
        { id: 'KP-0001', amount: 47_500, settledOn: today(), reference: 'pay_unknown_1' },
        { id: 'KP-0002', amount: 100_000, settledOn: today(), narrative: 'CASH DEPOSIT' },
      ],
    };

    const first = await call('/settlements/import', { method: 'POST', token, body: statement });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.imported, 2);
    assert.equal(first.body.alreadyKnown, 0);

    // The mistake anybody doing this by hand makes eventually.
    const again = await call('/settlements/import', { method: 'POST', token, body: statement });
    assert.equal(again.body.imported, 0);
    assert.equal(again.body.alreadyKnown, 2);
    assert.match(again.body.note as string, /not counted twice/);
  });

  it('refuses a debit dressed as a credit', async () => {
    const token = await signIn(phoneOf(1));
    const { status, body } = await call('/settlements/import', {
      method: 'POST',
      token,
      body: { lines: [{ id: 'KP-BAD', amount: -500, settledOn: today() }] },
    });

    assert.ok(status >= 400);
    assert.match(JSON.stringify(body), /positive|amount/);
  });

  it('is the cashier’s to import, not any member’s', async () => {
    const member = await signIn(phoneOf(10));
    const { status } = await call('/settlements/import', {
      method: 'POST',
      token: member,
      body: { lines: [{ id: 'KP-X', amount: 1_000, settledOn: today() }] },
    });

    assert.equal(status, 403);
  });

  it('reports the exceptions and leaves the agreement alone', async () => {
    const token = await signIn(phoneOf(10));
    const { status, body } = await call('/settlements/reconciliation', { token });

    assert.equal(status, 200);
    assert.equal(body.account, 'kobepay');
    assert.match(body.headline as string, /settlement/);

    const kinds = (body.exceptions as { kind: string }[]).map((problem) => problem.kind);

    // The 100,000 deposit matches no collection, and must be explained.
    assert.ok(kinds.includes('unexpected_credit'), JSON.stringify(kinds));

    // Fees confirmed in these tests were never settled, so they show as money
    // the books claim and the account has not received.
    assert.ok(body.totals.inTransit > 0, 'the books claim money the account has not received');
  });

  it('is readable by every member, because it is the circle’s money', async () => {
    const member = await signIn(phoneOf(11));
    assert.equal((await call('/settlements/reconciliation', { token: member })).status, 200);
    assert.equal((await call('/settlements/reconciliation')).status, 401);
  });
});
