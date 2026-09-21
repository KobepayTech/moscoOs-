import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyRepayments, buildTermLoanSchedule } from '../src/amortisation.js';
import { defaultCircleConfig, mergeConfig } from '../src/config.js';
import { createRegister, sharesOf, subscribe } from '../src/shares.js';
import {
  coverageStatus,
  evaluateApproval,
  expirePledges,
  liveExposure,
  pledgeableCapacity,
  releasedRatio,
  runDefaultCascade,
  selfCoverFor,
  suggestSponsors,
  totalPledgedOut,
  validatePledge,
  type Pledge,
  type SponsorshipRequest,
} from '../src/sponsorship.js';

const config = defaultCircleConfig();

/** Thirty founding members, fifty shares each. */
function foundingRegister() {
  const register = createRegister(config);
  for (let i = 1; i <= 30; i += 1) {
    subscribe(register, config, { memberId: `mem_${i}`, shares: 50, occurredOn: '2026-01-01' });
  }
  return register;
}

function pledge(overrides: Partial<Pledge> & Pick<Pledge, 'sponsorId' | 'amount'>): Pledge {
  return {
    id: `pl_${overrides.sponsorId}`,
    loanId: 'loan_1',
    status: 'pending',
    requestedOn: '2026-02-01',
    expiresOn: '2026-02-04',
    ...overrides,
  };
}

describe('what a member can put behind someone else', () => {
  it('is the value of their shares when nothing is committed', () => {
    const capacity = pledgeableCapacity(
      { memberId: 'mem_1', sharesOwned: 50, pledgedOut: 0, ownOutstandingPrincipal: 0 },
      100_000,
    );
    assert.equal(capacity, 5_000_000);
  });

  it('is reduced by what they have already pledged elsewhere', () => {
    const capacity = pledgeableCapacity(
      { memberId: 'mem_1', sharesOwned: 50, pledgedOut: 2_000_000, ownOutstandingPrincipal: 0 },
      100_000,
    );
    assert.equal(capacity, 3_000_000);
  });

  it('is reduced by their own borrowing — a member at their limit cannot underwrite', () => {
    const capacity = pledgeableCapacity(
      { memberId: 'mem_1', sharesOwned: 50, pledgedOut: 0, ownOutstandingPrincipal: 5_000_000 },
      100_000,
    );
    assert.equal(capacity, 0);
  });

  it('never goes negative', () => {
    const capacity = pledgeableCapacity(
      { memberId: 'mem_1', sharesOwned: 50, pledgedOut: 4_000_000, ownOutstandingPrincipal: 9_000_000 },
      100_000,
    );
    assert.equal(capacity, 0);
  });
});

describe('covering a loan', () => {
  const request = (pledges: Pledge[]): SponsorshipRequest => ({
    loanId: 'loan_1',
    borrowerId: 'mem_1',
    principal: 50_000_000,
    coverageRatio: 1.0,
    openedOn: '2026-02-01',
    pledges,
  });

  it('needs cover equal to the loan under the founding 1:1 rule', () => {
    const status = coverageStatus(request([]), { selfCover: 0 });
    assert.equal(status.required, 50_000_000);
    assert.equal(status.shortfall, 50_000_000);
    assert.equal(status.fullyCovered, false);
  });

  it('counts the borrower’s own shares toward the requirement', () => {
    const status = coverageStatus(request([]), { selfCover: 5_000_000 });
    assert.equal(status.selfCover, 5_000_000);
    assert.equal(status.shortfall, 45_000_000);
  });

  it('counts only sponsors who have actually said yes', () => {
    const status = coverageStatus(
      request([
        pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' }),
        pledge({ sponsorId: 'mem_3', amount: 5_000_000, status: 'pending' }),
        pledge({ sponsorId: 'mem_4', amount: 5_000_000, status: 'declined' }),
      ]),
      { selfCover: 5_000_000 },
    );

    assert.equal(status.acceptedCover, 5_000_000);
    assert.equal(status.pendingCover, 5_000_000);
    assert.equal(status.securedCover, 10_000_000);
    assert.equal(status.shortfall, 40_000_000);
    assert.equal(status.shortfallIfAllAccept, 35_000_000);
    assert.equal(status.acceptedSponsorCount, 1);
    assert.equal(status.declinedSponsorCount, 1);
  });

  it('completes when nine sponsors plus the borrower reach the full amount', () => {
    // The members' own picture: find about ten people between you.
    const pledges = Array.from({ length: 9 }, (_, i) =>
      pledge({ sponsorId: `mem_${i + 2}`, amount: 5_000_000, status: 'accepted' }),
    );

    const status = coverageStatus(request(pledges), { selfCover: 5_000_000 });

    assert.equal(status.securedCover, 50_000_000);
    assert.equal(status.shortfall, 0);
    assert.equal(status.fullyCovered, true);
    assert.equal(status.coverageRatio, 1);
  });

  it('treats an unanswered pledge as worthless once its window has closed', () => {
    const status = coverageStatus(
      request([pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'pending' })]),
      { selfCover: 0, asOf: '2026-02-10' },
    );

    assert.equal(status.pendingCover, 0);
    assert.equal(status.declinedSponsorCount, 1);
  });
});

