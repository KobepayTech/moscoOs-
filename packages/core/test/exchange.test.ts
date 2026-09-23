import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type CapitalOffer,
  type CircleConfig,
  type FundingCall,
  ExchangeError,
  allocateOffers,
  assessFundingNeed,
  callPosition,
  defaultCircleConfig,
  describeOffer,
  facilityFromAllocation,
  validateConfig,
  validateFundingCall,
} from '../src/index.js';

const TODAY = '2026-09-22';

function config(overrides: Partial<CircleConfig['exchange']> = {}): CircleConfig {
  const base = defaultCircleConfig();
  return { ...base, exchange: { ...base.exchange, ...overrides } };
}

/** A call the circle could actually publish: 3-month loans, 4-month money. */
function call(overrides: Partial<FundingCall> = {}): FundingCall {
  return {
    id: 'call_1',
    purpose: 'Fund the approved loan queue',
    target: 50_000_000,
    minimumOffer: 1_000_000,
    termMonths: 4,
    monthlyRate: 0.015,
    opensOn: '2026-09-20',
    closesOn: '2026-10-04',
    status: 'open',
    ...overrides,
  };
}

function offer(overrides: Partial<CapitalOffer> = {}): CapitalOffer {
  return {
    id: 'off_1',
    callId: 'call_1',
    memberId: 'mem_01',
    amount: 10_000_000,
    offeredOn: '2026-09-21',
    status: 'offered',
    ...overrides,
  };
}

describe('deciding whether to ask the members at all', () => {
  it('raises nothing when the circle can fund what it approved', () => {
    const need = assessFundingNeed(config(), {
      committedLending: 30_000_000,
      spendableNow: 80_000_000,
      expectedInflow: 0,
    });

    assert.equal(need.needed, false);
    assert.equal(need.gap, 0);
    assert.match(need.reason, /can fund everything it has approved/);
  });

  it('raises nothing when repayments already due close the gap', () => {
    // Paying a return on capital the circle is about to have anyway is the
    // investor's idle-money problem turned back onto the members.
    const need = assessFundingNeed(config(), {
      committedLending: 80_000_000,
      spendableNow: 20_000_000,
      expectedInflow: 70_000_000,
    });

    assert.equal(need.needed, false);
    assert.match(need.reason, /repayments due cover it/);
  });

  it('names the shortfall when the gap is real', () => {
    const need = assessFundingNeed(config(), {
      committedLending: 80_000_000,
      spendableNow: 20_000_000,
      expectedInflow: 15_000_000,
    });

    assert.equal(need.needed, true);
    assert.equal(need.gap, 45_000_000);
    assert.equal(need.suggestedTarget, 45_000_000, 'already a round figure');
  });

  it('rounds a target up to something a person would publish', () => {
    const need = assessFundingNeed(config({ targetRoundingStep: 1_000_000 }), {
      committedLending: 43_450_000,
      spendableNow: 0,
      expectedInflow: 0,
    });

    assert.equal(need.gap, 43_450_000);
    assert.equal(need.suggestedTarget, 44_000_000);
  });

  it('states the terms the circle can afford before anyone drafts a call', () => {
    const need = assessFundingNeed(config(), {
      committedLending: 50_000_000,
      spendableNow: 0,
      expectedInflow: 0,
    });

    // 3-month loans plus a 1-month buffer; 2.5% lending less a 1% spread.
    assert.equal(need.minimumTermMonths, 4);
    assert.equal(need.maximumMonthlyRate, 0.015);
  });
});

