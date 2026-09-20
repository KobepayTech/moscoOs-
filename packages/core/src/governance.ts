/**
 * Governance: deletion by vote.
 *
 * Every member has the power to delete circle records — but only with the
 * circle's consent. A member proposes a deletion, the others vote, and the
 * record goes if the vote carries.
 *
 * Two rules shape the implementation, and both exist to stop the feature from
 * being used to erase inconvenient history:
 *
 *   1. **Financial records are never deleted, only reversed.** A posted ledger
 *      entry, a recorded repayment, a share movement: these can be *voided* by
 *      the same vote, which posts a balancing reversal and marks the original
 *      as void. The original stays visible. A circle whose books can be edited
 *      by majority is a circle whose books mean nothing, and the members who
 *      lose from a quiet edit are exactly the ones who were not watching.
 *
 *   2. **Weight follows shares.** A member with 200 shares carries more weight
 *      than one with 50, because they have more at stake in what the record
 *      says. This is configurable — `per-member` gives one member one vote —
 *      but shares is the default.
 *
 * A proposal carries only if it clears both bars: enough of the circle turned
 * out (quorum), and enough of those who turned out were in favour (threshold).
 */

import { type ISODate, assertISODate, isAfter, isOnOrBefore } from './dates.js';
import { type CircleConfig, type DeletableEntity } from './config.js';
import { type ShareRegister, issuedShares, sharesOf } from './shares.js';

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export type VoteChoice = 'for' | 'against' | 'abstain';

export interface Vote {
  memberId: string;
  choice: VoteChoice;
  castOn: ISODate;
  /** Weight at the moment the vote was cast, frozen so later share moves cannot rewrite a past vote. */
  weight: number;
  reason?: string;
}

export type ProposalKind = 'delete' | 'void_financial_record';

export type ProposalStatus = 'open' | 'passed' | 'rejected' | 'expired' | 'executed' | 'withdrawn';

export interface DeletionProposal {
  id: string;
  kind: ProposalKind;
  /** The kind of thing being deleted, e.g. `announcement`. */
  entityType: string;
  entityId: string;
  reason: string;
  proposedBy: string;
  openedOn: ISODate;
  closesOn: ISODate;
  votes: Vote[];
  status: ProposalStatus;
  executedOn?: ISODate | null;
}

export interface Tally {
  forWeight: number;
  againstWeight: number;
  abstainWeight: number;
  /** Weight that actually voted, including abstentions. */
  castWeight: number;
  /** Total weight in the circle. */
  eligibleWeight: number;
  /** Cast weight as a fraction of eligible weight. */
  turnout: number;
  quorumMet: boolean;
  /** Share of the *decisive* weight (for + against) that was in favour. */
  approvalRatio: number;
  thresholdMet: boolean;
  /** True once the outcome can no longer change, or the window has closed. */
  decided: boolean;
  passed: boolean;
  voterCount: number;
  /** Weight that has not voted and could still swing the result. */
  undecidedWeight: number;
}

/** Voting weight of one member under the circle's rules. */
export function votingWeight(config: CircleConfig, register: ShareRegister, memberId: string): number {
  if (config.governance.weighting === 'per-member') {
    return sharesOf(register, memberId) > 0 ? 1 : 0;
  }
  return sharesOf(register, memberId);
}

/** Total voting weight across the circle. */
export function totalVotingWeight(config: CircleConfig, register: ShareRegister): number {
  if (config.governance.weighting === 'per-member') {
    return [...register.holdings.values()].filter((shares) => shares > 0).length;
  }
  return issuedShares(register);
}

/**
 * Count a proposal.
 *
 * Abstentions count toward quorum but not toward the threshold: turning up to
 * say "no opinion" helps the circle reach a decision without forcing the
 * abstainer to pick a side.
 */
