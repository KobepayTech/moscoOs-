/**
 * Applying for a loan, and choosing who will stand behind it.
 *
 * The flow is deliberately front-loaded with truth: before a member asks
 * anybody for anything, they see the exact instalment, the exact balloon, and
 * exactly how much cover they need to find. Sending sponsor requests is real
 * social capital being spent, and it should never be spent on an application
 * that was never going to qualify.
 */

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import { ApiError, api, money, percent, useSession } from '../api';
import {
  Alert,
  Body,
  Button,
  Card,
  CardTitle,
  Caption,
  Empty,
  Explain,
  Meter,
  Pill,
  Row,
  Screen,
  Title,
} from '../components';
import { radius, spacing, usePalette } from '../theme';

interface ScheduleRow {
  index: number;
  dueOn: string;
  kind: 'service' | 'balloon';
  openingPrincipal: number;
  principalDue: number;
  interestDue: number;
  totalDue: number;
}

interface TermQuote {
  rows: ScheduleRow[];
  levelServiceInstalment: number;
  balloon: number;
  scheduledInterest: number;
  totalRepayable: number;
  maturityOn: string;
  totalCostRatio: number;
}

interface ShortQuote {
  fee: number;
  totalRepayable: number;
  dueOn: string;
  annualisedRate: number;
}

interface QuoteResponse {
  product: 'term' | 'short_term';
  quote: TermQuote | ShortQuote;
  coverageRequired: number;
  selfCover: number;
  explanation: string;
  eligibility: {
    eligible: boolean;
    maxPrincipal: number;
    bindingConstraint: string | null;
    problems: { code: string; message: string; actionable: boolean }[];
  };
}

interface Suggestion {
  memberId: string;
  memberName: string;
  capacity: number;
  suggestedPledge: number;
}