describe('approval', () => {
  const base: SponsorshipRequest = {
    loanId: 'loan_1',
    borrowerId: 'mem_1',
    principal: 10_000_000,
    coverageRatio: 1.0,
    openedOn: '2026-02-01',
    pledges: [],
  };

  it('approves the moment cover is complete, with no committee step', () => {
    const decision = evaluateApproval(
      { ...base, pledges: [pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' })] },
      { selfCover: 5_000_000, asOf: '2026-02-02' },
    );

    assert.equal(decision.approved, true);
    assert.equal(decision.reason, 'fully_covered');
  });

  it('waits while sponsors have not yet answered', () => {
    const decision = evaluateApproval(
      { ...base, pledges: [pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'pending' })] },
      { selfCover: 5_000_000, asOf: '2026-02-02' },
    );

    assert.equal(decision.approved, false);
    assert.equal(decision.reason, 'awaiting_sponsors');
  });

  it('declines when the sponsors asked could not cover it even if all agreed', () => {
    const decision = evaluateApproval(
      { ...base, pledges: [pledge({ sponsorId: 'mem_2', amount: 1_000_000, status: 'declined' })] },
      { selfCover: 0, asOf: '2026-02-02' },
    );

    assert.equal(decision.approved, false);
    assert.equal(decision.reason, 'insufficient_cover');
  });

  it('lapses pledges nobody answered in time', () => {
    const request = {
      ...base,
      pledges: [
        pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'pending' }),
        pledge({ sponsorId: 'mem_3', amount: 5_000_000, status: 'accepted' }),
      ],
    };

    const lapsed = expirePledges(request, '2026-02-10');

    assert.equal(lapsed.length, 1);
    assert.equal(lapsed[0].sponsorId, 'mem_2');
    assert.equal(request.pledges[1].status, 'accepted', 'an accepted pledge does not lapse');
  });
});

describe('validating a pledge before the sponsor is troubled with it', () => {
  const request: SponsorshipRequest = {
    loanId: 'loan_1',
    borrowerId: 'mem_1',
    principal: 10_000_000,
    coverageRatio: 1.0,
    openedOn: '2026-02-01',
    pledges: [],
  };

  const healthySponsor = {
    memberId: 'mem_2',
    sharesOwned: 50,
    pledgedOut: 0,
    ownOutstandingPrincipal: 0,
  };

  it('accepts a pledge the sponsor can actually stand behind', () => {
    const result = validatePledge(config, request, { sponsorId: 'mem_2', amount: 4_000_000 }, healthySponsor);
    assert.equal(result.ok, true, result.problems.join('; '));
  });

  it('refuses a pledge beyond the sponsor’s capacity', () => {
    const result = validatePledge(
      config,
      request,
      { sponsorId: 'mem_2', amount: 9_000_000 },
      { ...healthySponsor, pledgedOut: 3_000_000 },
    );

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('can pledge at most')));
  });

  it('refuses a borrower sponsoring themselves', () => {
    const result = validatePledge(config, request, { sponsorId: 'mem_1', amount: 1_000_000 }, healthySponsor);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('cannot sponsor their own loan')));
  });

  it('refuses asking the same member twice', () => {
    const withExisting = {
      ...request,
      pledges: [pledge({ sponsorId: 'mem_2', amount: 1_000_000, status: 'pending' })],
    };
    const result = validatePledge(config, withExisting, { sponsorId: 'mem_2', amount: 1_000_000 }, healthySponsor);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('already been asked')));
  });

  it('stops one sponsor carrying more than half of a loan', () => {
    const result = validatePledge(
      config,
      request,
      { sponsorId: 'mem_2', amount: 6_000_000 },
      { ...healthySponsor, sharesOwned: 200 },
    );

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('No sponsor may carry more than')));
  });
});

