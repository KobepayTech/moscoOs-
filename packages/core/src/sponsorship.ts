/**
 * Sponsorship: how a loan gets underwritten by the people who know the borrower.
 *
 * The circle does not assess credit with a scorecard. It asks the borrower to
 * find members who will stand behind them, and those members put their own
 * shares on the line to do it. A loan is approved when the pledges behind it
 * cover the amount being lent — at which point the committee has no discretion
 * left to exercise, and the system disburses.
 *
 * That design has a property worth stating plainly: the circle's credit risk
 * is converted into *member* risk, priced by the members best placed to judge
 * it. A member nobody will sponsor does not get a loan, and no committee has
 * to be the one to say so.
 *
 * ## Capacity
 *
 * A member can only pledge what they could actually lose. Their capacity is
 * the value of their shares, less what they have already pledged to other live
 * sponsorships, less their own outstanding borrowing. Double-counting here is
 * how guarantee schemes fail, so the arithmetic is deliberately conservative:
 * every shilling of cover is backed by a shilling of share value that is not
 * already spoken for.
 *
 * ## Default
 *
 * When a loan goes bad the loss is absorbed in a fixed order:
 *
 *   1. the borrower's own shares, in full, before anyone else is touched;
 *   2. the sponsors' shares, pro rata to what each of them pledged;
 *   3. anything still uncovered becomes a personal receivable against the
 *      sponsors, pursued outside the share register;
 *   4. only what cannot be recovered at all is written off against the circle.
 *
 * Sponsors are never called for more than they pledged, however large the loss.
 */

import { type ISODate, assertISODate, isAfter } from './dates.js';
import { type CircleConfig } from './config.js';
import {
  type ShareRegister,
  dilute,
  type DilutionResult,
  holdingValue,
  sharesOf,
} from './shares.js';
import { type Money, allocate, applyRate, money, nonNegative, ratio, sum } from './money.js';

export class SponsorshipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SponsorshipError';
  }
}

export type PledgeStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn' | 'called';

export interface Pledge {
  id: string;
  loanId: string;
  sponsorId: string;
  /** Amount of the loan this sponsor stands behind. */
  amount: Money;
  status: PledgeStatus;
  requestedOn: ISODate;
  respondedOn?: ISODate | null;
  /** After this date an unanswered pledge lapses. */
  expiresOn: ISODate;
  note?: string;
}

export interface MemberExposure {
  memberId: string;
  /** Shares held. */
  sharesOwned: number;
  /** Already committed to other live sponsorships. */
  pledgedOut: Money;
  /** The member's own outstanding loan principal. */
  ownOutstandingPrincipal: Money;
}

/**
 * What a member can still put behind someone else's loan.
 *
 * Their share value, less what is already committed elsewhere, less their own
 * debt. A member who has borrowed to their limit cannot also underwrite.
 */
export function pledgeableCapacity(exposure: MemberExposure, parValue: Money): Money {
  const shareValue = money(exposure.sharesOwned * parValue);
  return nonNegative(shareValue - exposure.pledgedOut - exposure.ownOutstandingPrincipal);
}

export function exposureFromRegister(
  register: ShareRegister,
  memberId: string,
  pledgedOut: Money,
  ownOutstandingPrincipal: Money,
): MemberExposure {
  return {
    memberId,
    sharesOwned: sharesOf(register, memberId),
    pledgedOut,
    ownOutstandingPrincipal,
  };
}

export interface SponsorshipRequest {
  loanId: string;
  borrowerId: string;
  principal: Money;
  /** Cover required as a multiple of principal. Term loans 1.0x; short-term stricter. */
  coverageRatio: number;
  openedOn: ISODate;
  pledges: Pledge[];
}

export interface CoverageStatus {
  loanId: string;
  principal: Money;
  /** Cover the loan needs before it can be disbursed. */
  required: Money;
  /** The borrower's own uncommitted share value, if policy counts it. */
  selfCover: Money;
  /** Cover from sponsors who have said yes. */
  acceptedCover: Money;
  /** Cover from sponsors who have not yet answered. */
  pendingCover: Money;
  /** Accepted cover plus self-cover. */
  securedCover: Money;
  /** Still missing, counting only what is secured. */
  shortfall: Money;
  /** Still missing if every pending sponsor says yes. */
  shortfallIfAllAccept: Money;
  coverageRatio: number;
  fullyCovered: boolean;
  acceptedSponsorCount: number;
  pendingSponsorCount: number;
  declinedSponsorCount: number;
}

