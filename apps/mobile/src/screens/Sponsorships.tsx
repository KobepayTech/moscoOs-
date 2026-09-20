/**
 * The sponsor's inbox.
 *
 * This is where the circle's credit decisions are actually made. A member
 * answering here is not "approving an application" — they are putting a named
 * amount of their own shareholding at risk, and the screen says so in those
 * words before they tap anything.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { ApiError, api, longDate, money, useSession } from '../api';
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
import { spacing } from '../theme';
import { useAsync } from '../useAsync';

interface PledgeRow {
  id: string;
  loanId: string;
  amount: number;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn' | 'called';
  requestedOn: string;
  expiresOn: string;
  borrowerName: string;
  loanPrincipal: number;
  loanPurpose: string | null;
  loanStatus: string;
}

interface Inbox {
  capacity: { sharesOwned: number; pledgedOut: number; ownOutstandingPrincipal: number };
  pledges: PledgeRow[];
}

const STATUS_TONE: Record<PledgeRow['status'], Tone> = {
  pending: 'warning',
  accepted: 'positive',
  declined: 'neutral',
  expired: 'neutral',
  withdrawn: 'neutral',
  called: 'danger',
};

export function SponsorshipsScreen() {
  const { config } = useSession();
  const currency = config?.currency ?? 'TZS';
  const parValue = config?.shares.parValue ?? 100_000;

  const { data, error, refreshing, refresh, reload } = useAsync<Inbox>(
    useCallback(() => api<Inbox>('/sponsorships'), []),
  );

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const respond = useCallback(
    async (pledgeId: string, decision: 'accept' | 'decline') => {
      setActionError(null);
      setBusyId(pledgeId);
      try {
        await api(`/sponsorships/${encodeURIComponent(pledgeId)}/respond`, {
          method: 'POST',
          body: { decision },
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
  if (!data) return <Loading note="Loading your sponsorships…" />;

  const pending = data.pledges.filter((pledge) => pledge.status === 'pending');
  const rest = data.pledges.filter((pledge) => pledge.status !== 'pending');

  const shareValue = data.capacity.sharesOwned * parValue;
  const free = Math.max(
    0,
    shareValue - data.capacity.pledgedOut - data.capacity.ownOutstandingPrincipal,
  );

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Title>Sponsorships</Title>

      <Card>
        <CardTitle>What you have to give</CardTitle>
        <Row label="Your share value" value={money(shareValue, currency)} />
        <Row label="Already committed to others" value={money(data.capacity.pledgedOut, currency)} />
        <Row label="Your own borrowing" value={money(data.capacity.ownOutstandingPrincipal, currency)} />
        <Row label="Free to pledge" value={money(free, currency)} strong />
      </Card>

      {actionError ? <Alert tone="danger">{actionError.message}</Alert> : null}

      <Card>
        <CardTitle>Waiting for your answer ({pending.length})</CardTitle>

        {pending.length === 0 ? (
          <Empty>Nobody is waiting on you.</Empty>
        ) : (
          pending.map((pledge) => (
            <View key={pledge.id} style={{ gap: spacing.sm, paddingVertical: spacing.md }}>
              <View style={{ gap: 2 }}>
                <Body>
                  <Body>{pledge.borrowerName}</Body> is asking you to stand behind{' '}
                  {money(pledge.amount, currency)} of a {money(pledge.loanPrincipal, currency)} loan.
                </Body>
                {pledge.loanPurpose ? <Caption>For: {pledge.loanPurpose}</Caption> : null}
                <Caption>Answer by {longDate(pledge.expiresOn)}</Caption>
              </View>

              <Explain>
                If {pledge.borrowerName.split(' ')[0]} defaults, up to {money(pledge.amount, currency)} of your
                shares can be called to cover it — that is{' '}
                {Math.ceil(pledge.amount / parValue)} of your {data.capacity.sharesOwned} shares. Their own
                shares are taken first; yours only if theirs do not cover the loss.
              </Explain>

              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Sponsor"
                    variant="primary"
                    onPress={() => respond(pledge.id, 'accept')}
                    loading={busyId === pledge.id}
                    disabled={pledge.amount > free}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Decline"
                    variant="danger"
                    onPress={() => respond(pledge.id, 'decline')}
                    disabled={busyId === pledge.id}
                  />
                </View>
              </View>

              {pledge.amount > free ? (
                <Alert tone="warning">
                  You cannot cover this right now: {money(pledge.amount, currency)} is more than the{' '}
                  {money(free, currency)} you have free. Declining costs the borrower nothing but time.
                </Alert>
              ) : null}
            </View>
          ))
        )}
      </Card>

      <Card>
        <CardTitle>Everything you have sponsored</CardTitle>
        {rest.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          rest.map((pledge) => (
            <View
              key={pledge.id}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingVertical: spacing.md,
                gap: spacing.md,
              }}
            >
              <View style={{ flexShrink: 1, gap: 2 }}>
                <Body>{pledge.borrowerName}</Body>
                <Caption>
                  {money(pledge.amount, currency)} · asked {longDate(pledge.requestedOn)}
                </Caption>
              </View>
              <Pill tone={STATUS_TONE[pledge.status]}>{pledge.status}</Pill>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}
