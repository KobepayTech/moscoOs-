/**
 * The approval gate.
 *
 * A loan approves itself. That is the circle's rule and it stays: sponsorship
 * is the members putting their own capital behind somebody, and asking a
 * committee to re-take a decision the members have already taken with their
 * own money is bureaucracy, not control.
 *
 * But **full cover is not sufficient**, and treating it as sufficient would
 * be the opposite mistake. Cover can be complete while the circle has no cash
 * to pay with; while the borrower is three contributions behind; while a
 * sponsor's shares, real when they pledged, have since been committed to
 * somebody else; or while the loan would put half the book in one person's
 * hands. None of those are decisions — they are facts, and a machine checks
 * facts better than a meeting does.
 *
 * So this module sits between "fully covered" and "approved" and runs every
 * check the members configured. What comes out is not a yes or a no but a
 * **decision with its reasons attached**, which is the part that matters:
 *
 *     Loan approved automatically
 *       Requested            TSh 6,000,000
 *       Borrowing ceiling    TSh 8,400,000     ✓
 *       Sponsor cover        100%              ✓
 *       Cover still live     TSh 6,000,000     ✓
 *       Spendable cash       TSh 74,200,000    ✓
 *       Arrears              none              ✓
 *       Concentration        18% of the book   ✓
 *       Policy version       2026.09
 *
 * A borrower who is refused can read exactly which line refused them and what
 * the number would have to be. A member reviewing the books in a year can see
 * which rules were in force when it was approved. Neither needs to ask
 * anyone.
 *
 * ## Exceptions, not approvals
 *
 * Two gates — the policy ceiling and the concentration limit — are the kind
 * where the rule is a number the members chose and the case in front of you
 * is outside it. Somebody asking for 80,000,000 against a 50,000,000 ceiling
 * is not ineligible; they are exceptional, and exceptional cases are what
 * humans are for. Those route to an authoriser.
 *
 * Everything else is not waveable, and deliberately so. Nobody may authorise
 * an exception to "the cover is not there" or "the money is not in the
 * account", because those are not policies to be relaxed — they are the facts
 * the policy exists to protect.
 */

import { type ApprovalGateCode, type CircleConfig } from './config.js';
import { type CoverageStatus } from './sponsorship.js';
import { type EligibilityResult } from './eligibility.js';
import { type ISODate, assertISODate } from './dates.js';
import { type Money, formatMoney, nonNegative, ratio } from './money.js';

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export type GateOutcome = 'pass' | 'fail' | 'not_applicable';

export interface GateCheck {
  code: ApprovalGateCode;
  /** What the line is called when the decision is read back. */
  label: string;
  outcome: GateOutcome;
  /** What was measured against what it had to be, in the member's words. */
  detail: string;
  /** The measured figure, where there is one, so a panel can show the margin. */
  observed: Money | null;
  /** What it had to reach or stay under. */
  required: Money | null;
  /** Whether a human may authorise past this one. */
  exceptionable: boolean;
}

export type ApprovalOutcome =
  /** Every gate passed. The loan is approved; nobody decides anything. */
  | 'approved'
  /** Cover is not complete. Still with the sponsors. */
  | 'awaiting_sponsors'
  /** Everything passes except the money. Joins the funding queue. */
  | 'awaiting_capital'
  /** Outside a policy number. An authoriser may let it through. */
  | 'needs_authorisation'
  /** A gate no exception can clear. */
  | 'refused';

export interface ApprovalAssessment {
  outcome: ApprovalOutcome;
  /** True only for `approved`. Kept explicit so no caller has to remember. */
  approved: boolean;
  checks: GateCheck[];
  /** The failing gates, in the order they were run. */
  failed: GateCheck[];
  /** One line, for a notification or a heading. */
  headline: string;
  /** Which gates an authoriser could clear, if any. */
  awaitingAuthorisation: ApprovalGateCode[];
  /** The rules that produced this decision. */
  policyVersion: string;
  assessedOn: ISODate;
}

/**
 * An authorisation already granted for this request.
 *
 * Carried in rather than looked up so the engine stays pure, and recorded
 * with a granter and a date because an exception nobody's name is on is not
 * an exception, it is a hole.
 */
export interface ExceptionAuthorisation {
  gate: ApprovalGateCode;
  authorisedBy: string;
  authorisedOn: ISODate;
  reason: string;
}

