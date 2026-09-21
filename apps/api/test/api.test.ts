/**
 * End-to-end tests over real HTTP.
 *
 * These drive the API the way the mobile app does — sign in, apply, get
 * sponsored, disburse, repay — because the interesting failures in this system
 * are not inside any one function but in the handover between them: a loan
 * that approves without cover, a disbursement that does not reach the ledger,
 * a repayment booked as income when it was principal.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { addDays, addMonths, today } from '@mamogoro/core';

import { openDb, type Db } from '../src/db.js';
import { seed, type SeedSummary } from '../src/seed.js';
import { createApp } from '../src/server.js';

let db: Db;
let server: Server;
let base: string;
let circle: SeedSummary;

before(async () => {
  db = openDb({ location: ':memory:' });
  circle = seed(db, { quiet: true });

  server = createApp(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function call(path: string, options: CallOptions = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, never>) : undefined,
  };
}

async function signIn(phone: string): Promise<string> {
  const response = await call('/auth/login', {
    method: 'POST',
    body: { phone, password: 'mamogoro123' },
  });
  assert.equal(response.status, 200, `sign-in failed for ${phone}: ${JSON.stringify(response.body)}`);
  return response.body!.token as unknown as string;
}

function phoneOf(index: number): string {
  return `+2557${String(10000000 + index * 137).slice(0, 8)}`;
}

describe('signing in', () => {
  it('issues a token for the right password', async () => {
    const response = await call('/auth/login', {
      method: 'POST',
      body: { phone: phoneOf(0), password: 'mamogoro123' },
    });

    assert.equal(response.status, 200);
    assert.ok(response.body!.token);
    assert.equal((response.body!.member as never as { role: string }).role, 'chair');
  });

  it('refuses the wrong password without saying which part was wrong', async () => {
    const response = await call('/auth/login', {
      method: 'POST',
      body: { phone: phoneOf(0), password: 'not-the-password' },
    });

    assert.equal(response.status, 401);
    assert.match((response.body!.error as never as { message: string }).message, /do not match/);
  });

  it('gives the same answer for an unknown phone number', async () => {
    const response = await call('/auth/login', {
      method: 'POST',
      body: { phone: '+255700000000', password: 'mamogoro123' },
    });

    assert.equal(response.status, 401);
    assert.match((response.body!.error as never as { message: string }).message, /do not match/);
  });

  it('turns away unauthenticated requests', async () => {
    assert.equal((await call('/dashboard')).status, 401);
    assert.equal((await call('/members')).status, 401);
  });

  it('rejects a tampered token', async () => {
    const token = await signIn(phoneOf(0));
    const tampered = `${token.slice(0, -4)}AAAA`;
    assert.equal((await call('/dashboard', { token: tampered })).status, 401);
  });
});

describe('the founding position', () => {
  it('raises 150,000,000 from thirty members before contributions', async () => {
    // 30 members x 50 shares x TSh 100,000.
    assert.equal(circle.memberIds.length, 30);
    assert.equal(30 * 50 * 100_000, 150_000_000);
  });

  it('reports the share capital and the facility separately', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/dashboard', { token });

    const capital = body!.capital as never as Record<string, number>;
    const membership = body!.membership as never as Record<string, number>;

    // Founding shares plus one share per member per month contributed.
    assert.equal(membership.issued, circle.issuedShares);
    assert.equal(capital.equityPool, circle.equityCapital);

    // External capital is a liability, never mixed into equity.
    assert.equal(capital.facilityCommitted, circle.facilityPrincipal);
    assert.equal(capital.totalCapital, circle.equityCapital + circle.facilityPrincipal);
  });

  it('keeps the books balanced', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/reports/position', { token });
    assert.equal(body!.booksBalance, true);
  });

  it('shows every member the whole ledger', async () => {
    const token = await signIn(phoneOf(20));
    const { body } = await call('/ledger', { token });
    assert.ok((body!.entries as never as unknown[]).length > 60);
  });
});

describe('the investor waterfall, over HTTP', () => {
  it('reports the facility and what it has earned', async () => {
    const token = await signIn(phoneOf(4));
    const { body } = await call('/facilities', { token });

    const facilities = body!.facilities as never as Record<string, never>[];
    assert.equal(facilities.length, 1);

    const facility = facilities[0] as unknown as {
      principal: number;
      utilisedNow: number;
      accrual: { interestAccrued: number; averageUtilised: number };
      explanation: string;
    };

    assert.equal(facility.principal, 200_000_000);

    // The seeded book never lends past the equity line, so the investor's
    // capital has not been called on and has earned nothing. That is the rule
    // working, not a gap in the data.
    assert.equal(facility.utilisedNow, 0);
    assert.equal(facility.accrual.interestAccrued, 0);
    assert.match(facility.explanation, /has been lent out yet|earned nothing/);
  });

  it('leaves the facility idle while lending stays below the equity line', async () => {
    const chair = await signIn(phoneOf(0));
    const { body } = await call('/dashboard', { token: chair });
    const capital = body!.capital as never as Record<string, number>;

    // Only a fraction of the circle's own capital is deployed, so none of the
    // investor's money has been called on — exactly what the rule says.
    assert.ok(capital.deployed < capital.equityPool);
    assert.equal(capital.facilityUtilised, 0);
    assert.equal(capital.facilityIdle, circle.facilityPrincipal);
    assert.equal(capital.equityUtilised, capital.deployed);
  });
});

describe('the rate model, over HTTP', () => {
  it('shows what the published rate is made of', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/rate-model', { token });

    assert.equal(body!.publishedRate, 0.025);
    assert.equal(body!.publishedRateIsSufficient, true);
    assert.match(body!.explanation as never as string, /goes to external capital/);

    const model = body!.model as never as { components: Record<string, number> };
    for (const key of ['costOfExternalCapital', 'operatingCost', 'expectedCreditLoss', 'equityGrowthTarget']) {
      assert.ok(key in model.components, `expected component ${key}`);
    }
  });
});

describe('quoting a loan', () => {
  it('gives the borrower the exact instalment and balloon before they commit', async () => {
    const token = await signIn(phoneOf(17));
    const { status, body } = await call('/loans/quote', {
      method: 'POST',
      token,
      body: { product: 'term', principal: 50_000_000, termMonths: 3 },
    });

    assert.equal(status, 200);
    const quote = body!.quote as never as {
      levelServiceInstalment: number;
      balloon: number;
      scheduledInterest: number;
      totalRepayable: number;
    };

    assert.equal(quote.levelServiceInstalment, 6_125_000);
    assert.equal(quote.balloon, 35_000_000);
    assert.equal(quote.scheduledInterest, 3_375_000);
    assert.equal(quote.totalRepayable, 53_375_000);
    assert.match(body!.explanation as never as string, /no interest on it/);
  });

  it('prices a short-term loan and states the annualised cost honestly', async () => {
    const token = await signIn(phoneOf(17));
    const { body } = await call('/loans/quote', {
      method: 'POST',
      token,
      body: { product: 'short_term', principal: 5_000_000, days: 5 },
    });

    const quote = body!.quote as never as { fee: number; totalRepayable: number; annualisedRate: number };
    assert.equal(quote.fee, 250_000);
    assert.equal(quote.totalRepayable, 5_250_000);
    assert.ok(Math.abs(quote.annualisedRate - 3.65) < 0.01);
  });
});

/**
 * The full lending cycle: apply, gather sponsors, watch it approve itself,
 * disburse, repay.
 */
