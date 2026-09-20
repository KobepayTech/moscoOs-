/**
 * Voting on what gets removed.
 *
 * Any member can propose that a record be deleted, and everyone votes. The one
 * thing a majority cannot do is erase the books: a vote against a ledger entry
 * reverses it and leaves the original visible, with the resolution attached.
 * The screen says so explicitly, because a member voting on a financial record
 * should know they are not making it disappear.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { ApiError, api, longDate, percent, useSession } from '../api';
import {
  Alert,
  Body,
  Button,
  Card,
  CardTitle,
  Caption,
  Empty,
  Explain,
  Loading,
  Pill,
  Row,
  Screen,
  Title,
  type Tone,
} from '../components';
import { radius, spacing, usePalette } from '../theme';
import { useAsync } from '../useAsync';

interface Tally {
  forWeight: number;
  againstWeight: number;
  abstainWeight: number;
  eligibleWeight: number;
  turnout: number;
  approvalRatio: number;
  quorumMet: boolean;
  passed: boolean;
}

interface Proposal {
  id: string;
  kind: 'delete' | 'void_financial_record';
  entityType: string;
  entityId: string;
  reason: string;
  proposedByName: string;
  openedOn: string;
  closesOn: string;
  status: string;
  headline: string;
  tally: Tally;
}

const STATUS_TONE: Record<string, Tone> = {
  open: 'warning',
  executed: 'positive',
  rejected: 'neutral',
  expired: 'neutral',
  withdrawn: 'neutral',
};

export function VotesScreen() {
  const palette = usePalette();
  const { config } = useSession();

  const { data, error, refreshing, refresh, reload } = useAsync<{ proposals: Proposal[] }>(
    useCallback(() => api<{ proposals: Proposal[] }>('/proposals'), []),
  );

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const vote = useCallback(
    async (proposalId: string, choice: 'for' | 'against' | 'abstain') => {
      setActionError(null);
      setBusyId(proposalId);
      try {
        await api(`/proposals/${encodeURIComponent(proposalId)}/votes`, {
          method: 'POST',
          body: { choice },
        });
        await reload();
      } catch (problem) {
        setActionError(problem as ApiError);
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  if (error) {
    return (
      <Screen>
        <Alert tone="danger">{error.message}</Alert>
      </Screen>
    );
  }
  if (!data) return <Loading note="Loading proposals…" />;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Title>Votes</Title>
      <Body muted>
        Any member can propose that a record be removed, and the circle decides together. Weight follows
        shares: a proposal carries when {percent(config?.governance.quorumRatio ?? 0.5, 0)} of the shares vote
        and {percent(config?.governance.passThresholdRatio ?? 2 / 3, 0)} of those cast are in favour.
      </Body>

      {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}

      {data.proposals.length === 0 ? (
        <Card>
          <Empty>Nothing to vote on.</Empty>
        </Card>
      ) : null}

      {data.proposals.map((proposal) => {
        const { tally } = proposal;
        const total = Math.max(1, tally.eligibleWeight);

        return (
          <Card key={proposal.id}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: spacing.md,
              }}
            >
              <View style={{ flexShrink: 1, gap: 3 }}>
                <CardTitle>Remove {proposal.entityType.replace(/_/g, ' ')}</CardTitle>
                <Caption>
                  proposed by {proposal.proposedByName} on {longDate(proposal.openedOn)}
                </Caption>
              </View>
              <Pill tone={STATUS_TONE[proposal.status] ?? 'neutral'}>{proposal.status}</Pill>
            </View>

            <Body muted>{proposal.reason}</Body>

            {proposal.kind === 'void_financial_record' ? (
              <Explain>
                This is a financial record. Even if the vote carries it is not deleted — a balancing reversal
                is posted and the original stays in the ledger, marked void, with this resolution attached.
                The circle's history cannot be rewritten by a majority.
              </Explain>
            ) : null}

            <View
              style={{
                flexDirection: 'row',
                height: 9,
                borderRadius: 999,
                overflow: 'hidden',
                backgroundColor: palette.surfaceSunken,
                marginTop: spacing.sm,
              }}
            >
              <View style={{ flex: tally.forWeight / total, backgroundColor: palette.positive }} />
              <View style={{ flex: tally.againstWeight / total, backgroundColor: palette.danger }} />
              <View style={{ flex: tally.abstainWeight / total, backgroundColor: palette.border }} />
              <View style={{ flex: Math.max(0, 1 - (tally.forWeight + tally.againstWeight + tally.abstainWeight) / total) }} />
            </View>

            <Caption>{proposal.headline}</Caption>
            <Caption>
              {tally.forWeight.toLocaleString()} for · {tally.againstWeight.toLocaleString()} against ·{' '}
              {tally.abstainWeight.toLocaleString()} abstaining · turnout {percent(tally.turnout, 0)}
            </Caption>

            {proposal.status === 'open' ? (
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="In favour"
                    variant="primary"
                    onPress={() => vote(proposal.id, 'for')}
                    loading={busyId === proposal.id}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Against"
                    variant="danger"
                    onPress={() => vote(proposal.id, 'against')}
                    disabled={busyId === proposal.id}
                  />
                </View>
                <View style={{ flex: 0.8 }}>
                  <Button
                    label="Abstain"
                    onPress={() => vote(proposal.id, 'abstain')}
                    disabled={busyId === proposal.id}
                  />
                </View>
              </View>
            ) : (
              <Row label="Closed" value={longDate(proposal.closesOn)} />
            )}
          </Card>
        );
      })}

      <View style={{ height: spacing.md, borderRadius: radius.sm }} />
    </Screen>
  );
}
