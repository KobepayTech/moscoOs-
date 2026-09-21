import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type ApprovalInputs,
  type CircleConfig,
  type CoverageStatus,
  type EligibilityResult,
  ApprovalError,
  assessApproval,
  authorisationIsCurrent,
  buyoutQuote,
  defaultCircleConfig,
  explainDecision,
  isExceptionable,
  mayAuthorise,
  overcommittedSponsors,
} from '../src/index.js';

const TODAY = '2026-09-21';

function config(overrides: Partial<CircleConfig['approval']> = {}): CircleConfig {
  const base = defaultCircleConfig();
  return { ...base, approval: { ...base.approval, ...overrides } };
}

function coverage(principal: number, secured: number): CoverageStatus {
  const required = principal;
  return {
    loanId: 'loan_1',
    principal,
    required,
    selfCover: 0,
    acceptedCover: secured,
    pendingCover: 0,
    securedCover: secured,
    shortfall: Math.max(0, required - secured),
    shortfallIfAllAccept: Math.max(0, required - secured),
    coverageRatio: secured / required,
    fullyCovered: secured >= required,
    acceptedSponsorCount: 2,
    pendingSponsorCount: 0,
    declinedSponsorCount: 0,
  };
}

function eligible(maxPrincipal: number): EligibilityResult {
  return {
    eligible: true,
    product: 'term',
    problems: [],
    maxPrincipal,
    bindingConstraint: 'single-loan policy',
  };
}

/** A loan that passes every gate: 6,000,000 against an 8,400,000 ceiling. */
function healthy(overrides: Partial<ApprovalInputs> = {}): ApprovalInputs {
  return {
    loanId: 'loan_1',
    borrowerId: 'mem_01',
    principal: 6_000_000,
    asOf: TODAY,
    coverage: coverage(6_000_000, 6_000_000),
    sponsorCover: [
      { sponsorId: 'mem_02', pledged: 4_000_000, available: 4_000_000 },
      { sponsorId: 'mem_03', pledged: 2_000_000, available: 5_000_000 },
    ],
    selfCover: 0,
    eligibility: eligible(8_400_000),
    borrowerActive: true,
    subscriptionAllowsBorrowing: true,
    loansInArrears: 0,
    cashOnHand: 100_000_000,
    policyAvailable: 90_000_000,
    committedToOtherLoans: 0,
    borrowerOutstanding: 0,
    bookOutstanding: 60_000_000,
    ...overrides,
  };
}

describe('the gate approves a sound loan without anyone deciding', () => {
  it('passes every check and approves', () => {
    const assessment = assessApproval(config(), healthy());

    assert.equal(assessment.outcome, 'approved');
    assert.equal(assessment.approved, true);
    assert.deepEqual(assessment.failed, []);
    assert.equal(assessment.checks.length, 8, 'every gate is reported, not just the failures');
    assert.ok(assessment.checks.every((check) => check.outcome === 'pass'));
  });

  it('stamps the rules that approved it', () => {
    const assessment = assessApproval(config({ policyVersion: '2026.09' }), healthy());

    assert.equal(assessment.policyVersion, '2026.09');
    assert.equal(assessment.assessedOn, TODAY);
  });

  it('can explain itself line by line', () => {
    const lines = explainDecision(assessApproval(config(), healthy()));

    assert.match(lines[0], /approved/);
    assert.ok(lines.some((line) => line.startsWith('✓ Sponsor cover')));
    assert.ok(lines.some((line) => line.startsWith('✓ Spendable cash')));
    assert.ok(lines.at(-1)!.includes('Policy version 2026.09'));
  });

  it('refuses a loan for nothing', () => {
    assert.throws(() => assessApproval(config(), healthy({ principal: 0 })), ApprovalError);
  });
});

