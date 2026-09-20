/**
 * The circle's own position, open to every member.
 *
 * Including the utilisation waterfall — which member capital is lent, which is
 * free, and how much external capital is sitting idle earning its investor
 * nothing. A member who can see this can hold the committee to account without
 * having to ask anybody for a report.
 */

import { useCallback } from 'react';
import { View } from 'react-native';

import { api, compactMoney, money, percent, useSession } from '../api';
import {
  Alert,
  Body,
  Card,
  CardTitle,
  Caption,
  Explain,
  Loading,
  Pill,
  Row,
  Screen,
  Stat,
  Title,
} from '../components';
import { radius, spacing, usePalette } from '../theme';
import { useAsync } from '../useAsync';

interface Dashboard {
  headline: string;
  circle: { name: string; currency: string };
  membership: { active: number; issued: number; netAssetValuePerShare: number; issuedCapital: number };
  capital: {
    equityPool: number;
    facilityCommitted: number;
    totalCapital: number;
    deployed: number;
    available: number;
    utilisationRatio: number;
    equityUtilised: number;
    facilityUtilised: number;
    facilityIdle: number;
  };
  lending: {
    live: number;
    settled: number;
    inArrears: number;
    arrearsAmount: number;
    defaulted: number;
    portfolioAtRisk: number;
  };
  performance: {
    income: { interestIncome: number; feeIncome: number; surplus: number };
    booksBalance: boolean;
  };
  governance: { openProposals: number };
}

export function CircleScreen() {
  const palette = usePalette();
  const { config } = useSession();
  const currency = config?.currency ?? 'TZS';

  const { data, error, refreshing, refresh } = useAsync<Dashboard>(
    useCallback(() => api<Dashboard>('/dashboard'), []),
  );

  if (error) {
    return (
      <Screen>
        <Alert tone="danger">{error.message}</Alert>
      </Screen>
    );
  }
  if (!data) return <Loading note="Loading the circle…" />;

  const { capital, membership, lending, performance } = data;
  const equityFree = Math.max(0, capital.equityPool - capital.equityUtilised);
  const total = Math.max(1, capital.totalCapital);

  const segment = (value: number, colour: string) =>
    value > 0 ? <View key={colour} style={{ flex: value / total, backgroundColor: colour }} /> : null;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Title>The circle</Title>
      <Body muted>{data.headline}</Body>

      <Card>
        <CardTitle>Whose money is at work</CardTitle>
        <Body muted>
          Lending draws the members' own capital first. External capital only starts earning once lending goes
          beyond that line.
        </Body>

        <View
          style={{
            flexDirection: 'row',
            height: 26,
            borderRadius: radius.sm,
            overflow: 'hidden',
            backgroundColor: palette.surfaceSunken,
            marginTop: spacing.sm,
          }}
        >
          {segment(capital.equityUtilised, palette.accent)}
          {segment(equityFree, palette.accentSoft)}
          {segment(capital.facilityUtilised, palette.info)}
          {segment(capital.facilityIdle, palette.infoSoft)}
        </View>

        <View style={{ marginTop: spacing.sm, gap: 5 }}>
          <Key colour={palette.accent} label="Members' capital lent" value={compactMoney(capital.equityUtilised, currency)} />
          <Key colour={palette.accentSoft} label="Members' capital free" value={compactMoney(equityFree, currency)} />
          <Key colour={palette.info} label="External capital lent" value={compactMoney(capital.facilityUtilised, currency)} />
          <Key colour={palette.infoSoft} label="External capital idle" value={compactMoney(capital.facilityIdle, currency)} />
        </View>

        {capital.facilityIdle > 0 && capital.facilityUtilised === 0 ? (
          <Explain>
            None of the external capital has been lent out, so its investor is earning nothing this period.
            That is the rule working as intended: the circle only pays for money it actually uses.
          </Explain>
        ) : null}
      </Card>

      <Card>
        <CardTitle>Capital</CardTitle>
        <Row label="Members' share capital" value={money(capital.equityPool, currency)} />
        <Row label="External capital" value={money(capital.facilityCommitted, currency)} />
        <Row label="Out on loan" value={money(capital.deployed, currency)} />
        <Row label="Free to lend" value={money(capital.available, currency)} strong />
        <Row label="Utilisation" value={percent(capital.utilisationRatio)} />
      </Card>

      <Card>
        <CardTitle>Members</CardTitle>
        <Stat
          label="Value of one share"
          value={money(membership.netAssetValuePerShare, currency)}
          note={`${membership.active} members · ${membership.issued.toLocaleString()} shares in issue`}
        />
        <View style={{ marginTop: spacing.xs }}>
          <Row label="Paid in" value={money(config?.shares.parValue ?? 100_000, currency)} />
          <Row label="Worth now" value={money(membership.netAssetValuePerShare, currency)} strong />
        </View>
      </Card>

      <Card>
        <CardTitle>Lending</CardTitle>
        <Row label="Live loans" value={String(lending.live)} />
        <Row label="Fully repaid" value={String(lending.settled)} />
        <Row
          label="In arrears"
          value={lending.inArrears ? `${lending.inArrears} · ${money(lending.arrearsAmount, currency)}` : 'none'}
          tone={lending.inArrears ? 'danger' : 'positive'}
        />
        <Row
          label="Portfolio at risk"
          value={percent(lending.portfolioAtRisk)}
          tone={lending.portfolioAtRisk > 0.1 ? 'danger' : 'positive'}
        />
      </Card>

      <Card>
        <CardTitle>Performance</CardTitle>
        <Row label="Interest earned" value={money(performance.income.interestIncome, currency)} />
        <Row label="Fees and subscriptions" value={money(performance.income.feeIncome, currency)} />
        <Row label="Surplus" value={money(performance.income.surplus, currency)} strong />
        <View style={{ marginTop: spacing.sm, flexDirection: 'row' }}>
          <Pill tone={performance.booksBalance ? 'positive' : 'danger'}>
            {performance.booksBalance ? 'the books balance' : 'the books do not balance'}
          </Pill>
        </View>
        <Caption>
          Every member can read every entry in the ledger. Nothing is ever deleted — a mistake is corrected by
          posting a reversal, and the original stays visible.
        </Caption>
      </Card>
    </Screen>
  );
}

function Key({ colour, label, value }: { colour: string; label: string; value: string }) {
  const palette = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ width: 11, height: 11, borderRadius: 3, backgroundColor: colour }} />
      <Body muted>{label}</Body>
      <View style={{ flex: 1 }} />
      <Caption>{value}</Caption>
    </View>
  );
}
