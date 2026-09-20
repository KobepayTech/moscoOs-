/**
 * The share register.
 *
 * A circle's shares do three jobs at once, and the register has to serve all
 * three without contradiction:
 *
 *   1. *Admission*. Fifty shares at TSh 100,000 is the TSh 5,000,000 a member
 *      brings to take up a seat.
 *   2. *Entitlement*. Surplus is split by holding, so shares decide what a
 *      member earns from the circle.
 *   3. *Collateral*. A sponsor who is called on has their shares diluted to
 *      cover the loss, so shares are also what a member stands to lose.
 *
 * Authorised capital (1,000,000 shares) is the ceiling the circle may ever
 * issue. Issued capital is what members actually hold — thirty founding
 * members at fifty shares each is 1,500 issued, leaving ample room for new
 * members and for further subscriptions without another resolution.
 */

import { type ISODate } from './dates.js';
import { type CircleConfig } from './config.js';
import { type Money, allocate, applyRate, money, nonNegative, ratio } from './money.js';

export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareError';
  }
}

export type ShareTransactionKind =
  | 'subscription'
  | 'monthly_contribution'
  | 'bonus_issue'
  | 'transfer_in'
  | 'transfer_out'
  | 'dilution'
  | 'redemption';

export interface ShareTransaction {
  id: string;
  memberId: string;
  kind: ShareTransactionKind;
  /** Positive when shares are gained, negative when they are given up. */
  shares: number;
  /** Cash that changed hands. Dilutions carry the loss they absorbed. */
  amount: Money;
  occurredOn: ISODate;
  narration?: string;
  relatedLoanId?: string;
}

export interface ShareRegister {
  authorized: number;
  parValue: Money;
  /** Shares held, by member. */
  holdings: Map<string, number>;
  /** Shares forfeited to the circle through dilution, available for re-issue. */
  treasury: number;
  transactions: ShareTransaction[];
}

export function createRegister(config: CircleConfig): ShareRegister {
  return {
    authorized: config.shares.authorized,
    parValue: config.shares.parValue,
    holdings: new Map(),
    treasury: 0,
    transactions: [],
  };
}

export function issuedShares(register: ShareRegister): number {
  let total = 0;
  for (const shares of register.holdings.values()) total += shares;
  return total;
}

export function unissuedShares(register: ShareRegister): number {
  return register.authorized - issuedShares(register);
}

export function sharesOf(register: ShareRegister, memberId: string): number {
  return register.holdings.get(memberId) ?? 0;
}

/** A member's slice of the circle, as a fraction of shares in issue. */
export function ownershipRatio(register: ShareRegister, memberId: string): number {
  const issued = issuedShares(register);
  if (issued === 0) return 0;
  return sharesOf(register, memberId) / issued;
}

/** Par value of a holding — what it is worth in a loss cascade. */
export function shareValue(shares: number, parValue: Money): Money {
  return money(shares * parValue);
}

export function holdingValue(register: ShareRegister, memberId: string): Money {
  return shareValue(sharesOf(register, memberId), register.parValue);
}

/** Total par value of every share in issue — the circle's equity capital. */
export function issuedCapital(register: ShareRegister): Money {
  return shareValue(issuedShares(register), register.parValue);
}

export interface SubscriptionRequest {
  memberId: string;
  shares: number;
  occurredOn: ISODate;
  kind?: ShareTransactionKind;
  narration?: string;
  /** Skip the per-member holding ceiling (founding allotments, bonus issues). */
  bypassHoldingLimit?: boolean;
}

/**
 * Issue shares to a member.
 *
 * Two ceilings apply: the circle may not issue beyond its authorised capital,
 * and no single member may exceed `maxHoldingRatio` of the shares in issue —
 * a circle where one member holds the majority is no longer a circle.
 */
export function subscribe(
  register: ShareRegister,
  config: CircleConfig,
  request: SubscriptionRequest,
): ShareTransaction {
  const { memberId, shares, occurredOn } = request;

  if (!Number.isInteger(shares) || shares <= 0) {
    throw new ShareError(`Share count must be a positive whole number, got ${shares}`);
  }
  if (shares > unissuedShares(register)) {
    throw new ShareError(
      `Cannot issue ${shares} shares: only ${unissuedShares(register)} of ${register.authorized} remain unissued`,
    );
  }

  const holdingLimit = config.shares.maxHoldingRatio;
  const heldAfter = sharesOf(register, memberId) + shares;

  // The ceiling exists to stop one member coming to dominate the circle. It
  // does not apply to a member taking up their standard seat: the first member
  // to subscribe necessarily holds 100% of a one-member register, and the
  // fourth still holds 25%. Enforcing the ratio there would make the circle
  // impossible to found. Only holdings *beyond* the membership minimum are
  // concentration, and only those are constrained.
  const isOrdinarySeat = heldAfter <= config.shares.minimumMembershipShares;

  if (!request.bypassHoldingLimit && holdingLimit > 0 && !isOrdinarySeat) {
    const issuedAfter = issuedShares(register) + shares;
    if (heldAfter / issuedAfter > holdingLimit + 1e-9) {
      throw new ShareError(
        `Holding ceiling exceeded: ${memberId} would hold ${heldAfter} of ${issuedAfter} shares ` +
          `(${((heldAfter / issuedAfter) * 100).toFixed(1)}%), above the ${(holdingLimit * 100).toFixed(0)}% limit. ` +
          'Members may always take up the standard membership holding; the ceiling applies to shares beyond it.',
      );
    }
  }

  const transaction: ShareTransaction = {
    id: `shr_${register.transactions.length + 1}_${memberId}`,
    memberId,
    kind: request.kind ?? 'subscription',
    shares,
    amount: shareValue(shares, register.parValue),
    occurredOn,
    narration: request.narration,
  };

  register.holdings.set(memberId, sharesOf(register, memberId) + shares);
  // Re-issuing forfeited shares draws them down before minting new ones.
  register.treasury = nonNegative(register.treasury - shares);
  register.transactions.push(transaction);

  return transaction;
}