describe('cover alone is not enough', () => {
  it('holds a loan whose cover is incomplete', () => {
    const assessment = assessApproval(
      config(),
      healthy({ coverage: coverage(6_000_000, 4_000_000) }),
    );

    assert.equal(assessment.outcome, 'awaiting_sponsors');
    assert.equal(assessment.approved, false);
  });

  it('catches cover that was real when promised and has since been spent', () => {
    // mem_02 pledged 4,000,000 but has only 1,000,000 free now: they have
    // backed somebody else in the meantime.
    const assessment = assessApproval(
      config(),
      healthy({
        sponsorCover: [
          { sponsorId: 'mem_02', pledged: 4_000_000, available: 1_000_000 },
          { sponsorId: 'mem_03', pledged: 2_000_000, available: 5_000_000 },
        ],
      }),
    );

    assert.equal(assessment.outcome, 'refused', 'fully covered on paper, not in fact');
    const check = assessment.failed.find((entry) => entry.code === 'cover_live')!;
    assert.equal(check.observed, 3_000_000);
    assert.equal(check.required, 6_000_000);
    assert.match(check.detail, /committed shares elsewhere/);
  });

  it('names the sponsors whose promise no longer stands up', () => {
    const short = overcommittedSponsors([
      { sponsorId: 'mem_02', pledged: 4_000_000, available: 1_000_000 },
      { sponsorId: 'mem_03', pledged: 2_000_000, available: 5_000_000 },
    ]);

    assert.equal(short.length, 1);
    assert.equal(short[0].sponsorId, 'mem_02');
    assert.equal(short[0].short, 3_000_000);
  });

  it('never lets a sponsor cover more than they promised', () => {
    // mem_03 has 5,000,000 free but only pledged 2,000,000. The surplus is
    // not this loan's to count.
    const assessment = assessApproval(
      config(),
      healthy({
        coverage: coverage(6_000_000, 6_000_000),
        sponsorCover: [
          { sponsorId: 'mem_02', pledged: 4_000_000, available: 500_000 },
          { sponsorId: 'mem_03', pledged: 2_000_000, available: 50_000_000 },
        ],
      }),
    );

    const check = assessment.checks.find((entry) => entry.code === 'cover_live')!;
    assert.equal(check.observed, 2_500_000, '500,000 + 2,000,000, not 500,000 + 50,000,000');
  });
});

describe('the borrower still has to be in standing', () => {
  it('refuses a suspended member however well covered', () => {
    const assessment = assessApproval(config(), healthy({ borrowerActive: false }));

    assert.equal(assessment.outcome, 'refused');
    assert.ok(assessment.failed.some((check) => check.code === 'borrower_standing'));
  });

  it('refuses a borrower already in arrears', () => {
    const assessment = assessApproval(config(), healthy({ loansInArrears: 1 }));

    assert.equal(assessment.outcome, 'refused');
    assert.match(assessment.failed[0].detail, /1 loan\(s\) in arrears/);
  });

  it('withholds borrowing on a lapsed subscription, and says what still works', () => {
    const assessment = assessApproval(config(), healthy({ subscriptionAllowsBorrowing: false }));

    assert.equal(assessment.outcome, 'refused');
    const check = assessment.failed.find((entry) => entry.code === 'subscription')!;
    assert.match(check.detail, /Reading, repaying and voting are unaffected/);
  });

  it('carries the eligibility engine’s own reasons through', () => {
    const assessment = assessApproval(
      config(),
      healthy({
        eligibility: {
          ...eligible(8_400_000),
          eligible: false,
          problems: [
            { code: 'annual_fee_unpaid', message: 'This year’s subscription is outstanding', actionable: true },
          ],
        },
      }),
    );

    assert.equal(assessment.outcome, 'refused');
    assert.match(assessment.failed[0].detail, /subscription is outstanding/);
  });

  it('does not treat "you need sponsors" as a refusal', () => {
    // The eligibility engine emits this as guidance, not a blocker — it is
    // what the sponsorship round is for.
    const assessment = assessApproval(
      config(),
      healthy({
        eligibility: {
          ...eligible(8_400_000),
          problems: [{ code: 'sponsors_required', message: 'You need 6,000,000 of cover', actionable: true }],
        },
      }),
    );

    assert.equal(assessment.outcome, 'approved');
  });
});