export function tallyVotes(
  proposal: DeletionProposal,
  config: CircleConfig,
  register: ShareRegister,
  options: { asOf?: ISODate } = {},
): Tally {
  const eligibleWeight = totalVotingWeight(config, register);

  let forWeight = 0;
  let againstWeight = 0;
  let abstainWeight = 0;

  const seen = new Set<string>();
  for (const vote of proposal.votes) {
    // One vote per member; a later vote replaces an earlier one, so count the
    // last recorded position only.
    if (seen.has(vote.memberId)) continue;
    seen.add(vote.memberId);

    if (vote.choice === 'for') forWeight += vote.weight;
    else if (vote.choice === 'against') againstWeight += vote.weight;
    else abstainWeight += vote.weight;
  }

  const castWeight = forWeight + againstWeight + abstainWeight;
  const decisiveWeight = forWeight + againstWeight;
  const turnout = eligibleWeight === 0 ? 0 : castWeight / eligibleWeight;
  const quorumMet = turnout >= config.governance.quorumRatio;
  const approvalRatio = decisiveWeight === 0 ? 0 : forWeight / decisiveWeight;
  const thresholdMet = approvalRatio >= config.governance.passThresholdRatio;

  const undecidedWeight = Math.max(0, eligibleWeight - castWeight);

  // The outcome is settled early if the remaining weight cannot change it:
  // either enough "for" weight is already in that no combination of the rest
  // can drag it below the threshold, or the reverse.
  const bestPossibleApproval =
    decisiveWeight + undecidedWeight === 0 ? 0 : (forWeight + undecidedWeight) / (decisiveWeight + undecidedWeight);
  const worstPossibleApproval =
    decisiveWeight + undecidedWeight === 0 ? 0 : forWeight / (decisiveWeight + undecidedWeight);

  const maxTurnout = eligibleWeight === 0 ? 0 : (castWeight + undecidedWeight) / eligibleWeight;
  const quorumUnreachable = maxTurnout < config.governance.quorumRatio;

  const windowClosed = options.asOf !== undefined && isAfter(options.asOf, proposal.closesOn);
  const settledEarly =
    quorumUnreachable ||
    bestPossibleApproval < config.governance.passThresholdRatio ||
    (quorumMet && worstPossibleApproval >= config.governance.passThresholdRatio);

  const decided = windowClosed || settledEarly;

  return {
    forWeight,
    againstWeight,
    abstainWeight,
    castWeight,
    eligibleWeight,
    turnout,
    quorumMet,
    approvalRatio,
    thresholdMet,
    decided,
    passed: quorumMet && thresholdMet,
    voterCount: seen.size,
    undecidedWeight,
  };
}

/**
 * Whether a record of this kind may be deleted outright.
 *
 * Anything not on the deletable list, and anything financial while
 * `financialRecordsAreImmutable` holds, must go through a void-and-reverse
 * proposal instead.
 */
export function deletionMode(
  config: CircleConfig,
  entityType: string,
): { allowed: true; kind: ProposalKind } | { allowed: false; reason: string } {
  if (config.governance.deletableEntities.includes(entityType as DeletableEntity)) {
    return { allowed: true, kind: 'delete' };
  }

  if (FINANCIAL_ENTITIES.has(entityType)) {
    if (config.governance.financialRecordsAreImmutable) {
      return { allowed: true, kind: 'void_financial_record' };
    }
    return { allowed: true, kind: 'delete' };
  }

  return {
    allowed: false,
    reason:
      `Records of type "${entityType}" cannot be removed by vote. ` +
      `Deletable types: ${config.governance.deletableEntities.join(', ')}.`,
  };
}

const FINANCIAL_ENTITIES = new Set([
  'ledger_entry',
  'loan',
  'loan_repayment',
  'share_transaction',
  'contribution',
  'facility',
  'facility_movement',
  'disbursement',
]);

export interface OpenProposalInput {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  proposedBy: string;
  openedOn: ISODate;
}

/** Open a proposal, choosing delete-or-void according to what is being targeted. */
export function openProposal(config: CircleConfig, input: OpenProposalInput): DeletionProposal {
  assertISODate(input.openedOn, 'openedOn');

  const mode = deletionMode(config, input.entityType);
  if (!mode.allowed) throw new GovernanceError(mode.reason);

  if (!input.reason || input.reason.trim().length < 10) {
    throw new GovernanceError('A deletion proposal must carry a reason of at least 10 characters');
  }

  const closesOn = addHoursAsDays(input.openedOn, config.governance.votingWindowHours);

  return {
    id: input.id,
    kind: mode.kind,
    entityType: input.entityType,
    entityId: input.entityId,
    reason: input.reason.trim(),
    proposedBy: input.proposedBy,
    openedOn: input.openedOn,
    closesOn,
    votes: [],
    status: 'open',
    executedOn: null,
  };
}