export interface SponsorCapacity {
  sponsorId: string;
  /** What they promised this loan. */
  pledged: Money;
  /**
   * What they could cover right now, ignoring this pledge. Share value less
   * their own borrowing and everything else they are standing behind.
   */
  available: Money;
}

export interface ApprovalInputs {
  loanId: string;
  borrowerId: string;
  principal: Money;
  asOf: ISODate;

  /** Where the sponsorship stands. */
  coverage: CoverageStatus;
  /**
   * Each accepted sponsor, with what they promised this loan and what they
   * could still cover after everything *else* they are committed to.
   *
   * `available` excludes this pledge, so it answers the question that matters:
   * if we called on them today, is the collateral actually there? A sponsor
   * who pledged 5,000,000 in March and has since backed two other members may
   * have 1,000,000 left, and the pledge itself will not say so.
   */
  sponsorCover: readonly SponsorCapacity[];
  /** Cover the borrower brings from their own shares. */
  selfCover: Money;

  /** The borrower's eligibility, assessed against this principal. */
  eligibility: EligibilityResult;
  /** False when the member is suspended, exited or otherwise not in standing. */
  borrowerActive: boolean;
  /** Whether the platform subscription permits borrowing. */
  subscriptionAllowsBorrowing: boolean;
  /** Loans this borrower currently has in arrears. */
  loansInArrears: number;

  /** What could actually leave the account today, before the reserve. */
  cashOnHand: Money;
  /** What policy says may be lent. */
  policyAvailable: Money;
  /** Already approved and waiting to be paid — this money is spoken for. */
  committedToOtherLoans: Money;

  /** Principal this borrower already owes. */
  borrowerOutstanding: Money;
  /** The whole loan book, for the concentration test. */
  bookOutstanding: Money;

  /** Exceptions an authoriser has already granted. */
  authorisations?: readonly ExceptionAuthorisation[];
}

const LABELS: Record<ApprovalGateCode, string> = {
  cover: 'Sponsor cover',
  cover_live: 'Cover still live',
  borrower_standing: 'Borrower standing',
  subscription: 'Platform subscription',
  arrears: 'Arrears',
  within_ceiling: 'Borrowing ceiling',
  concentration: 'Concentration limit',
  spendable_cash: 'Spendable cash',
};

/**
 * Run every gate and say what follows.
 *
 * Pure, like the rest of the engine: every fact is passed in, so the whole
 * decision can be reproduced from the inputs recorded with it.
 */