describe('the money has to be there', () => {
  it('queues rather than refuses when the cash is short', () => {
    const assessment = assessApproval(
      config(),
      healthy({ cashOnHand: 24_000_000, policyAvailable: 90_000_000 }),
    );

    // 24,000,000 less the 20,000,000 reserve leaves 4,000,000.
    assert.equal(assessment.outcome, 'awaiting_capital');
    const check = assessment.failed[0];
    assert.equal(check.code, 'spendable_cash');
    assert.equal(check.observed, 4_000_000);
    assert.match(assessment.headline, /waiting for/);
  });

  it('keeps the reserve back', () => {
    const tight = assessApproval(
      config({ minimumCashReserve: 20_000_000 }),
      healthy({ principal: 6_000_000, cashOnHand: 25_000_000, policyAvailable: 90_000_000 }),
    );
    const relaxed = assessApproval(
      config({ minimumCashReserve: 0 }),
      healthy({ principal: 6_000_000, cashOnHand: 25_000_000, policyAvailable: 90_000_000 }),
    );

    assert.equal(tight.outcome, 'awaiting_capital', '5,000,000 spendable against 6,000,000 needed');
    assert.equal(relaxed.outcome, 'approved');
  });

  it('will not spend money already promised to another approved loan', () => {
    const assessment = assessApproval(
      config(),
      healthy({ cashOnHand: 100_000_000, policyAvailable: 90_000_000, committedToOtherLoans: 78_000_000 }),
    );

    assert.equal(assessment.outcome, 'awaiting_capital');
    assert.equal(assessment.failed[0].observed, 2_000_000);
  });

  it('cannot be authorised past — nobody can authorise cash into existence', () => {
    const assessment = assessApproval(
      config({ exceptionableGates: ['within_ceiling', 'concentration'] }),
      healthy({ cashOnHand: 21_000_000 }),
    );

    assert.equal(assessment.failed[0].exceptionable, false);
    assert.deepEqual(assessment.awaitingAuthorisation, []);
    assert.equal(isExceptionable(config(), 'spendable_cash'), false);
  });

  it('can be switched off for a circle that disburses from elsewhere', () => {
    const assessment = assessApproval(
      config({ requireSpendableCash: false }),
      healthy({ cashOnHand: 0 }),
    );

    assert.equal(assessment.outcome, 'approved');
  });
});

describe('exceptions, not approvals', () => {
  it('routes the 80m-against-a-50m-ceiling case to an authoriser', () => {
    const assessment = assessApproval(
      config(),
      healthy({
        principal: 80_000_000,
        coverage: coverage(80_000_000, 80_000_000),
        sponsorCover: [{ sponsorId: 'mem_02', pledged: 80_000_000, available: 80_000_000 }],
        eligibility: eligible(50_000_000),
        cashOnHand: 200_000_000,
        policyAvailable: 200_000_000,
        bookOutstanding: 400_000_000,
      }),
    );

    assert.equal(assessment.outcome, 'needs_authorisation');
    assert.deepEqual(assessment.awaitingAuthorisation, ['within_ceiling']);
    assert.match(assessment.headline, /Outside policy/);

    const check = assessment.failed.find((entry) => entry.code === 'within_ceiling')!;
    assert.equal(check.observed, 80_000_000);
    assert.equal(check.required, 50_000_000);
  });

  it('approves once the exception is authorised, and still shows it was', () => {
    const inputs = healthy({
      principal: 80_000_000,
      coverage: coverage(80_000_000, 80_000_000),
      sponsorCover: [{ sponsorId: 'mem_02', pledged: 80_000_000, available: 80_000_000 }],
      eligibility: eligible(50_000_000),
      cashOnHand: 200_000_000,
      policyAvailable: 200_000_000,
      bookOutstanding: 400_000_000,
      authorisations: [
        {
          gate: 'within_ceiling' as const,
          authorisedBy: 'mem_chair',
          authorisedOn: TODAY,
          reason: 'Confirmed stock order against a signed contract',
        },
      ],
    });

    const assessment = assessApproval(config(), inputs);

    assert.equal(assessment.outcome, 'approved');
    const check = assessment.checks.find((entry) => entry.code === 'within_ceiling')!;
    assert.equal(check.outcome, 'pass');
    assert.match(check.detail, /authorised$/, 'the record says a person cleared it');
  });

  it('flags a loan that would bunch the book in one pair of hands', () => {
    const assessment = assessApproval(
      config(),
      healthy({
        principal: 40_000_000,
        coverage: coverage(40_000_000, 40_000_000),
        sponsorCover: [{ sponsorId: 'mem_02', pledged: 40_000_000, available: 40_000_000 }],
        eligibility: eligible(50_000_000),
        borrowerOutstanding: 20_000_000,
        bookOutstanding: 60_000_000,
        cashOnHand: 200_000_000,
        policyAvailable: 200_000_000,
      }),
    );

    // 60,000,000 of a 100,000,000 book is 60%, well past the policy limit.
    assert.equal(assessment.outcome, 'needs_authorisation');
    assert.deepEqual(assessment.awaitingAuthorisation, ['concentration']);
    assert.match(assessment.failed[0].detail, /60\.0% of the book/);
  });

  it('measures concentration on the book as it would be, not as it is', () => {
    const assessment = assessApproval(
      config(),
      healthy({ principal: 6_000_000, borrowerOutstanding: 0, bookOutstanding: 0 }),
    );

    // The first loan in an empty book is 100% of it. Refusing that would
    // make a circle unable to start lending.
    assert.equal(assessment.outcome, 'needs_authorisation');
    assert.match(assessment.failed[0].detail, /100\.0% of the book/);
  });

  it('will not let an authorisation clear a gate the members did not open', () => {
    const assessment = assessApproval(
      config({ exceptionableGates: ['within_ceiling'] }),
      healthy({
        loansInArrears: 2,
        authorisations: [
          { gate: 'arrears' as const, authorisedBy: 'mem_chair', authorisedOn: TODAY, reason: 'Trust them' },
        ],
      }),
    );

    assert.equal(assessment.outcome, 'refused', 'arrears is not exceptionable, so the grant does nothing');
  });

  it('knows who may authorise', () => {
    assert.equal(mayAuthorise(config(), 'chair'), true);
    assert.equal(mayAuthorise(config(), 'cashier'), false);
    assert.equal(mayAuthorise(config(), 'member'), false);
  });

  it('lets an authorisation go stale rather than become a standing permission', () => {
    const grant = {
      gate: 'within_ceiling' as const,
      authorisedBy: 'mem_chair',
      authorisedOn: '2026-09-01',
      reason: 'One-off',
    };

    assert.equal(authorisationIsCurrent(config({ authorisationValidDays: 14 }), grant, '2026-09-10'), true);
    assert.equal(authorisationIsCurrent(config({ authorisationValidDays: 14 }), grant, '2026-09-20'), false);
    assert.equal(
      authorisationIsCurrent(config(), grant, '2026-08-30'),
      false,
      'and cannot be back-dated into the future',
    );
  });
});

