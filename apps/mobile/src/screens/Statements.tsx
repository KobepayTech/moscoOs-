/**
 * Statements, as sections rather than screens.
 *
 * Both of these are long, and neither is what a member opens the app for. They
 * sit collapsed at the bottom of the screen they belong to — the member's own
 * account under Home, the circle's cash flow under Circle — and fetch only
 * when somebody actually asks, so opening the app stays one request.
 *
 * Expand-in-place rather than a pushed screen because that is how the rest of
 * this app already works: a loan on My loans opens where it sits. Adding a
 * navigation stack for two sections would be a second idiom to learn.
 */

import { type ReactNode, useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ApiError, api, compactMoney, money, shortDate, useSession } from '../api';
import { Alert, Body, Caption, Card, CardTitle, Empty, Explain, Pill, Row, type Tone } from '../components';
import { radius, spacing, usePalette } from '../theme';

// ---------------------------------------------------------------------------
// A section that loads the first time it is opened
// ---------------------------------------------------------------------------

function useLazy<T>(load: () => Promise<T>) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (data || loading) return;

    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (problem) {
      setError(
        problem instanceof ApiError ? problem : new ApiError(0, (problem as Error).message ?? 'Failed'),
      );
    } finally {
      setLoading(false);
    }
  }, [data, load, loading, open]);

  return { open, data, error, loading, toggle };
}