export function assessApproval(config: CircleConfig, inputs: ApprovalInputs): ApprovalAssessment {
  assertISODate(inputs.asOf, 'asOf');
  if (inputs.principal <= 0) throw new ApprovalError('A loan must be for a positive amount');

  const currency = config.currency;
  const amount = (value: Money) => formatMoney(value, currency);
  const authorised = new Set((inputs.authorisations ?? []).map((grant) => grant.gate));
  const exceptionable = new Set(config.approval.exceptionableGates);

  const checks: GateCheck[] = [];

  const gate = (
    code: ApprovalGateCode,
    passed: boolean,
    detail: string,
    figures: { observed?: Money | null; required?: Money | null } = {},
  ) => {
    const canExcept = exceptionable.has(code);
    checks.push({
      code,
      label: LABELS[code],
      // An authorised exception passes the gate and says so, rather than
      // vanishing from the record: the reader should see that it was cleared
      // by a person, not that it was never a problem.
      outcome: passed || (canExcept && authorised.has(code)) ? 'pass' : 'fail',
      detail: !passed && canExcept && authorised.has(code) ? `${detail} — authorised` : detail,
      observed: figures.observed ?? null,
      required: figures.required ?? null,
      exceptionable: canExcept,
    });
  };

  // --- Cover ---------------------------------------------------------------
  // The members' own decision, and the one gate that is never waveable: no
  // officer may sign away somebody else's collateral.

  gate(
    'cover',
    inputs.coverage.fullyCovered,
    inputs.coverage.fullyCovered
      ? `${amount(inputs.coverage.securedCover)} of cover against ${amount(inputs.coverage.required)} required`
      : `${amount(inputs.coverage.securedCover)} of the ${amount(inputs.coverage.required)} required — ` +
        `${amount(inputs.coverage.shortfall)} short`,
    { observed: inputs.coverage.securedCover, required: inputs.coverage.required },
  );

  // --- Cover still live ----------------------------------------------------
  // A sponsor's shares were free when they accepted. They may since have
  // backed somebody else or borrowed themselves. Cover that has been spent
  // twice is not cover.

  const backed = inputs.sponsorCover.map((sponsor) => ({
    ...sponsor,
    // A sponsor can only really cover the lesser of what they promised and
    // what is still free. Never more than they promised — the pledge is the
    // commitment — and never more than they have.
    live: Math.min(sponsor.pledged, nonNegative(sponsor.available)),
  }));

  const liveCover = inputs.selfCover + backed.reduce((total, sponsor) => total + sponsor.live, 0);
  const overcommitted = backed.filter((sponsor) => sponsor.live < sponsor.pledged);
  const stillLive = liveCover >= inputs.coverage.required;

  gate(
    'cover_live',
    stillLive,
    stillLive
      ? `${amount(liveCover)} of pledged cover is genuinely uncommitted`
      : `Only ${amount(liveCover)} of the pledged cover is still free against ${amount(inputs.coverage.required)} ` +
        `required — ${overcommitted.length} sponsor(s) have committed shares elsewhere since they promised.`,
    { observed: liveCover, required: inputs.coverage.required },
  );

  // --- The borrower --------------------------------------------------------

  const blocking = inputs.eligibility.problems.filter(
    (problem) => problem.code !== 'sponsors_required' && problem.code !== 'over_ceiling',
  );

  gate(
    'borrower_standing',
    inputs.borrowerActive && blocking.length === 0,
    !inputs.borrowerActive
      ? 'This membership is not in good standing'
      : blocking.length === 0
        ? 'In good standing'
        : blocking.map((problem) => problem.message).join('; '),
  );

  gate(
    'subscription',
    inputs.subscriptionAllowsBorrowing,
    inputs.subscriptionAllowsBorrowing
      ? 'Active'
      : `The platform subscription has lapsed, which withholds borrowing. Reading, repaying and voting ` +
        'are unaffected.',
  );

  gate(
    'arrears',
    inputs.loansInArrears === 0,
    inputs.loansInArrears === 0 ? 'None' : `${inputs.loansInArrears} loan(s) in arrears`,
  );

  // --- The policy numbers --------------------------------------------------
  // These two are the exceptional cases: the rule is a figure the members
  // chose, and this request sits outside it.

  const ceiling = inputs.eligibility.maxPrincipal;
  gate(
    'within_ceiling',
    inputs.principal <= ceiling,
    inputs.principal <= ceiling
      ? `${amount(inputs.principal)} against a ceiling of ${amount(ceiling)}`
      : `${amount(inputs.principal)} is above the ${amount(ceiling)} ceiling` +
        (inputs.eligibility.bindingConstraint ? ` (${inputs.eligibility.bindingConstraint})` : ''),
    { observed: inputs.principal, required: ceiling },
  );

  // Measured on the book as it would be *after* this loan, which is the book
  // the circle would actually be carrying.
  const wouldOwe = inputs.borrowerOutstanding + inputs.principal;
  const bookAfter = inputs.bookOutstanding + inputs.principal;
  const share = ratio(wouldOwe, bookAfter);
  const limit = config.termLoan.maxPrincipalAsRatioOfCapital;
  const withinConcentration = bookAfter === 0 || share <= limit;

  gate(
    'concentration',
    withinConcentration,
    withinConcentration
      ? `This borrower would hold ${(share * 100).toFixed(1)}% of the book, within the ` +
        `${(limit * 100).toFixed(0)}% limit`
      : `This borrower would hold ${(share * 100).toFixed(1)}% of the book, above the ` +
        `${(limit * 100).toFixed(0)}% limit. One default would take a large part of the circle with it.`,
    { observed: wouldOwe, required: null },
  );

  // --- The money -----------------------------------------------------------
  // Never exceptionable. An authorisation cannot create cash, and a loan
  // approved without it is a promise rather than a decision.

  const spendable = nonNegative(
    Math.min(inputs.policyAvailable, inputs.cashOnHand - config.approval.minimumCashReserve) -
      inputs.committedToOtherLoans,
  );
  const cashIsThere = !config.approval.requireSpendableCash || spendable >= inputs.principal;

  gate(
    'spendable_cash',
    cashIsThere,
    cashIsThere
      ? `${amount(spendable)} can go out today`
      : `${amount(spendable)} can go out today against ${amount(inputs.principal)} needed. ` +
        `Cash on hand is ${amount(inputs.cashOnHand)}, less a ${amount(config.approval.minimumCashReserve)} ` +
        `reserve and ${amount(inputs.committedToOtherLoans)} already promised to approved loans.`,
    { observed: spendable, required: inputs.principal },
  );

  // --- What follows --------------------------------------------------------

  const failed = checks.filter((check) => check.outcome === 'fail');
  const outcome = decide(failed);
  const awaitingAuthorisation = failed
    .filter((check) => check.exceptionable)
    .map((check) => check.code);

  return {
    outcome,
    approved: outcome === 'approved',
    checks,
    failed,
    headline: headlineFor(outcome, failed, amount, inputs.principal),
    awaitingAuthorisation,
    policyVersion: config.approval.policyVersion,
    assessedOn: inputs.asOf,
  };
}