describe('a call must not promise what the circle cannot keep', () => {
  const context = { existingFacilityPrincipal: 0, equityCapital: 150_000_000 };

  it('publishes a sound call without complaint', () => {
    assert.deepEqual(validateFundingCall(config(), call(), context), []);
  });

  it('refuses to pay more than the lending rate can carry', () => {
    // 2.5% lent, 2.2% paid: a circle destroying its own capital while looking
    // busy.
    const problems = validateFundingCall(config(), call({ monthlyRate: 0.022 }), context);

    assert.equal(problems[0].code, 'rate_too_high');
    assert.match(problems[0].message, /The most it can afford is 1\.50%/);
  });

  it('allows exactly the ceiling, and refuses a whisker above it', () => {
    assert.deepEqual(validateFundingCall(config(), call({ monthlyRate: 0.015 }), context), []);
    assert.equal(
      validateFundingCall(config(), call({ monthlyRate: 0.0151 }), context)[0].code,
      'rate_too_high',
    );
  });

  it('refuses to borrow shorter than it lends', () => {
    // The failure mode that ends institutions: money taken for two months
    // funding loans that run for three.
    const problems = validateFundingCall(config(), call({ termMonths: 2 }), context);

    assert.equal(problems[0].code, 'term_too_short');
    assert.match(problems[0].message, /shortest safe term is 4 months/);
  });

  it('refuses to let the circle owe more than it owns', () => {
    const problems = validateFundingCall(config({ maxExternalToEquity: 2 }), call({ target: 200_000_000 }), {
      existingFacilityPrincipal: 200_000_000,
      equityCapital: 150_000_000,
    });

    assert.equal(problems[0].code, 'over_leveraged');
    assert.match(problems[0].message, /somebody else's business/);
  });

  it('refuses a call that closes before it opens, or asks for nothing', () => {
    assert.equal(
      validateFundingCall(config(), call({ opensOn: '2026-10-04', closesOn: '2026-09-20' }), context)[0].code,
      'window',
    );
    assert.equal(validateFundingCall(config(), call({ target: 0 }), context)[0].code, 'target');
  });

  it('reports every problem at once rather than one at a time', () => {
    const problems = validateFundingCall(config(), call({ monthlyRate: 0.03, termMonths: 1 }), context);

    assert.deepEqual(problems.map((problem) => problem.code).sort(), ['rate_too_high', 'term_too_short']);
  });
});

describe('the configuration itself', () => {
  it('refuses a spread that leaves nothing for losses', () => {
    const problems = validateConfig(config({ minimumSpread: 0 }));
    assert.ok(problems.some((problem) => problem.path === 'exchange.minimumSpread'));
  });

  it('refuses a spread wider than the lending rate', () => {
    // No call could ever be published under these settings.
    const problems = validateConfig(config({ minimumSpread: 0.05 }));
    assert.ok(problems.some((problem) => problem.message.includes('leaves nothing to offer members')));
  });

  it('refuses a negative maturity buffer', () => {
    const problems = validateConfig(config({ maturityBufferMonths: -1 }));
    assert.ok(problems.some((problem) => problem.path === 'exchange.maturityBufferMonths'));
  });

  it('leaves a circle that has switched the exchange off alone', () => {
    const problems = validateConfig(config({ enabled: false, minimumSpread: 0 }));
    assert.equal(
      problems.some((problem) => problem.path.startsWith('exchange.')),
      false,
    );
  });
});

describe('where a call stands', () => {
  it('counts what has been offered and what is still needed', () => {
    const position = callPosition(
      config(),
      call(),
      [offer({ id: 'a', amount: 20_000_000 }), offer({ id: 'b', memberId: 'mem_02', amount: 10_000_000 })],
      TODAY,
    );

    assert.equal(position.offered, 30_000_000);
    assert.equal(position.remaining, 20_000_000);
    assert.equal(position.fullyFunded, false);
    assert.match(position.headline, /still needed/);
  });

  it('says plainly when a call is full', () => {
    const position = callPosition(config(), call(), [offer({ amount: 60_000_000 })], TODAY);

    assert.equal(position.fullyFunded, true);
    assert.equal(position.oversubscribedBy, 10_000_000);
    assert.match(position.headline, /oversubscribed by/);
  });

  it('ignores withdrawn offers', () => {
    const position = callPosition(
      config(),
      call(),
      [offer({ id: 'a', amount: 20_000_000 }), offer({ id: 'b', amount: 20_000_000, status: 'withdrawn' })],
      TODAY,
    );

    assert.equal(position.offered, 20_000_000);
  });

  it('closes on the closing date, not a day after', () => {
    assert.equal(callPosition(config(), call(), [], '2026-10-04').open, true);
    assert.equal(callPosition(config(), call(), [], '2026-10-05').open, false);
    assert.equal(callPosition(config(), call(), [], '2026-09-19').open, false, 'not open before it opens');
  });
});

describe('allocating an oversubscribed call', () => {
  it('takes everybody in full when there is room', () => {
    const allocations = allocateOffers(config(), call(), [
      offer({ id: 'a', memberId: 'mem_01', amount: 20_000_000 }),
      offer({ id: 'b', memberId: 'mem_02', amount: 15_000_000 }),
    ]);

    assert.deepEqual(
      allocations.map((entry) => entry.allocated),
      [20_000_000, 15_000_000],
    );
    assert.ok(allocations.every((entry) => entry.reason === 'Taken in full'));
  });

  it('scales pro rata rather than rewarding whoever answered first', () => {
    // A call open for a week that in practice closes in the first ten minutes
    // is not a way to run a members' circle.
    const allocations = allocateOffers(config({ maxShareOfOneCall: 1 }), call({ target: 30_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 30_000_000, offeredOn: '2026-09-20' }),
      offer({ id: 'b', memberId: 'mem_02', amount: 30_000_000, offeredOn: '2026-09-24' }),
    ]);

    assert.deepEqual(
      allocations.map((entry) => entry.allocated),
      [15_000_000, 15_000_000],
      'the later offer is not punished for being later',
    );
  });

  it('allocates to the shilling', () => {
    const allocations = allocateOffers(config({ maxShareOfOneCall: 1 }), call({ target: 10_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 7_000_001 }),
      offer({ id: 'b', memberId: 'mem_02', amount: 7_000_001 }),
      offer({ id: 'c', memberId: 'mem_03', amount: 7_000_001 }),
    ]);

    assert.equal(
      allocations.reduce((total, entry) => total + entry.allocated, 0),
      10_000_000,
      'largest remainder, so nothing is orphaned',
    );
  });

  it('caps one member’s share and redistributes what that displaces', () => {
    const allocations = allocateOffers(config({ maxShareOfOneCall: 0.4 }), call({ target: 10_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 9_000_000 }),
      offer({ id: 'b', memberId: 'mem_02', amount: 5_000_000 }),
      offer({ id: 'c', memberId: 'mem_03', amount: 5_000_000 }),
    ]);

    const byId = new Map(allocations.map((entry) => [entry.offerId, entry]));
    assert.equal(byId.get('a')!.allocated, 4_000_000, '40% of the call, no more');
    assert.match(byId.get('a')!.reason, /ceiling on one member's share/);

    // Capping one member must not silently shrink the raise.
    assert.equal(
      allocations.reduce((total, entry) => total + entry.allocated, 0),
      10_000_000,
    );
  });

  it('never allocates a member more than they offered', () => {
    const allocations = allocateOffers(config(), call({ target: 50_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 1_000_000 }),
      offer({ id: 'b', memberId: 'mem_02', amount: 60_000_000 }),
    ]);

    assert.ok(allocations.every((entry) => entry.allocated <= entry.offered));
  });

  it('tells a scaled member why', () => {
    const allocations = allocateOffers(config({ maxShareOfOneCall: 1 }), call({ target: 10_000_000 }), [
      offer({ id: 'a', amount: 20_000_000 }),
    ]);

    assert.equal(allocations[0].scaledBackBy, 10_000_000);
    assert.match(allocations[0].reason, /oversubscribed by/);
  });

  it('has nothing to allocate when nobody offered', () => {
    assert.deepEqual(allocateOffers(config(), call(), []), []);
  });
});