function Disclosure({
  title,
  note,
  open,
  loading,
  onPress,
  children,
}: {
  title: string;
  note: string;
  open: boolean;
  loading: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const palette = usePalette();

  return (
    <Card>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        // The whole header is the target, not just the words: a heading-sized
        // tap area on a phone is a heading somebody misses.
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.md,
          marginHorizontal: -spacing.xs,
          paddingHorizontal: spacing.xs,
          paddingVertical: spacing.xs,
          borderRadius: radius.sm,
          backgroundColor: pressed ? palette.surfaceSunken : 'transparent',
        })}
      >
        <View style={{ flexShrink: 1 }}>
          <CardTitle>{title}</CardTitle>
          <Caption>{loading ? 'Loading…' : note}</Caption>
        </View>
        <Pill tone={open ? 'accent' : 'neutral'}>{open ? 'Hide' : 'Show'}</Pill>
      </Pressable>

      {open ? <View style={{ marginTop: spacing.sm }}>{children}</View> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The member's own account
// ---------------------------------------------------------------------------

type FlowKind =
  | 'shares'
  | 'savings'
  | 'borrowed'
  | 'repaid'
  | 'interest'
  | 'fees'
  | 'sponsor_called'
  | 'investor'
  | 'other';

interface StatementRow {
  entryId: string;
  date: string;
  narration: string;
  amount: number;
  kind: FlowKind;
  loanIds: string[];
  voided: boolean;
  reversalOf: string | null;
  runningTotal: number;
}

interface MemberStatement {
  rows: StatementRow[];
  paidIn: number;
  paidOut: number;
  totals: {
    shares: number;
    savings: number;
    borrowed: number;
    repaid: number;
    interest: number;
    fees: number;
    sponsorCalled: number;
    investor: number;
    net: number;
  };
  position: { coverPledged: number; coverLocked: number; coverReleased: number };
}

const KIND_LABEL: Record<FlowKind, string> = {
  shares: 'Shares',
  savings: 'Savings',
  borrowed: 'Borrowed',
  repaid: 'Repayment',
  interest: 'Interest',
  fees: 'Fee',
  sponsor_called: 'Sponsor called',
  investor: 'Capital lent',
  other: 'Other',
};

const KIND_TONE: Partial<Record<FlowKind, Tone>> = {
  shares: 'accent',
  savings: 'accent',
  borrowed: 'warning',
  repaid: 'positive',
  interest: 'info',
  fees: 'info',
  sponsor_called: 'danger',
  investor: 'info',
};

/** Every movement between this member and the circle. */
export function MyStatementCard() {
  const { member, config } = useSession();
  const currency = config?.currency ?? 'TZS';

  const { open, data, error, loading, toggle } = useLazy<MemberStatement>(
    useCallback(() => api<MemberStatement>(`/members/${member!.id}/statement`), [member]),
  );

  return (
    <Disclosure
      title="Your statement"
      note={
        data
          ? `${data.rows.length} movement(s) since you joined`
          : 'Every shilling between you and the circle'
      }
      open={open}
      loading={loading}
      onPress={() => void toggle()}
    >
      {error ? <Alert tone="danger">{error.message}</Alert> : null}

      {data ? (
        <>
          <Body muted>
            Money you paid the circle counts up; money the circle paid you counts down. The running figure on
            the right is where you stand after each one.
          </Body>

          <View style={{ marginTop: spacing.sm }}>
            {data.totals.shares !== 0 ? (
              <Row label="Paid in for shares" value={money(data.totals.shares, currency)} />
            ) : null}
            {data.totals.savings !== 0 ? (
              <Row label="Savings" value={money(data.totals.savings, currency)} />
            ) : null}
            {data.totals.fees !== 0 ? <Row label="Fees" value={money(data.totals.fees, currency)} /> : null}
            {/* Signed, so the column adds up to the net below it. A "received"
                row that does not subtract makes the last line look wrong. */}
            {data.totals.borrowed !== 0 ? (
              <Row label="Received as loans" value={money(-data.totals.borrowed, currency)} />
            ) : null}
            {data.totals.repaid !== 0 ? (
              <Row label="Principal returned" value={money(data.totals.repaid, currency)} />
            ) : null}
            {data.totals.interest !== 0 ? (
              <Row label="Interest paid" value={money(data.totals.interest, currency)} />
            ) : null}
            {data.totals.sponsorCalled !== 0 ? (
              <Row label="Called as a sponsor" value={money(data.totals.sponsorCalled, currency)} />
            ) : null}
            {data.totals.investor !== 0 ? (
              <Row label="Lent to the circle" value={money(data.totals.investor, currency)} />
            ) : null}
            <Row label="Net position" value={money(data.totals.net, currency)} strong />
          </View>

          {data.position.coverPledged > 0 ? (
            <Explain>
              You are standing behind {money(data.position.coverPledged, currency)} of other members'
              borrowing, of which {money(data.position.coverReleased, currency)} has already been released as
              they repaid. {money(data.position.coverLocked, currency)} of your shares is still committed.
            </Explain>
          ) : null}

          <View style={{ marginTop: spacing.md }}>
            {data.rows.length === 0 ? (
              <Empty>Nothing has moved between you and the circle yet.</Empty>
            ) : (
              <>
                {/* Two figures sit in the right-hand column and they are easy
                    to confuse at phone width; say which is which once. */}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingBottom: spacing.xs,
                  }}
                >
                  <Caption>Newest first</Caption>
                  <Caption>Amount · running</Caption>
                </View>

                {data.rows
                  .slice()
                  .reverse()
                  .map((row) => (
                    <Movement key={row.entryId} row={row} currency={currency} />
                  ))}
              </>
            )}
          </View>
        </>
      ) : null}
    </Disclosure>
  );
}

function Movement({ row, currency }: { row: StatementRow; currency: string }) {
  const palette = usePalette();
  const tone = KIND_TONE[row.kind];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: 9,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: palette.border,
        opacity: row.voided ? 0.6 : 1,
      }}
    >
      <View style={{ flexShrink: 1, gap: 3 }}>
        <Body>{row.narration}</Body>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Caption>{shortDate(row.date)}</Caption>
          {tone ? <Pill tone={tone}>{KIND_LABEL[row.kind]}</Pill> : null}
          {row.voided ? <Pill tone="danger">voided</Pill> : null}
          {row.reversalOf ? <Pill tone="info">reversal</Pill> : null}
        </View>
      </View>

      <View style={{ alignItems: 'flex-end' }}>
        <Body>
          {row.amount >= 0 ? '' : '−'}
          {money(Math.abs(row.amount), currency)}
        </Body>
        <Caption>{money(row.runningTotal, currency)}</Caption>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The circle's cash flow
// ---------------------------------------------------------------------------