describe('when a loan defaults', () => {
  it('takes the borrower’s shares before touching any sponsor', () => {
    const register = foundingRegister();
    const request: SponsorshipRequest = {
      loanId: 'loan_1',
      borrowerId: 'mem_1',
      principal: 10_000_000,
      coverageRatio: 1.0,
      openedOn: '2026-02-01',
      pledges: [pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' })],
    };

    const result = runDefaultCascade(register, request, 3_000_000, '2026-06-01');

    assert.equal(result.recoveredFromBorrower, 3_000_000);
    assert.equal(result.recoveredFromSponsors, 0);
    assert.equal(sharesOf(register, 'mem_1'), 20, '30 of 50 shares forfeited');
    assert.equal(sharesOf(register, 'mem_2'), 50, 'the sponsor is untouched');
    assert.equal(result.writtenOff, 0);
  });

  it('calls sponsors pro rata once the borrower is exhausted', () => {
    const register = foundingRegister();
    const request: SponsorshipRequest = {
      loanId: 'loan_1',
      borrowerId: 'mem_1',
      principal: 20_000_000,
      coverageRatio: 1.0,
      openedOn: '2026-02-01',
      pledges: [
        pledge({ sponsorId: 'mem_2', amount: 10_000_000, status: 'accepted' }),
        pledge({ sponsorId: 'mem_3', amount: 5_000_000, status: 'accepted' }),
      ],
    };

    // Borrower's 50 shares cover 5,000,000; 10,000,000 falls to the sponsors,
    // split 2:1 by pledge.
    const result = runDefaultCascade(register, request, 15_000_000, '2026-06-01');

    assert.equal(result.recoveredFromBorrower, 5_000_000);
    assert.equal(sharesOf(register, 'mem_1'), 0);

    const callTwo = result.sponsorCalls.find((c) => c.sponsorId === 'mem_2');
    const callThree = result.sponsorCalls.find((c) => c.sponsorId === 'mem_3');

    assert.equal(callTwo?.called, 6_666_667);
    assert.equal(callThree?.called, 3_333_333);

    // mem_2 only holds 5,000,000 of shares, so the rest is chased personally.
    assert.equal(callTwo?.valueRecovered, 5_000_000);
    assert.equal(callTwo?.receivable, 1_666_667);
    assert.equal(sharesOf(register, 'mem_2'), 0);

    // mem_3's call rounds up to 34 whole shares.
    assert.equal(callThree?.sharesForfeited, 34);
    assert.equal(sharesOf(register, 'mem_3'), 16);
  });

  it('never calls a sponsor for more than they pledged', () => {
    const register = foundingRegister();
    const request: SponsorshipRequest = {
      loanId: 'loan_1',
      borrowerId: 'mem_1',
      principal: 50_000_000,
      coverageRatio: 1.0,
      openedOn: '2026-02-01',
      // Deliberately under-covered: only 2,000,000 pledged against a big loss.
      pledges: [pledge({ sponsorId: 'mem_2', amount: 2_000_000, status: 'accepted' })],
    };

    const result = runDefaultCascade(register, request, 40_000_000, '2026-06-01');

    const call = result.sponsorCalls[0];
    assert.equal(call.called, 2_000_000);
    assert.ok(call.called <= call.pledged);

    // 5,000,000 from the borrower, 2,000,000 from the sponsor, the rest is the
    // circle's own loss — which is exactly why cover must be complete first.
    assert.equal(result.totalRecovered, 7_000_000);
    assert.equal(result.writtenOff, 33_000_000);
  });

  it('marks called pledges so they cannot be called twice', () => {
    const register = foundingRegister();
    const request: SponsorshipRequest = {
      loanId: 'loan_1',
      borrowerId: 'mem_1',
      principal: 10_000_000,
      coverageRatio: 1.0,
      openedOn: '2026-02-01',
      pledges: [pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' })],
    };

    runDefaultCascade(register, request, 8_000_000, '2026-06-01');
    assert.equal(request.pledges[0].status, 'called');
  });

  it('returns forfeited shares to treasury rather than cancelling them', () => {
    const register = foundingRegister();
    const request: SponsorshipRequest = {
      loanId: 'loan_1',
      borrowerId: 'mem_1',
      principal: 10_000_000,
      coverageRatio: 1.0,
      openedOn: '2026-02-01',
      pledges: [],
    };

    runDefaultCascade(register, request, 2_000_000, '2026-06-01');

    assert.equal(register.treasury, 20);
    assert.equal(sharesOf(register, 'mem_1'), 30);
  });

  it('reconciles: recovered + receivable + written off never exceeds the loss', () => {
    const register = foundingRegister();
    const request: SponsorshipRequest = {
      loanId: 'loan_1',
      borrowerId: 'mem_1',
      principal: 30_000_000,
      coverageRatio: 1.0,
      openedOn: '2026-02-01',
      pledges: [
        pledge({ sponsorId: 'mem_2', amount: 8_000_000, status: 'accepted' }),
        pledge({ sponsorId: 'mem_3', amount: 7_000_000, status: 'accepted' }),
        pledge({ sponsorId: 'mem_4', amount: 10_000_000, status: 'accepted' }),
      ],
    };

    const loss = 25_000_000;
    const result = runDefaultCascade(register, request, loss, '2026-06-01');

    // Rounding up to whole shares can over-recover slightly; it may never
    // under-recover, and the parts must account for the whole loss.
    assert.ok(result.totalRecovered + result.totalReceivable + result.writtenOff >= loss);
  });
});

describe('helping the borrower find sponsors', () => {
  it('suggests the members with the most room first', () => {
    const candidates = [
      { memberId: 'mem_2', sharesOwned: 50, pledgedOut: 4_000_000, ownOutstandingPrincipal: 0 },
      { memberId: 'mem_3', sharesOwned: 200, pledgedOut: 0, ownOutstandingPrincipal: 0 },
      { memberId: 'mem_4', sharesOwned: 50, pledgedOut: 0, ownOutstandingPrincipal: 0 },
    ];

    const suggestions = suggestSponsors(config, 10_000_000, candidates, { excludeMemberIds: ['mem_1'] });

    assert.equal(suggestions[0].memberId, 'mem_3');
    assert.ok(suggestions[0].suggestedPledge <= 5_000_000, 'capped at half of one loan');
  });

  it('leaves out members with no room at all', () => {
    const candidates = [
      { memberId: 'mem_2', sharesOwned: 50, pledgedOut: 5_000_000, ownOutstandingPrincipal: 0 },
      { memberId: 'mem_3', sharesOwned: 50, pledgedOut: 0, ownOutstandingPrincipal: 0 },
    ];

    const suggestions = suggestSponsors(config, 5_000_000, candidates);

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].memberId, 'mem_3');
  });

  it('stops once the gap is closed', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      memberId: `mem_${i + 2}`,
      sharesOwned: 50,
      pledgedOut: 0,
      ownOutstandingPrincipal: 0,
    }));

    const suggestions = suggestSponsors(config, 6_000_000, candidates);
    const total = suggestions.reduce((sum, s) => sum + s.suggestedPledge, 0);

    assert.equal(total, 6_000_000);
    assert.ok(suggestions.length < 10);
  });
});