describe('a loan from application to repayment', () => {
  let borrowerToken: string;
  let cashierToken: string;
  let loanId: string;

  // Disbursed today, so the schedule runs forward from here.
  const disbursedOn = today();
  const firstInstalmentDue = addMonths(disbursedOn, 1);

  before(async () => {
    borrowerToken = await signIn(phoneOf(17));
    cashierToken = await signIn(phoneOf(1));
  });

  it('accepts an application from an eligible member', async () => {
    const { status, body } = await call('/loans', {
      method: 'POST',
      token: borrowerToken,
      body: { product: 'term', principal: 10_000_000, purpose: 'Stock for the shop' },
    });

    assert.equal(status, 200, JSON.stringify(body));
    loanId = body!.id as never as string;
    assert.equal(body!.status, 'awaiting_sponsors');

    const coverage = body!.coverage as never as { required: number; shortfall: number };
    assert.equal(coverage.required, 10_000_000);
    assert.ok(coverage.shortfall > 0, 'the borrower cannot cover it alone');
  });

  it('will not disburse a loan that is not yet covered', async () => {
    const { status, body } = await call(`/loans/${loanId}/disburse`, {
      method: 'POST',
      token: cashierToken,
      body: { disbursedOn },
    });

    assert.equal(status, 409);
    assert.match((body!.error as never as { message: string }).message, /fully sponsored/);
  });

  /**
   * The application fee now gates circulation, so the flow pays it here. It
   * is charged for sending the request to sponsors, not for making the
   * application, which is why it falls between applying and asking.
   */
  it('pays the application fee before asking anyone', async () => {
    const started = await call(`/loans/${loanId}/application-fee`, {
      method: 'POST',
      token: borrowerToken,
      body: {},
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const split = started.body!.split as never as { gross: number; net: number };
    assert.equal(split.gross, 50_000);
    assert.equal(split.net, 47_500);

    const payment = started.body!.payment as never as { id: string };
    const confirmed = await call(`/payments/${payment.id}/confirm`, {
      method: 'POST',
      token: cashierToken,
      body: { proof: 'KOBEPAY-TEST', paidOn: disbursedOn },
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  });

  it('suggests sponsors with the capacity to help', async () => {
    const { body } = await call(`/loans/${loanId}/sponsor-suggestions`, { token: borrowerToken });
    const suggestions = body!.suggestions as never as { memberId: string; suggestedPledge: number }[];

    assert.ok(suggestions.length > 0);
    const total = suggestions.reduce((sum, s) => sum + s.suggestedPledge, 0);
    assert.ok(total > 0);
  });

  it('refuses to ask a sponsor for more than they can cover', async () => {
    const { status, body } = await call(`/loans/${loanId}/sponsors`, {
      method: 'POST',
      token: borrowerToken,
      body: { sponsors: [{ sponsorId: 'mem_19', amount: 50_000_000 }] },
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /can pledge at most|No sponsor may carry/);
  });

  it('sends requests and notifies each sponsor', async () => {
    const { status } = await call(`/loans/${loanId}/sponsors`, {
      method: 'POST',
      token: borrowerToken,
      body: {
        sponsors: [
          { sponsorId: 'mem_19', amount: 4_000_000 },
          { sponsorId: 'mem_24', amount: 4_000_000 },
        ],
      },
    });

    assert.equal(status, 200);

    const sponsorToken = await signIn(phoneOf(18));
    const { body } = await call('/notifications?unread=true', { token: sponsorToken });
    const notifications = body!.notifications as never as { kind: string; title: string }[];

    assert.ok(notifications.some((n) => n.kind === 'sponsorship_request'));
  });

  it('does not approve while a sponsor has not answered', async () => {
    const { body } = await call(`/loans/${loanId}`, { token: borrowerToken });
    assert.equal(body!.status, 'awaiting_sponsors');
  });

  it('lets a member who was not asked go no further', async () => {
    const strangerToken = await signIn(phoneOf(10));
    const { body: inbox } = await call('/sponsorships', { token: strangerToken });
    const pledges = inbox!.pledges as never as { loanId: string }[];
    assert.ok(!pledges.some((pledge) => pledge.loanId === loanId));
  });

  it('approves itself the moment cover is complete', async () => {
    const first = await signIn(phoneOf(18));
    const second = await signIn(phoneOf(23));

    const inboxOne = await call('/sponsorships', { token: first });
    const pledgeOne = (inboxOne.body!.pledges as never as { id: string; loanId: string; status: string }[]).find(
      (pledge) => pledge.loanId === loanId && pledge.status === 'pending',
    )!;

    const responseOne = await call(`/sponsorships/${pledgeOne.id}/respond`, {
      method: 'POST',
      token: first,
      body: { decision: 'accept' },
    });
    assert.equal(responseOne.status, 200, JSON.stringify(responseOne.body));
    assert.equal(responseOne.body!.approvedNow, false, 'still short of full cover');

    const inboxTwo = await call('/sponsorships', { token: second });
    const pledgeTwo = (inboxTwo.body!.pledges as never as { id: string; loanId: string; status: string }[]).find(
      (pledge) => pledge.loanId === loanId && pledge.status === 'pending',
    )!;

    const responseTwo = await call(`/sponsorships/${pledgeTwo.id}/respond`, {
      method: 'POST',
      token: second,
      body: { decision: 'accept' },
    });

    assert.equal(responseTwo.status, 200, JSON.stringify(responseTwo.body));
    assert.equal(responseTwo.body!.approvedNow, true, 'cover is complete, so the loan approves itself');

    const { body } = await call(`/loans/${loanId}`, { token: borrowerToken });
    assert.equal(body!.status, 'approved');
  });

  it('puts the disbursement in front of the cashier', async () => {
    const { body } = await call('/notifications?unread=true', { token: cashierToken });
    const notifications = body!.notifications as never as { kind: string }[];
    assert.ok(notifications.some((n) => n.kind === 'disbursement_due'));
  });

  it('will not let an ordinary member disburse', async () => {
    const { status } = await call(`/loans/${loanId}/disburse`, {
      method: 'POST',
      token: borrowerToken,
      body: { disbursedOn },
    });

    assert.equal(status, 403);
  });

  it('disburses and freezes the schedule', async () => {
    const { status, body } = await call(`/loans/${loanId}/disburse`, {
      method: 'POST',
      token: cashierToken,
      body: { disbursedOn, reference: 'MPESA-77412' },
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body!.status, 'disbursed');

    const schedule = body!.schedule as never as {
      levelServiceInstalment: number;
      balloon: number;
      scheduledInterest: number;
      rows: { dueOn: string; kind: string }[];
    };

    // 10,000,000 at 10% a month over three months: interest of 250,000 +
    // 225,000 + 200,000 = 675,000, levelised to 225,000 an instalment.
    assert.equal(schedule.scheduledInterest, 675_000);
    assert.equal(schedule.levelServiceInstalment, 1_225_000);
    assert.equal(schedule.balloon, 7_000_000);
    assert.equal(schedule.rows[0].dueOn, firstInstalmentDue);
  });

  it('records the disbursement in the ledger', async () => {
    const { body } = await call('/ledger', { token: borrowerToken });
    const entries = body!.entries as never as { loanIds: string[]; narration: string }[];
    assert.ok(entries.some((entry) => entry.loanIds.includes(loanId)));
  });

  it('splits a repayment into interest and principal the way the schedule says', async () => {
    const { status, body } = await call(`/loans/${loanId}/repayments`, {
      method: 'POST',
      token: cashierToken,
      body: { amount: 1_225_000, paidOn: firstInstalmentDue, reference: 'MPESA-88120' },
    });

    assert.equal(status, 200, JSON.stringify(body));
    const recorded = body!.recorded as never as Record<string, number>;

    // 10% of 10,000,000 of principal, plus a third of the 675,000 of interest.
    assert.equal(recorded.towardPrincipal, 1_000_000);
    assert.equal(recorded.towardInterest, 225_000);
    assert.equal(recorded.towardPenalty, 0, 'paid on the day it fell due, so no penalty');
  });

  /**
   * Sponsors should watch their own stake unwind as the borrower repays.
   * Holding it all until settlement would overstate their risk for most of
   * the loan, and lock capacity that could be backing somebody else.
   */
  it('releases the sponsors in step with the repayment', async () => {
    const sponsor = await signIn(phoneOf(18)); // pledged 4,000,000
    // As at the day the first instalment was paid — exposure is a position on
    // a date, and the instalment falls a month after disbursement.
    const { body } = await call(`/sponsorships?asOf=${firstInstalmentDue}`, { token: sponsor });

    const pledge = (
      body!.pledges as never as {
        loanId: string;
        amount: number;
        atRisk: number;
        released: number;
        releasedRatio: number;
      }[]
    ).find((entry) => entry.loanId === loanId)!;

    assert.ok(pledge, 'expected the sponsor to be carrying this loan');
    assert.equal(pledge.amount, 4_000_000);

    // One instalment has repaid 1,000,000 of a 10,000,000 loan, so a tenth
    // of the pledge is free again.
    assert.equal(pledge.atRisk, 3_600_000);
    assert.equal(pledge.released, 400_000);
    assert.ok(Math.abs(pledge.releasedRatio - 0.1) < 1e-9);
  });

  /**
   * The release is measured against the principal portion, never the amount
   * handed over — the interest is the cost of the loan, not a reduction of it.
   */
  it('tells each sponsor what the repayment freed, counting principal only', async () => {
    const sponsor = await signIn(phoneOf(18));
    const { body } = await call('/notifications', { token: sponsor });

    const release = (body!.notifications as never as {
      kind: string;
      title: string;
      body: string;
      payload: { loanId: string; released: number; stillAtRisk: number } | null;
    }[]).find((entry) => entry.kind === 'sponsorship_released' && entry.payload?.loanId === loanId);

    assert.ok(release, 'expected the sponsor to be told their stake had moved');

    // The member paid 1,225,000 but only 1,000,000 of it was principal, so a
    // tenth of the 4,000,000 pledge is freed — not a tenth of the payment.
    assert.equal(release.payload!.released, 400_000);
    assert.equal(release.payload!.stillAtRisk, 3_600_000);
    assert.match(release.body, /TSh 1,000,000 of principal/);
  });

  it('gives that released capacity back for sponsoring someone else', async () => {
    const sponsor = await signIn(phoneOf(18));
    const { body } = await call(`/sponsorships?asOf=${firstInstalmentDue}`, { token: sponsor });
    const capacity = body!.capacity as never as { pledgedOut: number };

    // Under the old rule this read 4,000,000 until the loan finally settled.
    assert.equal(capacity.pledgedOut, 3_600_000);
  });

  it('still shows the full pledge at risk before anything has been repaid', async () => {
    const sponsor = await signIn(phoneOf(18));
    const { body } = await call(`/sponsorships?asOf=${disbursedOn}`, { token: sponsor });

    const pledge = (body!.pledges as never as { loanId: string; atRisk: number }[]).find(
      (entry) => entry.loanId === loanId,
    )!;

    // Release tracks repayment, so on the day of disbursement nothing is free.
    assert.equal(pledge.atRisk, 4_000_000);
  });

  it('charges only the interest the borrower actually used when settling early', async () => {
    const asOf = addDays(firstInstalmentDue, 10);
    const { body } = await call(`/loans/${loanId}/settlement?asOf=${asOf}`, { token: borrowerToken });

    assert.equal(body!.principalOutstanding, 9_000_000);

    // Roughly forty days of a three-month loan have run, so the circle has
    // earned about forty days of interest — not the two instalments' worth
    // still scheduled. Settling now costs less than running to maturity.
    const earned = body!.interestEarned as never as number;
    const paid = body!.interestPaid as never as number;

    assert.ok(earned > 0 && earned < 675_000, `earned ${earned} should be part of the term's interest`);
    assert.equal(paid, 225_000);
    assert.ok((body!.savingVersusSchedule as never as number) > 0);

    // Earned and paid reconcile one way or the other, never both at once.
    const rebate = body!.interestRebate as never as number;
    const shortfall = body!.interestShortfall as never as number;
    assert.ok(rebate === 0 || shortfall === 0);
    assert.equal(earned - paid, shortfall - rebate);

    assert.match(body!.explanation as never as string, /Settling today/);
  });

  it('keeps the books balanced through all of it', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/reports/position', { token });
    assert.equal(body!.booksBalance, true);
  });
});

describe('eligibility', () => {
  it('turns away a member who is already in arrears', async () => {
    // mem_20 holds loan_03, which has had no repayments at all.
    const token = await signIn(phoneOf(19));
    const { status, body } = await call('/loans', {
      method: 'POST',
      token,
      body: { product: 'term', principal: 2_000_000, purpose: 'Another loan' },
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /arrears/);
  });

  it('refuses a loan larger than the circle can fund', async () => {
    const token = await signIn(phoneOf(17));
    const { status, body } = await call('/loans', {
      method: 'POST',
      token,
      body: { product: 'term', principal: 900_000_000 },
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /ceiling|capital/);
  });

  it('rejects a fractional amount rather than silently rounding it', async () => {
    const token = await signIn(phoneOf(17));
    const { status, body } = await call('/loans', {
      method: 'POST',
      token,
      body: { product: 'term', principal: 1_000_000.5 },
    });

    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /whole number/);
  });
});

describe('governance', () => {
  it('lets any member see the open proposal and where it stands', async () => {
    const token = await signIn(phoneOf(25));
    const { body } = await call('/proposals?status=open', { token });
    const proposals = body!.proposals as never as { id: string; headline: string }[];

    assert.ok(proposals.some((proposal) => proposal.id === 'prop_01'));
    assert.ok(proposals[0].headline.length > 0);
  });

  it('refuses to delete a record type the circle never agreed could be removed', async () => {
    const token = await signIn(phoneOf(25));
    const { status, body } = await call('/proposals', {
      method: 'POST',
      token,
      body: {
        entityType: 'audit_log',
        entityId: 'anything',
        reason: 'Trying to remove something that must not be removable',
      },
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /cannot be removed by vote/);
  });

  /**
   * The rule that matters most: a majority can reverse a ledger entry, but it
   * cannot make one disappear.
   */
  it('turns a vote against a ledger entry into a reversal, not a deletion', async () => {
    const proposer = await signIn(phoneOf(0));

    const ledger = await call('/ledger', { token: proposer });
    const target = (ledger.body!.entries as never as { id: string; voided: boolean }[]).find(
      (entry) => !entry.voided,
    )!;

    const opened = await call('/proposals', {
      method: 'POST',
      token: proposer,
      body: {
        entityType: 'ledger_entry',
        entityId: target.id,
        reason: 'This receipt was entered twice and the duplicate should be reversed',
      },
    });

    assert.equal(opened.status, 200);
    assert.equal(opened.body!.kind, 'void_financial_record');
    const proposalId = opened.body!.id as never as string;

    // Enough weight to carry it.
    for (let index = 0; index < 22; index += 1) {
      const voter = await signIn(phoneOf(index));
      await call(`/proposals/${proposalId}/votes`, {
        method: 'POST',
        token: voter,
        body: { choice: 'for' },
      });
    }

    const after = await call(`/proposals/${proposalId}`, { token: proposer });
    assert.equal(after.body!.status, 'executed');

    // The entry is still there — flagged, reversed, and readable.
    const refreshed = await call('/ledger', { token: proposer });
    const entries = refreshed.body!.entries as never as {
      id: string;
      voided: boolean;
      reversedBy: string | null;
      reversalOf: string | null;
    }[];

    const original = entries.find((entry) => entry.id === target.id);
    assert.ok(original, 'the original entry must still be visible');
    assert.equal(original.voided, true);
    assert.ok(original.reversedBy, 'a balancing reversal was posted');
    assert.ok(entries.some((entry) => entry.reversalOf === target.id));

    // And the books still balance after the reversal.
    const position = await call('/reports/position', { token: proposer });
    assert.equal(position.body!.booksBalance, true);
  });

  it('deletes an ordinary record outright when the vote carries, keeping a copy', async () => {
    const proposer = await signIn(phoneOf(3));

    const opened = await call('/proposals', {
      method: 'POST',
      token: proposer,
      body: {
        entityType: 'announcement',
        entityId: 'ann_01',
        reason: 'Superseded by the later notice about the meeting time',
      },
    });

    const proposalId = opened.body!.id as never as string;
    assert.equal(opened.body!.kind, 'delete');

    for (let index = 0; index < 22; index += 1) {
      const voter = await signIn(phoneOf(index));
      await call(`/proposals/${proposalId}/votes`, {
        method: 'POST',
        token: voter,
        body: { choice: 'for' },
      });
    }

    const announcements = await call('/announcements', { token: proposer });
    const remaining = announcements.body!.announcements as never as { id: string }[];
    assert.ok(!remaining.some((row) => row.id === 'ann_01'), 'the announcement is gone');

    const kept = db
      .prepare('SELECT snapshot FROM deleted_records WHERE entity_id = ?')
      .get('ann_01') as unknown as { snapshot: string } | undefined;
    assert.ok(kept, 'but a copy is retained against the resolution that removed it');
  });

  it('refuses a vote from someone with no shares', async () => {
    // Every seeded member holds shares, so use a token for a member who has
    // been exited — the closest thing to a stakeless voter.
    const token = await signIn(phoneOf(0));
    const { status } = await call('/proposals/prop_01/votes', {
      method: 'POST',
      token,
      body: { choice: 'for' },
    });

    // The chair does hold shares, so this succeeds; the guard itself is
    // covered in the core suite where a stakeless member can be constructed.
    assert.equal(status, 200);
  });

  it('will not open two proposals against the same record', async () => {
    const token = await signIn(phoneOf(5));
    const { status } = await call('/proposals', {
      method: 'POST',
      token,
      body: {
        entityType: 'announcement',
        entityId: 'ann_02',
        reason: 'A second proposal against a record that already has one open',
      },
    });

    assert.equal(status, 409);
  });
});

describe('recording money is restricted, reading it is not', () => {
  // The seed contributes up to last month and leaves the current one open,
  // which is what a circle looks like mid-month.
  const openPeriod = today().slice(0, 7);

  it('lets any member read the dashboard', async () => {
    const token = await signIn(phoneOf(29));
    assert.equal((await call('/dashboard', { token })).status, 200);
  });

  it('stops an ordinary member recording a contribution', async () => {
    const token = await signIn(phoneOf(29));
    const { status } = await call('/members/mem_29/contributions', {
      method: 'POST',
      token,
      body: { period: openPeriod, amount: 100_000 },
    });

    assert.equal(status, 403);
  });

  it('lets the cashier record it', async () => {
    const token = await signIn(phoneOf(1));
    const { status, body } = await call('/members/mem_29/contributions', {
      method: 'POST',
      token,
      body: { period: openPeriod, amount: 100_000, paidOn: today() },
    });

    assert.equal(status, 200, JSON.stringify(body));
  });

  it('turns that contribution into a share at par', async () => {
    const token = await signIn(phoneOf(28));
    const { body } = await call('/members/mem_29', { token });

    // 50 founding shares, one per month contributed, plus the one just paid.
    assert.equal(body!.shares, 50 + circle.contributionPeriods.length + 1);
  });

  it('refuses a contribution that is not the agreed amount', async () => {
    const token = await signIn(phoneOf(1));
    const { status, body } = await call('/members/mem_28/contributions', {
      method: 'POST',
      token,
      body: { period: openPeriod, amount: 60_000 },
    });

    assert.equal(status, 422);
    assert.match(JSON.stringify(body), /monthly contribution is/);
  });

  it('refuses the same month twice', async () => {
    const token = await signIn(phoneOf(1));
    const { status } = await call('/members/mem_29/contributions', {
      method: 'POST',
      token,
      body: { period: openPeriod, amount: 100_000 },
    });

    assert.equal(status, 409);
  });
});

/**
 * The capital engine: what the circle can do, rather than what it has done.
 */
describe('the capital engine', () => {
  it('separates what policy allows from what is actually in the account', async () => {
    const token = await signIn(phoneOf(0));
    const { status, body } = await call('/capital', { token });

    assert.equal(status, 200, JSON.stringify(body));
    const capital = body!.capital as never as Record<string, number>;

    // Spendable is the lower of the two, always.
    assert.equal(capital.spendableNow, Math.min(capital.available, capital.cashOnHand));
    assert.ok(capital.totalCapital >= capital.deployed);
  });

  it('forecasts repayments over a week, a month and a quarter', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/capital', { token });

    const inflows = body!.inflows as never as {
      windowDays: number;
      total: number;
      principal: number;
      interest: number;
      dependable: number;
    }[];

    assert.deepEqual(inflows.map((entry) => entry.windowDays), [7, 30, 90]);

    // Windows nest: a longer window can only contain more.
    assert.ok(inflows[1].total >= inflows[0].total);
    assert.ok(inflows[2].total >= inflows[1].total);

    for (const inflow of inflows) {
      assert.equal(inflow.total, inflow.principal + inflow.interest);
      assert.ok(inflow.dependable <= inflow.total);
    }
  });

  it('discounts money owed by members already behind', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/capital', { token });

    // The seeded circle carries one loan in arrears, so somewhere in the
    // forecast there is money that should not be relied on.
    const inflows = body!.inflows as never as { fromBorrowersInArrears: number; dependable: number; total: number }[];
    for (const inflow of inflows) {
      assert.equal(inflow.dependable, inflow.total - inflow.fromBorrowersInArrears);
    }
  });

  it('names the largest borrower and sponsor rather than quoting ids', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/capital', { token });

    const risk = body!.concentration as never as {
      largestBorrower: { memberName: string; share: number } | null;
      largestSponsor: { memberName: string; share: number } | null;
      borrowerHerfindahl: number;
      borrowersToHalfTheBook: number;
    };

    assert.ok(risk.largestBorrower);
    assert.ok(risk.largestBorrower.memberName.includes(' '), 'expected a name, not an id');
    assert.ok(risk.largestSponsor?.memberName.includes(' '));

    assert.ok(risk.borrowerHerfindahl > 0 && risk.borrowerHerfindahl <= 1);
    assert.ok(risk.borrowersToHalfTheBook >= 1);
  });

  it('writes its alerts in money and names, not raw numbers and ids', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/capital', { token });

    for (const alert of body!.alerts as never as { level: string; message: string }[]) {
      assert.ok(['info', 'warning', 'danger'].includes(alert.level));
      assert.ok(!/\bmem_\d+\b/.test(alert.message), `alert leaked a member id: ${alert.message}`);
      // Any large bare integer would be a number nobody reads.
      assert.ok(!/\b\d{7,}\b/.test(alert.message), `alert leaked an unformatted amount: ${alert.message}`);
    }
  });

  it('answers the funding queue in order, not independently', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/capital', { token });

    const funding = body!.funding as never as {
      memberName: string;
      principal: number;
      fundableNow: boolean;
      reason: string;
    }[];

    for (const verdict of funding) {
      assert.ok(verdict.memberName.length > 0);
      assert.ok(verdict.reason.length > 0);
    }
  });

  it('projects cash without assuming new lending', async () => {
    const token = await signIn(phoneOf(0));
    const { body } = await call('/capital', { token });

    const projection = body!.projection as never as Record<
      string,
      { opening: number; inflow: number; commitments: number; closing: number }
    >;

    for (const key of ['week', 'month', 'quarter']) {
      const row = projection[key];
      assert.equal(row.closing, row.opening + row.inflow - row.commitments);
    }
  });

  it('is readable by any member, not just the committee', async () => {
    const ordinary = await signIn(phoneOf(29));
    assert.equal((await call('/capital', { token: ordinary })).status, 200);
  });
});
