/**
 * The internal capital exchange.
 *
 * A member with money idle and a circle short of lending capital are the same
 * problem seen from two ends. Today the only way to close that gap is for one
 * person to negotiate a facility privately with the committee. The exchange
 * makes it a published, rule-bound market instead: the circle says what it
 * needs, members offer portions, and the offers become facilities.
 *
 * ## This is the facility mechanism, not a new one
 *
 * Nothing here invents a way to hold members' money. A member who lends the
 * circle capital for a term at a rate has made a **facility** (section 5 of
 * the financial model): a liability, not equity; no dilution, no vote, and a
 * return earned only on the part actually lent out. That machinery is built,
 * proved and already drives the utilisation waterfall.
 *
 * So this module does exactly three things — decide what the circle should
 * raise, check that a call is safe to publish, and allocate offers against it.
 * The moment an offer is accepted it becomes an ordinary facility drawdown
 * and every existing rule applies to it unchanged. A capital market that
 * needed its own accounting would be a capital market nobody could audit.
 *
 * ## Three ways this goes wrong, and the guards against them
 *
 * Taking money from members is not the same as taking it from an outside
 * investor. These are their savings, and the circle owes them a standard of
 * care it does not owe a bank.
 *
 * **Paying more than you earn.** A circle that borrows from its members at 2%
 * and lends at 2% is destroying its own capital while looking busy. Every call
 * must leave a spread below the published lending rate — and the spread has to
 * cover losses and running costs, not just be positive.
 *
 * **Borrowing short to lend long.** This is how institutions fail. Money taken
 * for one month and lent for three cannot be given back when it is asked for;
 * the circle is then forced to raise more to repay the last lot, which works
 * until it does not. A call's term must outlast the loans it funds.
 *
 * **One member becoming the circle.** A member who funds most of the book has
 * the circle over a barrel at renewal, whatever the governance rules say on
 * paper. Concentration is capped.
 *
 * None of these are exceptions anybody may authorise past. They are the
 * reasons the exchange is allowed to exist.
 */

import { type CircleConfig } from './config.js';
import { cleanRate } from './rate.js';
import { type ISODate, addMonths, assertISODate, compareDates, isAfter, isOnOrBefore } from './dates.js';
import { type Money, allocate, formatMoney, nonNegative, ratio, sum } from './money.js';

export class ExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeError';
  }
}

/**
 * The most the circle can pay a member, given what it lends at.
 *
 * Cleaned, because this is a subtraction of two decimals: 0.025 - 0.01 is
 * 0.015000000000000001 in IEEE-754. That is wrong to quote at a member and
 * wrong to compare a rate against — a call at exactly the ceiling would
 * otherwise pass or fail depending on which way the noise fell.
 */
function affordableRate(config: CircleConfig): number {
  return cleanRate(Math.max(0, config.termLoan.monthlyInterestRate - config.exchange.minimumSpread));
}

// ---------------------------------------------------------------------------
// What the circle needs
// ---------------------------------------------------------------------------

export interface FundingNeed {
  /** Whether the circle should be raising at all. */
  needed: boolean;
  /** Approved lending the circle cannot currently fund. */
  gap: Money;
  /** What to raise, once the reserve and a sensible round figure are applied. */
  suggestedTarget: Money;
  /** The shortest term that outlasts the loans it would fund. */
  minimumTermMonths: number;
  /** The most the circle can afford to pay, given what it lends at. */
  maximumMonthlyRate: number;
  reason: string;
}

/**
 * Decide whether to go to the members, and for how much.
 *
 * Deliberately conservative about *whether*: a circle that raises capital it
 * does not lend pays a return on idle money, which is the investor's problem
 * in section 5 turned around onto the members. The gap must be real — approved
 * loans waiting on cash, not an ambition.
 */