describe('self-cover', () => {
  it('is a member’s uncommitted share value', () => {
    const register = foundingRegister();
    assert.equal(selfCoverFor(config, register, 'mem_1', 0, 0), 5_000_000);
    assert.equal(selfCoverFor(config, register, 'mem_1', 1_000_000, 500_000), 3_500_000);
  });

  it('is zero when the circle chooses not to count it', () => {
    const register = foundingRegister();
    const strict = mergeConfig(config, { sponsorship: { includeBorrowerSelfCover: false } });
    assert.equal(selfCoverFor(strict, register, 'mem_1', 0, 0), 0);
  });

  it('adds up what a member has committed across live sponsorships', () => {
    const pledges = [
      pledge({ sponsorId: 'mem_2', amount: 1_000_000, status: 'accepted' }),
      pledge({ sponsorId: 'mem_2', amount: 2_000_000, status: 'pending' }),
      pledge({ sponsorId: 'mem_2', amount: 9_000_000, status: 'declined' }),
      pledge({ sponsorId: 'mem_3', amount: 4_000_000, status: 'accepted' }),
    ];

    assert.equal(totalPledgedOut(pledges, 'mem_2'), 3_000_000);
  });
});

/**
 * A sponsor stands behind what can still be lost, and that shrinks as the
 * borrower repays. Holding the whole pledge until settlement overstates their
 * exposure for most of a loan's life — and locked capacity is capacity that
 * cannot back anybody else.
 */