/** Where a loan's underwriting stands right now. */
export function coverageStatus(
  request: SponsorshipRequest,
  options: { selfCover?: Money; asOf?: ISODate } = {},
): CoverageStatus {
  const selfCover = options.selfCover ?? 0;
  const asOf = options.asOf;

  const live = request.pledges.filter((pledge) => pledge.status !== 'withdrawn');

  // A pledge nobody answered before its window closed provides no cover, even
  // if the record still says "pending".
  const isExpired = (pledge: Pledge) =>
    pledge.status === 'expired' || (pledge.status === 'pending' && asOf !== undefined && isAfter(asOf, pledge.expiresOn));

  const accepted = live.filter((pledge) => pledge.status === 'accepted' || pledge.status === 'called');
  const pending = live.filter((pledge) => pledge.status === 'pending' && !isExpired(pledge));
  const declined = live.filter((pledge) => pledge.status === 'declined' || isExpired(pledge));

  const required = applyRate(request.principal, request.coverageRatio);
  const acceptedCover = sum(accepted.map((pledge) => pledge.amount));
  const pendingCover = sum(pending.map((pledge) => pledge.amount));
  const securedCover = acceptedCover + selfCover;

  return {
    loanId: request.loanId,
    principal: request.principal,
    required,
    selfCover,
    acceptedCover,
    pendingCover,
    securedCover,
    shortfall: nonNegative(required - securedCover),
    shortfallIfAllAccept: nonNegative(required - securedCover - pendingCover),
    coverageRatio: ratio(securedCover, required),
    fullyCovered: securedCover >= required,
    acceptedSponsorCount: accepted.length,
    pendingSponsorCount: pending.length,
    declinedSponsorCount: declined.length,
  };
}

export interface PledgeValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Check a proposed pledge before it is offered to the sponsor.
 *
 * Validating at request time rather than acceptance time matters: a sponsor
 * should never be asked to accept something the rules will then reject.
 */
export function validatePledge(
  config: CircleConfig,
  request: SponsorshipRequest,
  proposal: { sponsorId: string; amount: Money },
  sponsorExposure: MemberExposure,
): PledgeValidation {
  const problems: string[] = [];

  if (proposal.amount <= 0) problems.push('Pledge amount must be greater than zero');

  if (proposal.sponsorId === request.borrowerId) {
    problems.push('A borrower cannot sponsor their own loan; their own shares are counted as self-cover');
  }

  const alreadyAsked = request.pledges.some(
    (pledge) => pledge.sponsorId === proposal.sponsorId && pledge.status !== 'declined' && pledge.status !== 'withdrawn',
  );
  if (alreadyAsked) problems.push(`${proposal.sponsorId} has already been asked to sponsor this loan`);

  const liveCount = request.pledges.filter(
    (pledge) => pledge.status === 'pending' || pledge.status === 'accepted',
  ).length;
  if (liveCount >= config.sponsorship.maxSponsorsPerLoan) {
    problems.push(`A loan may carry at most ${config.sponsorship.maxSponsorsPerLoan} sponsors`);
  }

  const capacity = pledgeableCapacity(sponsorExposure, config.shares.parValue);
  if (proposal.amount > capacity) {
    problems.push(
      `${proposal.sponsorId} can pledge at most ${capacity}: they hold ${sponsorExposure.sharesOwned} shares, ` +
        `have ${sponsorExposure.pledgedOut} pledged elsewhere and owe ${sponsorExposure.ownOutstandingPrincipal}`,
    );
  }

  const singleLimit = config.sponsorship.maxSingleSponsorRatio;
  if (singleLimit > 0 && proposal.amount > applyRate(request.principal, singleLimit)) {
    problems.push(
      `No sponsor may carry more than ${(singleLimit * 100).toFixed(0)}% of one loan ` +
        `(${applyRate(request.principal, singleLimit)})`,
    );
  }

  return { ok: problems.length === 0, problems };
}

