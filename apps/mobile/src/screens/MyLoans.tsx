/**
 * The member's own loans, and what falls due next.
 */

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { api, longDate, money, useSession } from '../api';
import {
  Alert,
  Body,
  Card,
  CardTitle,
  Caption,
  Empty,
  Explain,
  Loading,
  Meter,
  Pill,
  Row,
  Screen,
  Title,
  type Tone,
} from '../components';
import { spacing, usePalette } from '../theme';
import { useAsync } from '../useAsync';

interface ScheduleRow {
  index: number;
  dueOn: string;
  kind: 'service' | 'balloon';
  principalDue: number;
  interestDue: number;
  totalDue: number;
}

interface RowStatus {
  row: ScheduleRow;
  settled: boolean;
  daysPastDue: number;
}

interface Loan {
  id: string;
  product: 'term' | 'short_term';
  principal: number;
  purpose: string | null;
  status: string;
  appliedOn: string;
  disbursedOn: string | null;
  maturityOn: string | null;
  coverage?: {
    required: number;
    securedCover: number;
    shortfall: number;
    coverageRatio: number;
    fullyCovered: boolean;
    pendingSponsorCount: number;
  };
  schedule?: {
    rows: ScheduleRow[];
    levelServiceInstalment: number;
    balloon: number;
    scheduledInterest: number;
    totalRepayable: number;
  };
  state?: {
    status: string;
    principalOutstanding?: number;
    outstanding?: number;
    interestOutstanding?: number;
    arrears?: number;
    penaltyAccrued?: number;
    payoffAmount?: number;
    rows?: RowStatus[];
  };
}

const STATUS_TONE: Record<string, Tone> = {
  awaiting_sponsors: 'warning',
  approved: 'info',
  disbursed: 'accent',
  settled: 'positive',
  defaulted: 'danger',
  declined: 'neutral',
  cancelled: 'neutral',
};

export function MyLoansScreen() {
  const palette = usePalette();
  const { member, config } = useSession();
  const currency = config?.currency ?? 'TZS';

  const { data, error, refreshing, refresh } = useAsync<{ loans: Loan[] }>(
    useCallback(
      () => api<{ loans: Loan[] }>(`/loans?memberId=${encodeURIComponent(member?.id ?? '')}`),
      [member?.id],
    ),
  );

  const [expanded, setExpanded] = useState<string | null>(null);

  if (error) {
    return (
      <Screen>
        <Alert tone="danger">{error.message}</Alert>
      </Screen>
    );
  }
  if (!data) return <Loading note="Loading your loans…" />;

  if (data.loans.length === 0) {
    return (
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Title>Your loans</Title>
        <Card>
          <Empty>You have not borrowed from the circle yet. Use the Borrow tab to see what a loan would cost.</Empty>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Title>Your loans</Title>

      {data.loans.map((loan) => {
        const open = expanded === loan.id;
        const outstanding = loan.state?.principalOutstanding ?? loan.state?.outstanding ?? null;
        const nextDue = loan.state?.rows?.find((row) => !row.settled);
        const inTrouble =
          loan.state?.status === 'in_arrears' ||
          loan.state?.status === 'overdue' ||
          loan.state?.status === 'defaulted';

        return (
          <Card key={loan.id}>
            {/*
              The whole summary is the tap target, not just the heading. A
              caption that says "tap to see the schedule" has to respond
              wherever the member actually taps.
            */}
            <Pressable
              onPress={() => setExpanded(open ? null : loan.id)}
              disabled={!loan.schedule}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`${money(loan.principal, currency)} loan, ${loan.status.replace(/_/g, ' ')}`}
            >
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: spacing.md,
                }}
              >
                <View style={{ flexShrink: 1, gap: 3 }}>
                  <CardTitle>{money(loan.principal, currency)}</CardTitle>
                  {loan.purpose ? <Caption>{loan.purpose}</Caption> : null}
                </View>
                <Pill tone={STATUS_TONE[loan.status] ?? 'neutral'}>{loan.status.replace(/_/g, ' ')}</Pill>
              </View>

              {loan.coverage ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Meter ratio={loan.coverage.coverageRatio} complete={loan.coverage.fullyCovered} />
                  <Caption>
                    {money(loan.coverage.securedCover, currency)} of {money(loan.coverage.required, currency)}{' '}
                    covered
                    {loan.coverage.pendingSponsorCount > 0
                      ? ` · ${loan.coverage.pendingSponsorCount} sponsor(s) yet to answer`
                      : ''}
                  </Caption>
                </View>
              ) : null}

              {outstanding !== null ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Row label="Still owing" value={money(outstanding, currency)} strong />
                  {nextDue ? (
                    <Row
                      label={nextDue.row.kind === 'balloon' ? 'Final payment' : 'Next payment'}
                      value={`${money(nextDue.row.totalDue, currency)} on ${longDate(nextDue.row.dueOn)}`}
                    />
                  ) : null}
                  {inTrouble ? (
                    <Row
                      label="Overdue"
                      value={money((loan.state?.arrears ?? 0) + (loan.state?.penaltyAccrued ?? 0), currency)}
                      tone="danger"
                    />
                  ) : null}
                </View>
              ) : null}

              {!open && loan.schedule ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Caption>Tap to see the full schedule</Caption>
                </View>
              ) : null}
            </Pressable>

            {open && loan.schedule ? (
              <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                <View
                  style={{
                    height: StyleSheet.hairlineWidth,
                    backgroundColor: palette.border,
                  }}
                />
                <CardTitle>Schedule</CardTitle>

                {loan.schedule.rows.map((row, index) => {
                  const status = loan.state?.rows?.[index];
                  return (
                    <Row
                      key={`${row.kind}-${row.index}`}
                      label={`${row.kind === 'balloon' ? 'Final' : `Month ${row.index}`} · ${longDate(row.dueOn)}`}
                      value={
                        status?.settled
                          ? 'paid'
                          : `${money(row.totalDue, currency)}${row.kind === 'balloon' ? ' (no interest)' : ''}`
                      }
                      tone={status?.settled ? 'positive' : status && status.daysPastDue > 0 ? 'danger' : undefined}
                    />
                  );
                })}

                <Explain>
                  Every shilling of the {money(loan.schedule.scheduledInterest, currency)} of interest is
                  collected inside the monthly payments. The final {money(loan.schedule.balloon, currency)} is
                  flat principal with no interest on it.
                </Explain>
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