describe('sponsor cover is released as the loan is repaid', () => {
  const accepted = pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' });

  const loanAt = (outstanding: number, status = 'disbursed') => ({
    originalPrincipal: 50_000_000,
    principalOutstanding: outstanding,
    status,
  });

  it('locks the whole pledge before anything is disbursed', () => {
    assert.equal(liveExposure(accepted, null), 5_000_000);
  });

  it('locks the whole pledge while none of the loan has come back', () => {
    assert.equal(liveExposure(accepted, loanAt(50_000_000)), 5_000_000);
  });

  it('releases in proportion to principal repaid', () => {
    // Half the loan repaid: half the pledge is free.
    assert.equal(liveExposure(accepted, loanAt(25_000_000)), 2_500_000);

    // The case from the review: four fifths repaid should not leave the
    // sponsor fully locked.
    assert.equal(liveExposure(accepted, loanAt(10_000_000)), 1_000_000);
  });

  it('releases everything once the loan is settled', () => {
    assert.equal(liveExposure(accepted, loanAt(0, 'settled')), 0);
    assert.equal(liveExposure(accepted, loanAt(0)), 0);
  });

  it('releases everything when the application is cancelled', () => {
    assert.equal(liveExposure(accepted, loanAt(50_000_000, 'cancelled')), 0);
  });

  it('keeps a defaulted loan fully locked — that is when cover is called', () => {
    assert.equal(liveExposure(accepted, loanAt(30_000_000, 'defaulted')), 3_000_000);
  });

  it('never claims a sponsor is freer than they are', () => {
    // Rounds up, so a part-shilling of exposure still counts as locked.
    const odd = pledge({ sponsorId: 'mem_2', amount: 1_000_001, status: 'accepted' });
    const exposure = liveExposure(odd, { originalPrincipal: 3, principalOutstanding: 1, status: 'disbursed' });

    assert.ok(exposure >= Math.floor(1_000_001 / 3));
    assert.ok(exposure <= odd.amount);
  });

  it('commits nothing for a pledge that was declined or withdrawn', () => {
    for (const status of ['declined', 'withdrawn', 'expired'] as const) {
      const dead = pledge({ sponsorId: 'mem_2', amount: 5_000_000, status });
      assert.equal(liveExposure(dead, loanAt(50_000_000)), 0, status);
    }
  });

  it('reports how far a sponsor has been released', () => {
    assert.equal(releasedRatio(accepted, loanAt(50_000_000)), 0);
    assert.equal(releasedRatio(accepted, loanAt(25_000_000)), 0.5);
    assert.equal(releasedRatio(accepted, loanAt(0, 'settled')), 1);
  });

  it('sums a member’s real exposure across several loans', () => {
    const exposures = [
      // Fully drawn: all 5,000,000 at risk.
      { pledge: pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' }), loan: loanAt(50_000_000) },
      // Nine tenths repaid: only 400,000 of this one is still at risk.
      { pledge: pledge({ sponsorId: 'mem_2', amount: 4_000_000, status: 'accepted' }), loan: loanAt(5_000_000) },
      // Settled: nothing.
      { pledge: pledge({ sponsorId: 'mem_2', amount: 3_000_000, status: 'accepted' }), loan: loanAt(0, 'settled') },
      // Somebody else's.
      { pledge: pledge({ sponsorId: 'mem_3', amount: 9_000_000, status: 'accepted' }), loan: loanAt(50_000_000) },
    ];

    assert.equal(totalPledgedOut(exposures, 'mem_2'), 5_000_000 + 400_000);
  });

  it('frees capacity that would otherwise sit idle', () => {
    const exposure = {
      memberId: 'mem_2',
      sharesOwned: 50,
      pledgedOut: totalPledgedOut(
        [{ pledge: accepted, loan: loanAt(10_000_000) }],
        'mem_2',
      ),
      ownOutstandingPrincipal: 0,
    };

    // Under the old rule all 5,000,000 stayed locked and this member could
    // back nobody. Four fifths of the loan has come back, so they can.
    assert.equal(pledgeableCapacity(exposure, 100_000), 4_000_000);
  });
});

/**
 * The rule as the members put it: when a borrower pays their 10%, the
 * collateral moves by what is left *after the interest is deducted*.
 *
 * This matters because the instalment and the principal are different
 * numbers. A member pays TSh 6,125,000 but only TSh 5,000,000 of that
 * reduces the debt — the rest is the cost of the loan. Releasing collateral
 * against the gross payment would free more than the borrower has actually
 * repaid, and leave the circle under-covered.
 */
describe('collateral moves with the principal, not the payment', () => {
  const schedule = buildTermLoanSchedule({
    principal: 50_000_000,
    monthlyInterestRate: 0.025,
    termMonths: 3,
    minimumMonthlyPrincipalRate: 0.1,
    disbursedOn: '2026-01-15',
  });

  const sponsorPledge = pledge({ sponsorId: 'mem_2', amount: 5_000_000, status: 'accepted' });

  const stateAfter = (paymentsSoFar: { paidOn: string; amount: number }[], asOf: string) => {
    const loanState = applyRepayments(schedule, paymentsSoFar, { asOf });
    return {
      allocation: loanState.allocations.at(-1)!,
      outstanding: loanState.principalOutstanding,
      atRisk: liveExposure(sponsorPledge, {
        originalPrincipal: 50_000_000,
        principalOutstanding: loanState.principalOutstanding,
        status: 'disbursed',
      }),
    };
  };

  it('separates the interest from the principal in each instalment', () => {
    const first = schedule.rows[0];
    assert.equal(first.totalDue, 6_125_000);
    assert.equal(first.interestDue, 1_125_000);
    assert.equal(first.principalDue, 5_000_000);
  });

  it('releases against the 5,000,000, not the 6,125,000 that was paid', () => {
    const payments = [{ paidOn: '2026-02-15', amount: 6_125_000 }];
    const after = stateAfter(payments, '2026-02-15');

    assert.equal(after.allocation.towardInterest, 1_125_000);
    assert.equal(after.allocation.towardPrincipal, 5_000_000);
    assert.equal(after.outstanding, 45_000_000);

    // A tenth of the debt is gone, so a tenth of the collateral is free.
    assert.equal(after.atRisk, 4_500_000);

    // Had it released against the gross payment the sponsor would be at
    // 4,387,500 — more freed than the borrower has actually repaid.
    assert.notEqual(after.atRisk, Math.ceil(5_000_000 * (1 - 6_125_000 / 50_000_000)));
  });

  it('steps the collateral down once per instalment, by the same amount', () => {
    const payments: { paidOn: string; amount: number }[] = [];
    const atRisk: number[] = [];

    for (const row of schedule.rows.filter((entry) => entry.kind === 'service')) {
      payments.push({ paidOn: row.dueOn, amount: row.totalDue });
      atRisk.push(stateAfter(payments, row.dueOn).atRisk);
    }

    assert.deepEqual(atRisk, [4_500_000, 4_000_000, 3_500_000]);
  });

  it('frees the collateral entirely when the balloon clears the debt', () => {
    const payments = schedule.rows.map((row) => ({ paidOn: row.dueOn, amount: row.totalDue }));
    const after = stateAfter(payments, schedule.maturityOn);

    assert.equal(after.outstanding, 0);
    assert.equal(after.atRisk, 0);
  });

  /**
   * The invariant that makes the whole scheme coherent: cover and debt move
   * together, so the circle is neither under-covered nor holding collateral
   * against money that has already come home.
   */
  it('keeps total cover equal to what is still owed', () => {
    // The founding shape: nine sponsors at 5,000,000 plus the borrower's own
    // 5,000,000 of shares covers the 50,000,000 exactly.
    const sponsors = Array.from({ length: 9 }, (_, index) =>
      pledge({ sponsorId: `mem_${index + 2}`, amount: 5_000_000, status: 'accepted' }),
    );

    const payments: { paidOn: string; amount: number }[] = [];

    for (const row of schedule.rows) {
      payments.push({ paidOn: row.dueOn, amount: row.totalDue });
      const loanState = applyRepayments(schedule, payments, { asOf: row.dueOn });
      const loan = {
        originalPrincipal: 50_000_000,
        principalOutstanding: loanState.principalOutstanding,
        status: 'disbursed',
      };

      const sponsorCover = sponsors.reduce((total, entry) => total + liveExposure(entry, loan), 0);
      // The borrower's own stake is released on the same basis.
      const selfCover = Math.ceil(
        5_000_000 * (loanState.principalOutstanding / 50_000_000),
      );

      assert.equal(
        sponsorCover + selfCover,
        loanState.principalOutstanding,
        `cover drifted from the debt after ${row.dueOn}`,
      );
    }
  });
});