describe('becoming a facility', () => {
  it('carries the term across as the date the money is committed until', () => {
    const facility = facilityFromAllocation(
      call({ termMonths: 4 }),
      { offerId: 'a', memberId: 'mem_01', offered: 10_000_000, allocated: 10_000_000, scaledBackBy: 0, reason: '' },
      '2026-09-22',
    );

    assert.equal(facility.investorMemberId, 'mem_01');
    assert.equal(facility.principal, 10_000_000);
    assert.equal(facility.monthlyRate, 0.015);
    // The whole reason the maturity check matters: this is the date before
    // which the member cannot ask for it back.
    assert.equal(facility.committedUntil, '2027-01-22');
  });

  it('refuses to create a facility for nothing', () => {
    assert.throws(
      () =>
        facilityFromAllocation(
          call(),
          { offerId: 'a', memberId: 'mem_01', offered: 5_000_000, allocated: 0, scaledBackBy: 5_000_000, reason: '' },
          TODAY,
        ),
      ExchangeError,
    );
  });
});

describe('what a member is told before they commit', () => {
  it('quotes the best case and says it is the best case', () => {
    const quote = describeOffer(config(), call({ monthlyRate: 0.015, termMonths: 4 }), 10_000_000);

    assert.equal(quote.bestCase, 600_000, '1.5% × 4 months on 10,000,000');

    // A member who reads "1.5% a month" and assumes that is what their money
    // will earn has not been told the truth.
    assert.match(quote.note, /earns on what is actually lent out/);
    assert.match(quote.note, /idle capital earns nothing/);
  });
});