describe('a sponsor cannot walk away from a guarantee', () => {
  const pledge = {
    id: 'pl_1',
    loanId: 'loan_1',
    sponsorId: 'mem_02',
    amount: 5_000_000,
    status: 'accepted' as const,
    requestedOn: '2026-07-21',
    expiresOn: '2026-07-24',
    respondedOn: '2026-07-22',
  };

  it('prices the release at what they are still carrying', () => {
    // 50,000,000 lent, 10,000,000 repaid: 80% still outstanding.
    const quote = buyoutQuote(
      pledge,
      { originalPrincipal: 50_000_000, principalOutstanding: 40_000_000, status: 'disbursed' },
      { loanDisbursed: true },
    );

    assert.equal(quote.available, true);
    assert.equal(quote.liveExposure, 4_000_000, '80% of the 5,000,000 pledged');
    assert.equal(quote.alreadyReleased, 1_000_000, 'released free as the borrower repaid');
  });

  it('never charges twice for cover repayments already released', () => {
    const early = buyoutQuote(
      pledge,
      { originalPrincipal: 50_000_000, principalOutstanding: 50_000_000, status: 'disbursed' },
      { loanDisbursed: true },
    );
    const late = buyoutQuote(
      pledge,
      { originalPrincipal: 50_000_000, principalOutstanding: 5_000_000, status: 'disbursed' },
      { loanDisbursed: true },
    );

    assert.equal(early.liveExposure, 5_000_000);
    assert.equal(late.liveExposure, 500_000, 'the price falls as the risk does');
  });

  it('refuses a free exit once the money is out', () => {
    const quote = buyoutQuote(
      pledge,
      { originalPrincipal: 50_000_000, principalOutstanding: 40_000_000, status: 'disbursed' },
      { loanDisbursed: true },
    );

    // The point of the rule: there is a price, and it is not zero.
    assert.ok(quote.liveExposure > 0);
    assert.match(quote.reason, /comes back to you as the borrower repays/);
  });

  it('lets a sponsor withdraw for nothing before the money goes out', () => {
    const quote = buyoutQuote(pledge, null, { loanDisbursed: false });

    assert.equal(quote.available, false);
    assert.match(quote.reason, /no money is at risk yet/);
  });

  it('says there is nothing to buy out once the loan is repaid', () => {
    const quote = buyoutQuote(
      pledge,
      { originalPrincipal: 50_000_000, principalOutstanding: 0, status: 'settled' },
      { loanDisbursed: true },
    );

    assert.equal(quote.available, false);
    assert.equal(quote.liveExposure, 0);
    assert.match(quote.reason, /already free/);
  });

  it('has nothing to offer a sponsor who never accepted', () => {
    const quote = buyoutQuote({ ...pledge, status: 'pending' }, null, { loanDisbursed: false });

    assert.equal(quote.available, false);
    assert.match(quote.reason, /decline it instead/);
  });
});