export type ApprovalDecision =
  | { approved: true; reason: 'fully_covered'; coverage: CoverageStatus }
  | { approved: false; reason: 'awaiting_sponsors' | 'insufficient_cover' | 'expired'; coverage: CoverageStatus };

/**
 * Decide whether a loan may now be disbursed.
 *
 * Approval is mechanical. Once cover is complete there is nothing left to
 * decide, which is the point: the borrower knows in advance exactly what has
 * to be true for the money to be released.
 */
export function evaluateApproval(
  request: SponsorshipRequest,
  options: { selfCover?: Money; asOf: ISODate },
): ApprovalDecision {
  const coverage = coverageStatus(request, options);

  if (coverage.fullyCovered) return { approved: true, reason: 'fully_covered', coverage };
  if (coverage.pendingSponsorCount > 0) return { approved: false, reason: 'awaiting_sponsors', coverage };
  if (coverage.shortfallIfAllAccept > 0) return { approved: false, reason: 'insufficient_cover', coverage };
  return { approved: false, reason: 'expired', coverage };
}

/** Mark pledges whose response window has closed. Returns the ones that lapsed. */
export function expirePledges(request: SponsorshipRequest, asOf: ISODate): Pledge[] {
  assertISODate(asOf, 'asOf');
  const lapsed: Pledge[] = [];
  for (const pledge of request.pledges) {
    if (pledge.status === 'pending' && isAfter(asOf, pledge.expiresOn)) {
      pledge.status = 'expired';
      lapsed.push(pledge);
    }
  }
  return lapsed;
}

export interface SponsorCall {
  sponsorId: string;
  pledgeId: string;
  /** What they pledged. */
  pledged: Money;
  /** What they are being called for — never more than they pledged. */
  called: Money;
  sharesForfeited: number;
  valueRecovered: Money;
  /** Called but not covered by shares; becomes a personal receivable. */
  receivable: Money;
}

export interface DefaultCascadeResult {
  loanId: string;
  /** The loss being recovered. */
  loss: Money;
  borrower: DilutionResult;
  sponsorCalls: SponsorCall[];
  /** Recovered from the borrower's own shares. */
  recoveredFromBorrower: Money;
  /** Recovered from sponsors' shares. */
  recoveredFromSponsors: Money;
  totalRecovered: Money;
  /** Owed by sponsors personally, beyond their share value. */
  totalReceivable: Money;
  /** Unrecoverable — written off against the circle's retained earnings. */
  writtenOff: Money;
}

/**
 * Absorb a defaulted loan's loss through the share register.
 *
 * This mutates the register: shares really do move. The borrower is exhausted
 * first, then sponsors pro rata to their pledges, each capped at what they
 * pledged. Whatever no share can cover is split between personal receivables
 * (where the sponsor pledged it but lacks the shares) and a write-off (where
 * the pledges never covered the loss in the first place).
 */