describe('fairness under the concentration cap', () => {
  it('treats identical offers identically, whatever order they arrived in', () => {
    // The bug this guards: capping the largest offer frees an amount, and
    // giving it to whoever came first left two equal offers with unequal
    // allocations (3,368,421 against 2,631,579 on a real run).
    const allocations = allocateOffers(config({ maxShareOfOneCall: 0.4 }), call({ target: 10_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 9_000_000, offeredOn: '2026-09-20' }),
      offer({ id: 'b', memberId: 'mem_02', amount: 5_000_000, offeredOn: '2026-09-21' }),
      offer({ id: 'c', memberId: 'mem_03', amount: 5_000_000, offeredOn: '2026-09-22' }),
    ]);

    const byId = new Map(allocations.map((entry) => [entry.offerId, entry.allocated]));

    assert.equal(byId.get('a'), 4_000_000, 'capped at 40%');
    assert.equal(byId.get('b'), byId.get('c'), 'equal offers, equal allocations');
    assert.equal(
      allocations.reduce((total, entry) => total + entry.allocated, 0),
      10_000_000,
      'and the call is still filled to the shilling',
    );
  });

  it('keeps the raise whole when several members hit the ceiling', () => {
    const allocations = allocateOffers(config({ maxShareOfOneCall: 0.3 }), call({ target: 10_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 8_000_000 }),
      offer({ id: 'b', memberId: 'mem_02', amount: 8_000_000 }),
      offer({ id: 'c', memberId: 'mem_03', amount: 8_000_000 }),
      offer({ id: 'd', memberId: 'mem_04', amount: 8_000_000 }),
    ]);

    assert.ok(allocations.every((entry) => entry.allocated <= 3_000_000));
    assert.equal(
      allocations.reduce((total, entry) => total + entry.allocated, 0),
      10_000_000,
    );
  });

  it('raises only what the ceilings allow when they bind below the target', () => {
    // Two members, a 30% cap: between them they can fund 6,000,000 of a
    // 10,000,000 call however much they offer. The call is short, and the
    // allocation must not invent the difference.
    const allocations = allocateOffers(config({ maxShareOfOneCall: 0.3 }), call({ target: 10_000_000 }), [
      offer({ id: 'a', memberId: 'mem_01', amount: 9_000_000 }),
      offer({ id: 'b', memberId: 'mem_02', amount: 9_000_000 }),
    ]);

    assert.equal(
      allocations.reduce((total, entry) => total + entry.allocated, 0),
      6_000_000,
    );
  });
});