export function assessFundingNeed(
  config: CircleConfig,
  input: {
    /** Principal on loans already approved and waiting to be paid. */
    committedLending: Money;
    /** What could go out of the door today. */
    spendableNow: Money;
    /** Dependable repayments due inside the term being considered. */
    expectedInflow: Money;
  },
): FundingNeed {
  const shortfall = nonNegative(input.committedLending - input.spendableNow);

  // Money already on its way back covers part of the gap without anybody
  // lending anything. Raising against it would be paying for capital the
  // circle is about to have.
  const gap = nonNegative(shortfall - input.expectedInflow);

  const minimumTermMonths = config.termLoan.defaultTermMonths + config.exchange.maturityBufferMonths;
  const maximumMonthlyRate = affordableRate(config);

  if (gap <= 0) {
    return {
      needed: false,
      gap: 0,
      suggestedTarget: 0,
      minimumTermMonths,
      maximumMonthlyRate,
      reason:
        shortfall > 0
          ? 'Approved lending is ahead of cash, but repayments due cover it. Nothing to raise.'
          : 'The circle can fund everything it has approved.',
    };
  }

  // Rounded up to something a person would actually publish.
  const step = config.exchange.targetRoundingStep;
  const suggestedTarget = Math.ceil(gap / step) * step;

  return {
    needed: true,
    gap,
    suggestedTarget,
    minimumTermMonths,
    maximumMonthlyRate,
    reason:
      `${formatMoney(gap, config.currency)} of approved lending cannot be funded from cash or from ` +
      'repayments due. Raising it would put it to work immediately.',
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export type CallStatus = 'draft' | 'open' | 'filled' | 'closed' | 'cancelled';

export interface FundingCall {
  id: string;
  /** What the money is for, in the members' own words. */
  purpose: string;
  target: Money;
  /** Smallest offer accepted, so the register does not fill with fragments. */
  minimumOffer: Money;
  termMonths: number;
  /** Return per month on the utilised balance, as with any facility. */
  monthlyRate: number;
  opensOn: ISODate;
  closesOn: ISODate;
  status: CallStatus;
}

export interface CapitalOffer {
  id: string;
  callId: string;
  memberId: string;
  amount: Money;
  offeredOn: ISODate;
  status: 'offered' | 'accepted' | 'scaled' | 'declined' | 'withdrawn';
}

export interface CallProblem {
  code: string;
  message: string;
}

/**
 * Check a call before it is published.
 *
 * Published is the point of no return: members will have committed money by
 * the time anybody re-reads the terms, so everything checkable is checked
 * here rather than at settlement.
 */
export function validateFundingCall(
  config: CircleConfig,
  call: Pick<FundingCall, 'target' | 'minimumOffer' | 'termMonths' | 'monthlyRate' | 'opensOn' | 'closesOn'>,
  context: { existingFacilityPrincipal: Money; equityCapital: Money },
): CallProblem[] {
  assertISODate(call.opensOn, 'opensOn');
  assertISODate(call.closesOn, 'closesOn');

  const problems: CallProblem[] = [];
  const fail = (code: string, message: string) => problems.push({ code, message });
  const amount = (value: Money) => formatMoney(value, config.currency);

  if (call.target <= 0) fail('target', 'A call must be for a positive amount');
  if (call.minimumOffer <= 0) fail('minimum_offer', 'The minimum offer must be positive');
  if (call.minimumOffer > call.target) {
    fail('minimum_offer', 'The minimum offer cannot exceed the whole call');
  }
  if (compareDates(call.opensOn, call.closesOn) > 0) {
    fail('window', 'The call closes before it opens');
  }

  // --- Paying more than you earn ------------------------------------------

  const ceiling = affordableRate(config);
  if (call.monthlyRate > ceiling) {
    fail(
      'rate_too_high',
      `Offering ${(call.monthlyRate * 100).toFixed(2)}% a month against a lending rate of ` +
        `${(config.termLoan.monthlyInterestRate * 100).toFixed(2)}% leaves less than the ` +
        `${(config.exchange.minimumSpread * 100).toFixed(2)}% the circle needs to cover losses and ` +
        `running costs. The most it can afford is ${(ceiling * 100).toFixed(2)}%.`,
    );
  }
  if (call.monthlyRate < 0) fail('rate_negative', 'A negative return is not a facility');

  // --- Borrowing short to lend long ---------------------------------------

  const minimumTerm = config.termLoan.defaultTermMonths + config.exchange.maturityBufferMonths;
  if (call.termMonths < minimumTerm) {
    fail(
      'term_too_short',
      `Money taken for ${call.termMonths} month(s) would fund loans that run for ` +
        `${config.termLoan.defaultTermMonths}. The circle would have to repay before the loans come ` +
        `back, and would be raising again to cover it. The shortest safe term is ${minimumTerm} months.`,
    );
  }

  // --- The circle becoming a borrower ------------------------------------

  const externalAfter = context.existingFacilityPrincipal + call.target;
  const leverageCeiling = Math.round(context.equityCapital * config.exchange.maxExternalToEquity);

  if (context.equityCapital > 0 && externalAfter > leverageCeiling) {
    fail(
      'over_leveraged',
      `This would take external capital to ${amount(externalAfter)} against ${amount(context.equityCapital)} ` +
        `of members' own capital. The limit is ${config.exchange.maxExternalToEquity}× equity ` +
        `(${amount(leverageCeiling)}). A circle that owes more than it owns is somebody else's business.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Where a call stands
// ---------------------------------------------------------------------------

export interface CallPosition {
  call: FundingCall;
  offered: Money;
  /** Still to raise. */
  remaining: Money;
  /** Offered beyond the target. */
  oversubscribedBy: Money;
  fullyFunded: boolean;
  offerCount: number;
  /** The largest single member's share of the call, once allocated. */
  largestShare: number;
  open: boolean;
  headline: string;
}

export function callPosition(
  config: CircleConfig,
  call: FundingCall,
  offers: readonly CapitalOffer[],
  asOf: ISODate,
): CallPosition {
  assertISODate(asOf, 'asOf');

  const live = offers.filter(
    (offer) => offer.callId === call.id && (offer.status === 'offered' || offer.status === 'accepted' || offer.status === 'scaled'),
  );

  const offered = sum(live.map((offer) => offer.amount));
  const byMember = new Map<string, Money>();
  for (const offer of live) {
    byMember.set(offer.memberId, (byMember.get(offer.memberId) ?? 0) + offer.amount);
  }

  const largest = Math.max(0, ...byMember.values());
  const open =
    call.status === 'open' && !isAfter(asOf, call.closesOn) && isOnOrBefore(call.opensOn, asOf);

  const amount = (value: Money) => formatMoney(value, config.currency);
  const remaining = nonNegative(call.target - offered);

  return {
    call,
    offered,
    remaining,
    oversubscribedBy: nonNegative(offered - call.target),
    fullyFunded: offered >= call.target,
    offerCount: live.length,
    largestShare: ratio(largest, Math.max(offered, call.target)),
    open,
    headline:
      offered >= call.target
        ? `Fully funded: ${amount(offered)} offered against ${amount(call.target)} sought` +
          (offered > call.target ? `, oversubscribed by ${amount(offered - call.target)}` : '')
        : `${amount(offered)} of ${amount(call.target)} offered — ${amount(remaining)} still needed`,
  };
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

export interface Allocation {
  offerId: string;
  memberId: string;
  offered: Money;
  /** What the member is actually taken up on. */
  allocated: Money;
  /** Offered and not taken, returned to them. */
  scaledBackBy: Money;
  reason: string;
}

/**
 * Decide who funds how much.
 *
 * Under-subscribed, everybody is taken in full. Over-subscribed, offers are
 * scaled **pro rata** rather than filled first-come — a call open for a week
 * that in practice closes in the first ten minutes rewards whoever happened to
 * be holding their phone, which is not a way to run a members' circle. Largest
 * remainder, so the allocations sum to the target exactly.
 *
 * The concentration cap is applied as a ceiling inside the scaling rather than
 * afterwards, and what it displaces is itself redistributed pro rata. Handing
 * the displaced amount to whoever came first would re-introduce exactly the
 * unfairness pro rata exists to prevent.
 */
export function allocateOffers(
  config: CircleConfig,
  call: FundingCall,
  offers: readonly CapitalOffer[],
): Allocation[] {
  const live = offers
    .filter((offer) => offer.callId === call.id && offer.status !== 'withdrawn' && offer.status !== 'declined')
    .slice()
    .sort((a, b) => compareDates(a.offeredOn, b.offeredOn) || (a.id < b.id ? -1 : 1));

  if (live.length === 0) return [];

  const offered = sum(live.map((offer) => offer.amount));
  const amount = (value: Money) => formatMoney(value, config.currency);
  const oversubscribedBy = offered - call.target;

  // Under-subscribed: everybody in, nothing to decide.
  if (offered <= call.target) {
    return live.map((offer) => ({
      offerId: offer.id,
      memberId: offer.memberId,
      offered: offer.amount,
      allocated: offer.amount,
      scaledBackBy: 0,
      reason: 'Taken in full',
    }));
  }

  // Everyone's ceiling: their own offer, and the share of one call the
  // members allow any single person to hold.
  const cap = Math.floor(call.target * config.exchange.maxShareOfOneCall);
  const ceilings = live.map((offer) => Math.min(offer.amount, cap));

  const allocated = live.map(() => 0);
  const wasCapped = live.map(() => false);

  /*
   * Fill by repeated pro-rata rounds.
   *
   * A single pass is not enough. Scaling pro rata pushes some members over
   * their ceiling; capping them frees an amount that has to go somewhere, and
   * handing it to whoever comes first in the list re-introduces exactly the
   * unfairness pro rata exists to prevent — two members who offered the same
   * would be taken up on different amounts because of the order they happened
   * to appear in. So each round redistributes what is left pro rata among
   * whoever still has room, and repeats until nothing is left or nobody can
   * take it.
   *
   * It terminates: every round either places the remainder or caps at least
   * one member, and there are finitely many members to cap.
   */
  let remaining = Math.min(call.target, sum(ceilings));

  while (remaining > 0) {
    const eligible = live
      .map((offer, index) => ({ index, room: ceilings[index] - allocated[index], weight: offer.amount }))
      .filter((entry) => entry.room > 0);

    if (eligible.length === 0) break;

    const round = allocate(
      remaining,
      eligible.map((entry) => entry.weight),
    );

    let placed = 0;
    for (const [position, entry] of eligible.entries()) {
      const take = Math.min(round[position], entry.room);
      allocated[entry.index] += take;
      placed += take;
      // The concentration cap only *bound* if it is a real restriction on one
      // member's share — a cap set at the whole call restricts nobody, and
      // reporting it would tell a member they were capped when in fact the
      // call was simply oversubscribed.
      if (cap < call.target && allocated[entry.index] === cap && live[entry.index].amount > cap) {
        wasCapped[entry.index] = true;
      }
    }

    // Nothing could be placed even though somebody had room: the rounding
    // has nowhere left to go, and continuing would loop.
    if (placed === 0) break;
    remaining -= placed;
  }

  return live.map((offer, index) => {
    const taken = allocated[index];
    const cut = offer.amount - taken;

    return {
      offerId: offer.id,
      memberId: offer.memberId,
      offered: offer.amount,
      allocated: taken,
      scaledBackBy: cut,
      reason:
        cut === 0
          ? 'Taken in full'
          : wasCapped[index]
            ? `Scaled to the ${(config.exchange.maxShareOfOneCall * 100).toFixed(0)}% ceiling on one ` +
              `member's share of a call (${amount(cap)})`
            : `Scaled pro rata: the call was oversubscribed by ${amount(oversubscribedBy)}`,
    };
  });
}

/**
 * Turn an allocation into the facility it becomes.
 *
 * The bridge back to machinery that already exists. `committedUntil` is what
 * makes the term real: it is the date before which the member cannot ask for
 * the money back, and it is the whole reason the maturity check above matters.
 */
export function facilityFromAllocation(
  call: FundingCall,
  allocation: Allocation,
  fundedOn: ISODate,
): {
  investorMemberId: string;
  principal: Money;
  monthlyRate: number;
  fundedOn: ISODate;
  committedUntil: ISODate;
} {
  if (allocation.allocated <= 0) {
    throw new ExchangeError(`Allocation for offer ${allocation.offerId} is zero; there is no facility to create`);
  }

  return {
    investorMemberId: allocation.memberId,
    principal: allocation.allocated,
    monthlyRate: call.monthlyRate,
    fundedOn,
    committedUntil: addMonths(fundedOn, call.termMonths),
  };
}

/**
 * What a member would earn, and on what condition.
 *
 * Stated before they commit, because a facility earns on the **utilised**
 * balance and not on the money itself. A member who reads "2% a month" and
 * assumes that is what their 10,000,000 will earn has not been told the truth
 * — if the circle does not lend it out, it earns nothing, and that is the
 * deal.
 */
export function describeOffer(
  config: CircleConfig,
  call: FundingCall,
  amount: Money,
): { bestCase: Money; note: string } {
  const bestCase = Math.round(amount * call.monthlyRate * call.termMonths);
  const money = (value: Money) => formatMoney(value, config.currency);

  return {
    bestCase,
    note:
      `If the circle lends all of it for the whole ${call.termMonths} months, ${money(amount)} earns ` +
      `${money(bestCase)}. It earns on what is actually lent out, not on what you put in — idle capital ` +
      'earns nothing, which is what keeps the circle from raising more than it can use.',
  };
}