/** Whether a member holds enough shares to count as being in good standing. */
export function isFullyPaidMember(register: ShareRegister, config: CircleConfig, memberId: string): boolean {
  return sharesOf(register, memberId) >= config.shares.minimumMembershipShares;
}

/** Shares still owed before a member reaches the membership minimum. */
export function sharesOutstandingForMembership(
  register: ShareRegister,
  config: CircleConfig,
  memberId: string,
): number {
  return Math.max(0, config.shares.minimumMembershipShares - sharesOf(register, memberId));
}

export interface DilutionResult {
  memberId: string;
  sharesForfeited: number;
  valueRecovered: Money;
  /** Loss the member's shares could not cover; becomes a personal receivable. */
  shortfall: Money;
  sharesRemaining: number;
}

/**
 * Take a member's shares to cover a loss.
 *
 * Shares are forfeited whole, so recovery is rounded *up* to the next whole
 * share: a TSh 120,000 call against TSh 100,000 shares takes two shares, and
 * the TSh 80,000 of over-recovery stays with the circle. Forfeited shares go
 * to treasury rather than being cancelled, so the circle can re-issue them to
 * an incoming member instead of shrinking its own capital.
 */
export function dilute(
  register: ShareRegister,
  memberId: string,
  amountToRecover: Money,
  occurredOn: ISODate,
  relatedLoanId?: string,
): DilutionResult {
  if (amountToRecover < 0) throw new ShareError('Amount to recover must not be negative');

  const held = sharesOf(register, memberId);
  if (amountToRecover === 0 || held === 0) {
    return {
      memberId,
      sharesForfeited: 0,
      valueRecovered: 0,
      shortfall: amountToRecover,
      sharesRemaining: held,
    };
  }

  const sharesNeeded = Math.ceil(amountToRecover / register.parValue);
  const sharesForfeited = Math.min(sharesNeeded, held);
  const valueRecovered = shareValue(sharesForfeited, register.parValue);
  const shortfall = nonNegative(amountToRecover - valueRecovered);

  register.holdings.set(memberId, held - sharesForfeited);
  register.treasury += sharesForfeited;
  register.transactions.push({
    id: `shr_${register.transactions.length + 1}_${memberId}`,
    memberId,
    kind: 'dilution',
    shares: -sharesForfeited,
    amount: valueRecovered,
    occurredOn,
    narration: `Dilution to recover ${amountToRecover}`,
    relatedLoanId,
  });

  return {
    memberId,
    sharesForfeited,
    valueRecovered,
    shortfall,
    sharesRemaining: held - sharesForfeited,
  };
}

export interface SurplusDistribution {
  memberId: string;
  shares: number;
  ownershipRatio: number;
  amount: Money;
}

/**
 * Split surplus across holders, pro rata by shares.
 *
 * Largest-remainder allocation guarantees the parts sum to exactly the surplus
 * declared, so a distribution never leaves a stray shilling unaccounted for in
 * the ledger.
 */
export function distributeSurplus(register: ShareRegister, surplus: Money): SurplusDistribution[] {
  const holders = [...register.holdings.entries()].filter(([, shares]) => shares > 0);
  if (holders.length === 0) return [];

  const issued = issuedShares(register);
  const amounts = allocate(surplus, holders.map(([, shares]) => shares));

  return holders.map(([memberId, shares], index) => ({
    memberId,
    shares,
    ownershipRatio: ratio(shares, issued),
    amount: amounts[index],
  }));
}

export interface RegisterSummary {
  authorized: number;
  issued: number;
  unissued: number;
  treasury: number;
  parValue: Money;
  issuedCapital: Money;
  memberCount: number;
  largestHoldingRatio: number;
}

export function summariseRegister(register: ShareRegister): RegisterSummary {
  const issued = issuedShares(register);
  let largest = 0;
  for (const shares of register.holdings.values()) largest = Math.max(largest, shares);

  return {
    authorized: register.authorized,
    issued,
    unissued: unissuedShares(register),
    treasury: register.treasury,
    parValue: register.parValue,
    issuedCapital: issuedCapital(register),
    memberCount: [...register.holdings.values()].filter((shares) => shares > 0).length,
    largestHoldingRatio: ratio(largest, issued),
  };
}

/**
 * Net asset value of one share.
 *
 * Par value is what a share cost; net asset value is what it is now worth once
 * retained earnings are counted. The gap between the two is the members'
 * return, and it is the number the mobile app shows on the member's home tab.
 */
export function netAssetValuePerShare(register: ShareRegister, retainedEarnings: Money): Money {
  const issued = issuedShares(register);
  if (issued === 0) return register.parValue;
  return money((issuedCapital(register) + retainedEarnings) / issued);
}

/** What a member's holding is worth at current net asset value. */
export function memberNetWorth(register: ShareRegister, memberId: string, retainedEarnings: Money): Money {
  return applyRate(issuedCapital(register) + retainedEarnings, ownershipRatio(register, memberId));
}