export function runDefaultCascade(
  register: ShareRegister,
  request: SponsorshipRequest,
  loss: Money,
  occurredOn: ISODate,
): DefaultCascadeResult {
  assertISODate(occurredOn, 'occurredOn');
  if (loss < 0) throw new SponsorshipError('Loss must not be negative');

  // 1. The borrower's own shares go first, in full.
  const borrower = dilute(register, request.borrowerId, loss, occurredOn, request.loanId);
  const recoveredFromBorrower = borrower.valueRecovered;
  let remaining = nonNegative(loss - recoveredFromBorrower);

  const accepted = request.pledges.filter(
    (pledge) => pledge.status === 'accepted' || pledge.status === 'called',
  );

  const sponsorCalls: SponsorCall[] = [];

  if (remaining > 0 && accepted.length > 0) {
    const totalPledged = sum(accepted.map((pledge) => pledge.amount));

    // 2. Sponsors share what is left pro rata to their pledges, capped at the
    //    pledge. If the pledges do not cover the remainder, each is called in
    //    full and the balance falls through to the write-off.
    const callable = Math.min(remaining, totalPledged);
    const calls = allocate(callable, accepted.map((pledge) => pledge.amount));

    accepted.forEach((pledge, index) => {
      const called = Math.min(calls[index], pledge.amount);
      if (called <= 0) {
        sponsorCalls.push({
          sponsorId: pledge.sponsorId,
          pledgeId: pledge.id,
          pledged: pledge.amount,
          called: 0,
          sharesForfeited: 0,
          valueRecovered: 0,
          receivable: 0,
        });
        return;
      }

      const result = dilute(register, pledge.sponsorId, called, occurredOn, request.loanId);
      pledge.status = 'called';

      sponsorCalls.push({
        sponsorId: pledge.sponsorId,
        pledgeId: pledge.id,
        pledged: pledge.amount,
        called,
        sharesForfeited: result.sharesForfeited,
        valueRecovered: result.valueRecovered,
        // 3. Called beyond their share value: chase it personally.
        receivable: result.shortfall,
      });
    });

    remaining = nonNegative(remaining - callable);
  }

  const recoveredFromSponsors = sum(sponsorCalls.map((call) => call.valueRecovered));
  const totalReceivable = sum(sponsorCalls.map((call) => call.receivable));

  return {
    loanId: request.loanId,
    loss,
    borrower,
    sponsorCalls,
    recoveredFromBorrower,
    recoveredFromSponsors,
    totalRecovered: recoveredFromBorrower + recoveredFromSponsors,
    totalReceivable,
    // 4. Whatever the pledges never reached is the circle's own loss.
    writtenOff: remaining,
  };
}

export interface SponsorSuggestion {
  memberId: string;
  capacity: Money;
  /** How much of the outstanding shortfall this member could take. */
  suggestedPledge: Money;
  sharesOwned: number;
}

/**
 * Propose a set of sponsors who could between them close the gap.
 *
 * Offered to the borrower in the mobile app as a starting point — the borrower
 * still chooses who to ask, since capacity is not the same as willingness.
 * Members with the most room are suggested first so the borrower needs the
 * fewest conversations.
 */
export function suggestSponsors(
  config: CircleConfig,
  shortfall: Money,
  candidates: readonly MemberExposure[],
  options: { excludeMemberIds?: readonly string[] } = {},
): SponsorSuggestion[] {
  const excluded = new Set(options.excludeMemberIds ?? []);
  const singleLimit = config.sponsorship.maxSingleSponsorRatio;

  const ranked = candidates
    .filter((exposure) => !excluded.has(exposure.memberId))
    .map((exposure) => ({ exposure, capacity: pledgeableCapacity(exposure, config.shares.parValue) }))
    .filter((entry) => entry.capacity > 0)
    .sort((a, b) => b.capacity - a.capacity);

  const perSponsorCeiling = singleLimit > 0 ? applyRate(shortfall, singleLimit) : Number.MAX_SAFE_INTEGER;

  const suggestions: SponsorSuggestion[] = [];
  let remaining = shortfall;

  for (const entry of ranked) {
    if (remaining <= 0) break;
    const suggestedPledge = Math.min(entry.capacity, remaining, perSponsorCeiling);
    if (suggestedPledge <= 0) continue;
    suggestions.push({
      memberId: entry.exposure.memberId,
      capacity: entry.capacity,
      suggestedPledge,
      sharesOwned: entry.exposure.sharesOwned,
    });
    remaining -= suggestedPledge;
  }

  return suggestions;
}

/** Total a member currently has committed across live sponsorships. */
export function totalPledgedOut(pledges: readonly Pledge[], sponsorId: string): Money {
  return sum(
    pledges
      .filter(
        (pledge) =>
          pledge.sponsorId === sponsorId && (pledge.status === 'accepted' || pledge.status === 'pending'),
      )
      .map((pledge) => pledge.amount),
  );
}

/** Cover a borrower can bring from their own shares. */
export function selfCoverFor(
  config: CircleConfig,
  register: ShareRegister,
  borrowerId: string,
  pledgedOut: Money,
  ownOutstandingPrincipal: Money,
): Money {
  if (!config.sponsorship.includeBorrowerSelfCover) return 0;
  const shareValue = holdingValue(register, borrowerId);
  return nonNegative(shareValue - pledgedOut - ownOutstandingPrincipal);
}
