/**
 * The member's own position.
 *
 * Their numbers first — what they own, what they owe, what they have promised
 * to other people. The circle's aggregate position lives on the Circle tab;
 * a member opening the app wants to know where *they* stand.
 */

import { useCallback } from 'react';
import { View } from 'react-native';

import { api, money, percent, useSession } from '../api';
import {
  Alert,
  Body,
  Card,
  CardTitle,
  Caption,
  Explain,
  Loading,
  Meter,
  Row,
  Screen,
  Stat,
  Title,
} from '../components';
import { spacing } from '../theme';
import { useAsync } from '../useAsync';
import { MyStatementCard } from './Statements';

interface MeResponse {
  member: { fullName: string; role: string };
  shares: {
    held: number;
    required: number;
    outstanding: number;
    parValue: number;
    parValueHeld: number;
    netAssetValue: number;
    netAssetValuePerShare: number;
    ownershipRatio: number;
    fullyPaid: boolean;
  };
  standing: {
    annualFeeDue: boolean;
    contributions: { monthsDue: number; monthsPaid: number; monthsMissed: number; arrears: number };
    outstandingPrincipal: number;
    availableToPledge: number;
    suspended: boolean;
    suspendedReason: string | null;
  };
}

export function HomeScreen() {
  const { config } = useSession();
  const currency = config?.currency ?? 'TZS';

  const { data, error, refreshing, refresh } = useAsync<MeResponse>(
    useCallback(() => api<MeResponse>('/auth/me'), []),
  );

  if (error) {
    return (
      <Screen>
        <Alert tone="danger">{error.message}</Alert>
      </Screen>
    );
  }
  if (!data) return <Loading note="Loading your position…" />;

  const { shares, standing, member } = data;
  const gain = shares.netAssetValue - shares.parValueHeld;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Title>{member.fullName}</Title>

      {standing.suspended ? (
        <Alert tone="danger">
          Your borrowing rights are suspended
          {standing.suspendedReason ? `: ${standing.suspendedReason}` : '.'}
        </Alert>
      ) : null}

      <Card>
        <Stat
          label="Your stake in the circle"
          value={money(shares.netAssetValue, currency)}
          note={`${shares.held} shares · ${percent(shares.ownershipRatio, 2)} of the circle`}
        />

        {gain !== 0 ? (
          <Explain>
            You paid {money(shares.parValueHeld, currency)} for these shares. They are now worth{' '}
            {money(shares.netAssetValue, currency)} — {gain > 0 ? 'a gain' : 'a fall'} of{' '}
            {money(Math.abs(gain), currency)}, because the circle{' '}
            {gain > 0 ? 'has earned more than it has spent' : 'has spent more than it has earned'}.
          </Explain>
        ) : null}

        <View style={{ marginTop: spacing.sm }}>
          <Row label="Shares held" value={String(shares.held)} />
          <Row label="Value of one share" value={money(shares.netAssetValuePerShare, currency)} />
          <Row
            label="Membership"
            value={shares.fullyPaid ? 'fully paid' : `${shares.outstanding} shares short`}
            tone={shares.fullyPaid ? 'positive' : 'warning'}
          />
        </View>
      </Card>

      <Card>
        <CardTitle>This month</CardTitle>
        <Body muted>
          Your monthly contribution is {money(config?.membership.monthlyContribution ?? 0, currency)}, which
          buys one more share at par — so your stake grows every month you pay.
        </Body>

        <View style={{ marginTop: spacing.xs }}>
          <Row
            label="Months contributed"
            value={`${standing.contributions.monthsPaid} of ${standing.contributions.monthsDue}`}
          />
          {standing.contributions.monthsMissed > 0 ? (
            <Row
              label="Behind by"
              value={`${standing.contributions.monthsMissed} month(s)`}
              tone="danger"
            />
          ) : (
            <Row label="Standing" value="up to date" tone="positive" />
          )}
          <Row
            label="Annual subscription"
            value={standing.annualFeeDue ? 'due' : 'paid'}
            tone={standing.annualFeeDue ? 'warning' : 'positive'}
          />
        </View>
      </Card>

      <Card>
        <CardTitle>What you owe and what you have promised</CardTitle>
        <Body muted>
          Sponsoring someone commits part of your shareholding. That committed part cannot back another loan —
          including one of your own.
        </Body>

        <View style={{ marginTop: spacing.xs }}>
          <Row label="Your borrowing" value={money(standing.outstandingPrincipal, currency)} />
          <Row
            label="Free to pledge or borrow against"
            value={money(standing.availableToPledge, currency)}
            strong
          />
        </View>

        <Meter
          ratio={shares.parValueHeld === 0 ? 0 : standing.availableToPledge / shares.parValueHeld}
          complete={standing.availableToPledge === shares.parValueHeld}
        />
        <Caption>
          {money(standing.availableToPledge, currency)} of your {money(shares.parValueHeld, currency)} of share
          value is uncommitted.
        </Caption>
      </Card>

      <MyStatementCard />
    </Screen>
  );
}