export function BorrowScreen() {
  const palette = usePalette();
  const { config } = useSession();
  const currency = config?.currency ?? 'TZS';

  const [amountText, setAmountText] = useState('');
  const [shortTerm, setShortTerm] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loanId, setLoanId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const amount = Number(amountText.replace(/[^0-9]/g, ''));

  const inputStyle = {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    color: palette.text,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
    fontSize: 16,
  };

  const getQuote = useCallback(async () => {
    if (!amount) return setError(new ApiError(0, 'Enter how much you need, in whole shillings.'));
    setError(null);
    setBusy(true);
    try {
      setQuote(
        await api<QuoteResponse>('/loans/quote', {
          method: 'POST',
          body: { product: shortTerm ? 'short_term' : 'term', principal: amount },
        }),
      );
    } catch (problem) {
      setError(problem as ApiError);
    } finally {
      setBusy(false);
    }
  }, [amount, shortTerm]);

  const apply = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const created = await api<{ id: string }>('/loans', {
        method: 'POST',
        body: { product: shortTerm ? 'short_term' : 'term', principal: amount, purpose },
      });
      setLoanId(created.id);

      const proposed = await api<{ suggestions: Suggestion[] }>(
        `/loans/${encodeURIComponent(created.id)}/sponsor-suggestions`,
      );
      setSuggestions(proposed.suggestions);
      setChosen(
        Object.fromEntries(proposed.suggestions.map((entry) => [entry.memberId, entry.suggestedPledge])),
      );
    } catch (problem) {
      setError(problem as ApiError);
    } finally {
      setBusy(false);
    }
  }, [amount, purpose, shortTerm]);

  const sendRequests = useCallback(async () => {
    if (!loanId) return;
    setError(null);
    setBusy(true);
    try {
      await api(`/loans/${encodeURIComponent(loanId)}/sponsors`, {
        method: 'POST',
        body: {
          sponsors: Object.entries(chosen)
            .filter(([, value]) => value > 0)
            .map(([sponsorId, value]) => ({ sponsorId, amount: value })),
        },
      });
      setSent(true);
    } catch (problem) {
      setError(problem as ApiError);
    } finally {
      setBusy(false);
    }
  }, [chosen, loanId]);

  // ---- After the requests have gone out ---------------------------------

  if (sent) {
    return (
      <Screen>
        <Title>Requests sent</Title>
        <Alert tone="positive">
          The members you chose have been notified. As soon as enough of them accept, your loan approves itself
          and the cashier is told to pay it out — there is no committee meeting to wait for.
        </Alert>
        <Button
          label="Apply for another loan"
          onPress={() => {
            setSent(false);
            setLoanId(null);
            setQuote(null);
            setSuggestions(null);
            setAmountText('');
            setPurpose('');
          }}
        />
      </Screen>
    );
  }

  // ---- Choosing sponsors -------------------------------------------------

  if (loanId && suggestions) {
    const required = quote?.coverageRequired ?? amount;
    const selfCover = quote?.selfCover ?? 0;
    const pledged = Object.values(chosen).reduce((total, value) => total + value, 0);
    const secured = selfCover + pledged;
    const shortfall = Math.max(0, required - secured);

    return (
      <Screen>
        <Title>Who will stand behind you?</Title>

        <Card>
          <Body muted>
            The circle lends against members' shares, not a credit score. You need{' '}
            {money(required, currency)} of cover. Your own shares provide {money(selfCover, currency)}, so
            find members to cover the rest.
          </Body>

          <Meter ratio={required === 0 ? 1 : secured / required} complete={shortfall === 0} />
          <Row label="Cover secured" value={`${money(secured, currency)} of ${money(required, currency)}`} strong />
          {shortfall > 0 ? (
            <Row label="Still needed" value={money(shortfall, currency)} tone="warning" />
          ) : (
            <Row label="Status" value="fully covered" tone="positive" />
          )}

          <Explain>
            If you default, these members' shares are called to cover the loss — your own shares first, then
            theirs, pro rata to what each one pledged. That is why they have to agree, and why they can see
            exactly what they are taking on.
          </Explain>
        </Card>

        {error ? (
          <Alert tone="danger">
            {error.message}
            {error.problems.length ? `\n\n• ${error.problems.join('\n• ')}` : ''}
          </Alert>
        ) : null}

        <Card>
          <CardTitle>Members who could help</CardTitle>
          <Body muted>Tap to include or leave out. Suggested amounts are within what each can actually cover.</Body>

          {suggestions.length === 0 ? (
            <Empty>No other member has capacity to sponsor right now.</Empty>
          ) : (
            suggestions.map((entry) => {
              const picked = (chosen[entry.memberId] ?? 0) > 0;
              return (
                <Pressable
                  key={entry.memberId}
                  onPress={() =>
                    setChosen((current) => ({
                      ...current,
                      [entry.memberId]: picked ? 0 : entry.suggestedPledge,
                    }))
                  }
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingVertical: spacing.md,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: palette.border,
                    gap: spacing.md,
                  }}
                >
                  <View style={{ flexShrink: 1, gap: 2 }}>
                    <Body>{entry.memberName}</Body>
                    <Caption>can cover up to {money(entry.capacity, currency)}</Caption>
                  </View>
                  <Pill tone={picked ? 'accent' : 'neutral'}>
                    {picked ? money(entry.suggestedPledge, currency) : 'ask'}
                  </Pill>
                </Pressable>
              );
            })
          )}
        </Card>

        <Button
          label={shortfall > 0 ? `Send requests (still ${money(shortfall, currency)} short)` : 'Send requests'}
          variant="primary"
          onPress={sendRequests}
          loading={busy}
          disabled={pledged === 0}
        />
        <Caption>
          Each member gets a notification and has {Math.round((config?.sponsorship.responseWindowHours ?? 72) / 24)}{' '}
          days to answer.
        </Caption>
      </Screen>
    );
  }

  // ---- Quote and apply ---------------------------------------------------

  const termQuote = quote?.product === 'term' ? (quote.quote as TermQuote) : null;
  const shortQuote = quote?.product === 'short_term' ? (quote.quote as ShortQuote) : null;
  const blocking = quote?.eligibility.problems.filter((problem) => problem.code !== 'sponsors_required') ?? [];

  return (
    <Screen>
      <Title>Borrow</Title>

      <Card>
        <CardTitle>How much do you need?</CardTitle>
        <TextInput
          value={amountText}
          onChangeText={setAmountText}
          placeholder="e.g. 50000000"
          placeholderTextColor={palette.textFaint}
          keyboardType="number-pad"
          style={inputStyle}
        />

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: spacing.sm,
          }}
        >
          <View style={{ flexShrink: 1 }}>
            <Body>Short-term loan</Body>
            <Caption>
              Up to {config?.shortTermLoan.maxDays ?? 30} days, repaid in one payment with a flat{' '}
              {percent(config?.shortTermLoan.flatRate ?? 0.05, 0)} charge
            </Caption>
          </View>
          <Switch
            value={shortTerm}
            onValueChange={(next) => {
              setShortTerm(next);
              setQuote(null);
            }}
            trackColor={{ true: palette.accent }}
          />
        </View>

        <Button label="Show me what it costs" onPress={getQuote} loading={busy} />
      </Card>

      {error && !quote ? <Alert tone="danger">{error.message}</Alert> : null}

      {quote ? (
        <>
          <Card>
            <CardTitle>What you would repay</CardTitle>
            <Explain>{quote.explanation}</Explain>

            {termQuote ? (
              <View style={{ marginTop: spacing.sm }}>
                {termQuote.rows.map((row) => (
                  <Row
                    key={`${row.kind}-${row.index}`}
                    label={
                      row.kind === 'balloon'
                        ? `Final payment · ${row.dueOn}`
                        : `Month ${row.index} · ${row.dueOn}`
                    }
                    value={money(row.totalDue, currency)}
                    strong={row.kind === 'balloon'}
                  />
                ))}
                <Row label="Total interest" value={money(termQuote.scheduledInterest, currency)} />
                <Row label="Total repayable" value={money(termQuote.totalRepayable, currency)} strong />
              </View>
            ) : null}

            {shortQuote ? (
              <View style={{ marginTop: spacing.sm }}>
                <Row label="Charge" value={money(shortQuote.fee, currency)} />
                <Row label="Repay by" value={shortQuote.dueOn} />
                <Row label="Total repayable" value={money(shortQuote.totalRepayable, currency)} strong />
                <Row
                  label="Equivalent annual rate"
                  value={percent(shortQuote.annualisedRate, 0)}
                  tone="warning"
                />
              </View>
            ) : null}

            {termQuote ? (
              <Explain>
                The final payment carries no interest. All {money(termQuote.scheduledInterest, currency)} of
                it is collected inside the monthly payments, so what is left at the end is flat principal.
              </Explain>
            ) : null}

            {shortQuote ? (
              <Alert tone="warning">
                A flat {percent(config?.shortTermLoan.flatRate ?? 0.05, 0)} charge is small in shillings but
                steep as an annual rate, because the money is only out for days. Borrow short only if you can
                repay short.
              </Alert>
            ) : null}
          </Card>

          <Card>
            <CardTitle>Can you take it?</CardTitle>
            <Row
              label="Most you could borrow now"
              value={money(quote.eligibility.maxPrincipal, currency)}
              strong
            />
            {quote.eligibility.bindingConstraint ? (
              <Caption>Limited by: {quote.eligibility.bindingConstraint}</Caption>
            ) : null}
            <Row label="Cover you must find" value={money(quote.coverageRequired, currency)} />
            <Row label="From your own shares" value={money(quote.selfCover, currency)} />

            {blocking.length > 0 ? (
              <Alert tone="danger">
                {blocking.map((problem) => `• ${problem.message}`).join('\n')}
              </Alert>
            ) : null}
          </Card>

          {quote.eligibility.eligible ? (
            <Card>
              <CardTitle>What is it for?</CardTitle>
              <Body muted>
                Every member can see this. Sponsors are deciding whether to put their own shares behind you, so
                tell them plainly.
              </Body>
              <TextInput
                value={purpose}
                onChangeText={setPurpose}
                placeholder="e.g. Stock purchase from Guangzhou, arriving late February"
                placeholderTextColor={palette.textFaint}
                multiline
                style={[inputStyle, { minHeight: 90, textAlignVertical: 'top' }]}
              />
              <Button
                label="Apply and choose sponsors"
                variant="primary"
                onPress={apply}
                loading={busy}
                disabled={purpose.trim().length < 5}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