function addHoursAsDays(date: ISODate, hours: number): ISODate {
  const days = Math.ceil(hours / 24);
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Record a vote, replacing any earlier vote by the same member. */
export function castVote(
  proposal: DeletionProposal,
  config: CircleConfig,
  register: ShareRegister,
  input: { memberId: string; choice: VoteChoice; castOn: ISODate; reason?: string },
): Vote {
  assertISODate(input.castOn, 'castOn');

  if (proposal.status !== 'open') {
    throw new GovernanceError(`Proposal ${proposal.id} is ${proposal.status} and no longer accepts votes`);
  }
  if (!isOnOrBefore(input.castOn, proposal.closesOn)) {
    throw new GovernanceError(`Voting on ${proposal.id} closed on ${proposal.closesOn}`);
  }
  if (!config.governance.proposerMayVote && input.memberId === proposal.proposedBy) {
    throw new GovernanceError('The member who opened this proposal may not vote on it');
  }

  const weight = votingWeight(config, register, input.memberId);
  if (weight <= 0) {
    throw new GovernanceError(`${input.memberId} holds no shares and carries no voting weight`);
  }

  const vote: Vote = {
    memberId: input.memberId,
    choice: input.choice,
    castOn: input.castOn,
    weight,
    reason: input.reason,
  };

  // A member may change their mind while the window is open; the latest
  // position is the one that counts.
  proposal.votes = proposal.votes.filter((existing) => existing.memberId !== input.memberId);
  proposal.votes.unshift(vote);

  return vote;
}

export interface ResolutionResult {
  proposal: DeletionProposal;
  tally: Tally;
  /** What the caller should now do to the target record. */
  action: 'delete' | 'void' | 'none';
}

/**
 * Close out a proposal whose result is settled.
 *
 * Returns the action the storage layer must take. Separating the decision from
 * the effect keeps this module pure and lets the API decide how a void is
 * represented in its own tables.
 */
export function resolveProposal(
  proposal: DeletionProposal,
  config: CircleConfig,
  register: ShareRegister,
  asOf: ISODate,
): ResolutionResult {
  assertISODate(asOf, 'asOf');
  const tally = tallyVotes(proposal, config, register, { asOf });

  if (proposal.status !== 'open') {
    return { proposal, tally, action: 'none' };
  }

  const windowClosed = isAfter(asOf, proposal.closesOn);
  if (!tally.decided && !windowClosed) {
    return { proposal, tally, action: 'none' };
  }

  if (tally.passed) {
    proposal.status = 'executed';
    proposal.executedOn = asOf;
    return { proposal, tally, action: proposal.kind === 'void_financial_record' ? 'void' : 'delete' };
  }

  proposal.status = windowClosed && !tally.quorumMet ? 'expired' : 'rejected';
  return { proposal, tally, action: 'none' };
}

export interface ProposalSummary {
  id: string;
  entityType: string;
  entityId: string;
  kind: ProposalKind;
  status: ProposalStatus;
  reason: string;
  proposedBy: string;
  openedOn: ISODate;
  closesOn: ISODate;
  tally: Tally;
  /** Plain-language statement of where the vote stands, for the admin panel. */
  headline: string;
}

export function summariseProposal(
  proposal: DeletionProposal,
  config: CircleConfig,
  register: ShareRegister,
  asOf: ISODate,
): ProposalSummary {
  const tally = tallyVotes(proposal, config, register, { asOf });

  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  let headline: string;

  if (proposal.status === 'executed') {
    headline = `Carried — ${pct(tally.approvalRatio)} in favour on ${pct(tally.turnout)} turnout`;
  } else if (proposal.status === 'rejected') {
    headline = `Rejected — ${pct(tally.approvalRatio)} in favour, ${pct(config.governance.passThresholdRatio)} needed`;
  } else if (proposal.status === 'expired') {
    headline = `Lapsed — turnout ${pct(tally.turnout)}, quorum ${pct(config.governance.quorumRatio)} not reached`;
  } else if (!tally.quorumMet) {
    headline = `Open — needs ${pct(config.governance.quorumRatio - tally.turnout)} more turnout to reach quorum`;
  } else if (tally.thresholdMet) {
    headline = `Open — carrying at ${pct(tally.approvalRatio)} in favour, closes ${proposal.closesOn}`;
  } else {
    headline = `Open — ${pct(tally.approvalRatio)} in favour, needs ${pct(config.governance.passThresholdRatio)}`;
  }

  return {
    id: proposal.id,
    entityType: proposal.entityType,
    entityId: proposal.entityId,
    kind: proposal.kind,
    status: proposal.status,
    reason: proposal.reason,
    proposedBy: proposal.proposedBy,
    openedOn: proposal.openedOn,
    closesOn: proposal.closesOn,
    tally,
    headline,
  };
}