interface CashFlowSection {
  name: 'lending' | 'earnings' | 'capital';
  label: string;
  lines: { account: string; name: string; inflow: number; outflow: number; net: number }[];
  inflow: number;
  outflow: number;
  net: number;
}

interface CashFlow {
  openingCash: number;
  closingCash: number;
  totalInflow: number;
  totalOutflow: number;
  netMovement: number;
  reconciles: boolean;
  movements: number;
  sections: CashFlowSection[];
}

const SECTION_NOTE: Record<CashFlowSection['name'], string> = {
  lending: 'Out to borrowers, and principal back. Negative here is capital at work, not a loss.',
  earnings: 'Interest and fees actually received, less what it cost to run the circle.',
  capital: 'Money from the people who put it up — which the circle earned no part of.',
};

/**
 * Where the circle's cash went.
 *
 * The surplus on the Circle tab says the circle is doing well. This says
 * whether there is anything in the account to show for it, and — the reason
 * for the three sections — what paid for the lending.
 */
export function CashFlowCard() {
  const { config } = useSession();
  const currency = config?.currency ?? 'TZS';

  const { open, data, error, loading, toggle } = useLazy<CashFlow>(
    useCallback(() => api<CashFlow>('/reports/cash-flow'), []),
  );

  return (
    <Disclosure
      title="Where the cash went"
      note={data ? `${data.movements} movement(s) recorded` : 'A surplus is not money in the account'}
      open={open}
      loading={loading}
      onPress={() => void toggle()}
    >
      {error ? <Alert tone="danger">{error.message}</Alert> : null}

      {data ? (
        <>
          {data.reconciles ? null : (
            <Alert tone="danger">
              This statement does not tie back to the ledger's own cash balance. The books need looking at.
            </Alert>
          )}

          <View style={{ marginTop: spacing.xs }}>
            <Row label="Opened with" value={money(data.openingCash, currency)} />
            <Row label="Came in" value={money(data.totalInflow, currency)} />
            <Row label="Went out" value={money(data.totalOutflow, currency)} />
            <Row label="Closed with" value={money(data.closingCash, currency)} strong />
          </View>

          <Explain>{fundingStory(data, currency)}</Explain>

          {data.sections.map((section) => (
            <View key={section.name} style={{ marginTop: spacing.md }}>
              <CardTitle>
                {section.label} · {section.net >= 0 ? '+' : '−'}
                {compactMoney(Math.abs(section.net), currency)}
              </CardTitle>
              <Caption>{SECTION_NOTE[section.name]}</Caption>

              <View style={{ marginTop: spacing.xs }}>
                {section.lines.length === 0 ? (
                  <Caption>Nothing moved under this heading.</Caption>
                ) : (
                  section.lines.map((line) => (
                    <Row
                      key={line.account}
                      label={line.name}
                      value={`${line.net >= 0 ? '+' : '−'}${money(Math.abs(line.net), currency)}`}
                    />
                  ))
                )}
              </View>
            </View>
          ))}
        </>
      ) : null}
    </Disclosure>
  );
}

/** What paid for the lending, in one sentence. */
function fundingStory(flow: CashFlow, currency: string): string {
  const of = (name: CashFlowSection['name']) =>
    flow.sections.find((section) => section.name === name)?.net ?? 0;

  const lent = -of('lending');
  const earned = of('earnings');
  const raised = of('capital');
  const amount = (value: number) => compactMoney(Math.abs(value), currency);

  if (lent <= 0) {
    return earned > 0
      ? `The circle took in ${amount(earned)} more than it spent, and lent nothing new out of it.`
      : 'No new lending went out in this period.';
  }
  if (earned >= lent) {
    return `${amount(lent)} went out on loan and the circle earned ${amount(earned)} over the same period — the lending paid for itself.`;
  }
  if (raised > 0) {
    return `${amount(lent)} went out on loan against ${amount(earned)} earned. The difference came from ${amount(raised)} of new capital, which the circle will have to give back.`;
  }
  return `${amount(lent)} went out on loan against only ${amount(earned)} earned, with no new capital raised — the circle is lending out of its reserves.`;
}