/**
 * Turn the failing gates into one outcome.
 *
 * Order matters and is not arbitrary. Cover first, because until the members
 * have decided nothing else is worth saying. Then anything unwaveable, which
 * is a refusal. Then the exceptional cases, which are a person's to answer.
 * Cash last, because "we would, when we can" is a better answer than a
 * refusal and puts the request in the queue rather than in the bin.
 */
function decide(failed: GateCheck[]): ApprovalOutcome {
  if (failed.length === 0) return 'approved';

  const has = (code: ApprovalGateCode) => failed.some((check) => check.code === code);

  if (has('cover')) return 'awaiting_sponsors';

  const hard = failed.filter(
    (check) => !check.exceptionable && check.code !== 'spendable_cash' && check.code !== 'cover',
  );
  if (hard.length > 0) return 'refused';

  if (failed.some((check) => check.exceptionable)) return 'needs_authorisation';

  return 'awaiting_capital';
}

function headlineFor(
  outcome: ApprovalOutcome,
  failed: GateCheck[],
  amount: (value: Money) => string,
  principal: Money,
): string {
  switch (outcome) {
    case 'approved':
      return `${amount(principal)} approved — every check passed`;
    case 'awaiting_sponsors':
      return 'Still gathering sponsor cover';
    case 'awaiting_capital':
      return `Approved on the rules, waiting for ${amount(principal)} to be free`;
    case 'needs_authorisation':
      return `Outside policy — ${failed
        .filter((check) => check.exceptionable)
        .map((check) => check.label.toLowerCase())
        .join(' and ')} needs authorisation`;
    default:
      return failed[0]?.detail ?? 'Refused';
  }
}

/** Whether a role may authorise an exception. */
export function mayAuthorise(config: CircleConfig, role: string): boolean {
  return (config.approval.exceptionAuthorisers as readonly string[]).includes(role);
}

/** Whether a gate is one an exception can be granted for at all. */
export function isExceptionable(config: CircleConfig, gate: ApprovalGateCode): boolean {
  return (config.approval.exceptionableGates as readonly string[]).includes(gate);
}

/**
 * Whether an authorisation is still good.
 *
 * An exception is granted against a picture of the circle on a given day.
 * Left open indefinitely it becomes a standing permission, which is the thing
 * the committee was removed to avoid.
 */
export function authorisationIsCurrent(
  config: CircleConfig,
  grant: ExceptionAuthorisation,
  asOf: ISODate,
): boolean {
  const elapsed =
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${grant.authorisedOn}T00:00:00Z`)) / 86_400_000;
  return elapsed >= 0 && elapsed <= config.approval.authorisationValidDays;
}

/**
 * The decision, rendered for a person.
 *
 * Every automated decision has to be able to explain itself, or "the system
 * said no" becomes the circle's answer to its own members — which is worse
 * than a committee, because at least a committee can be asked why.
 */
export function explainDecision(assessment: ApprovalAssessment): string[] {
  const mark = (check: GateCheck) => (check.outcome === 'pass' ? '✓' : '✗');
  return [
    assessment.headline,
    ...assessment.checks.map((check) => `${mark(check)} ${check.label}: ${check.detail}`),
    `Policy version ${assessment.policyVersion}, assessed ${assessment.assessedOn}`,
  ];
}

/**
 * Sponsors whose promise no longer stands up.
 *
 * Named so the borrower can be told *who* to go back to, rather than that
 * their cover is mysteriously short.
 */
export function overcommittedSponsors(
  cover: readonly SponsorCapacity[],
): { sponsorId: string; promised: Money; live: Money; short: Money }[] {
  return cover
    .map((sponsor) => {
      const live = Math.min(sponsor.pledged, nonNegative(sponsor.available));
      return { sponsorId: sponsor.sponsorId, promised: sponsor.pledged, live, short: sponsor.pledged - live };
    })
    .filter((sponsor) => sponsor.short > 0);
}
