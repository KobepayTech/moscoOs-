/**
 * Payments.
 *
 * Two flows arrive here that are not the circle's ordinary money:
 *
 *   - the **loan application fee**, which gates whether a request goes out to
 *     sponsors, and which the circle owes back if the loan is not approved;
 *   - the **platform subscription**, which belongs to the operator and never
 *     touches the circle's books.
 *
 * Everything in here is written to be safe to repeat. A USSD prompt the member
 * retries, a callback the rail delivers twice, a cashier who taps confirm
 * again because the first tap seemed not to work: none of these may charge
 * twice or post twice. Idempotency keys make the first case a no-op, and
 * `ledger_entry_id` on the intent makes the second one impossible — an intent
 * that has already posted cannot post again.
 */

import {
  applicationFeeEarnedEntry,
  applicationFeeHeldEntry,
  applicationFeeRefundedEntry,
  describeFeeSplit,
  formatMoney,
  monthKey,
  splitPlatformFee,
  subscriptionStatus,
  today,
  type Money,
} from '@mamogoro/core';

import { CASHIER_ROLES } from '../auth.js';
import { audit, buildBook, loadConfig, loadLoan, notify, post, writeSnapshot } from '../circle.js';
import { type Db, newId, nowISO, transact } from '../db.js';
import { type Ctx, ApiError, type Router, dateField, enumField, moneyField, str } from '../http.js';
import { listProviders, providerFor, ProviderNotConfiguredError } from '../providers.js';
import { findMember } from './members.js';

export interface PaymentRow {
  id: string;
  idempotency_key: string;
  purpose: string;
  member_id: string;
  loan_id: string | null;
  gross_amount: number;
  fee_amount: number;
  net_amount: number;
  beneficiary: 'circle' | 'operator';
  provider: string;
  provider_ref: string | null;
  status: string;
  period: string | null;
  failure_reason: string | null;
  proof_reference: string | null;
  ledger_entry_id: string | null;
  refund_entry_id: string | null;
  created_at: string;
  confirmed_at: string | null;
}

function findPayment(db: Db, id: string): PaymentRow {
  const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) as unknown as
    | PaymentRow
    | undefined;
  if (!row) throw ApiError.notFound(`No payment with id ${id}`);
  return row;
}

/** The application fee intent for a loan, if one has been started. */
export function applicationFeeFor(db: Db, loanId: string): PaymentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM payment_intents
        WHERE loan_id = ? AND purpose = 'loan_application_fee'
          AND status IN ('pending','initiated','confirmed','refunded')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(loanId) as unknown as PaymentRow | undefined;
}

/**
 * Where a loan's application fee stands, in the terms the core engine uses.
 *
 * Exported because the loan routes gate sponsor requests on it.
 */
export function applicationFeeState(
  db: Db,
  loanId: string,
): 'unpaid' | 'awaiting_confirmation' | 'held' | 'earned' | 'refunded' {
  const payment = applicationFeeFor(db, loanId);
  if (!payment) return 'unpaid';

  if (payment.status === 'refunded') return 'refunded';
  if (payment.status === 'confirmed') {
    // Earned once the loan it paid for was approved.
    const loan = db.prepare('SELECT status FROM loans WHERE id = ?').get(loanId) as unknown as
      | { status: string }
      | undefined;
    const decided = loan && ['approved', 'disbursed', 'settled', 'defaulted'].includes(loan.status);
    return decided ? 'earned' : 'held';
  }
  if (payment.status === 'initiated' || payment.status === 'pending') return 'awaiting_confirmation';

  return 'unpaid';
}

/** Months a member has paid the platform subscription for. */
export function subscriptionPeriods(db: Db, memberId: string): string[] {
  return (
    db
      .prepare('SELECT period FROM platform_subscriptions WHERE member_id = ? ORDER BY period')
      .all(memberId) as unknown as { period: string }[]
  ).map((row) => row.period);
}

export function subscriptionFor(db: Db, memberId: string, asOf = today()) {
  const config = loadConfig(db);
  const member = findMember(db, memberId);

  return subscriptionStatus({
    joinedOn: member.joined_on,
    paidPeriods: subscriptionPeriods(db, memberId),
    monthlyAmount: config.platform.memberSubscription,
    graceDays: config.platform.subscriptionGraceDays,
    asOf,
  });
}

// ---------------------------------------------------------------------------
// Posting a confirmed payment
// ---------------------------------------------------------------------------

/**
 * Record that money arrived, exactly once.
 *
 * Returns false when the intent has already been posted, so a repeated
 * callback is a no-op rather than a double credit.
 */
function postConfirmation(db: Db, payment: PaymentRow, confirmedOn: string, actorId?: string): boolean {
  if (payment.ledger_entry_id) return false;

  const config = loadConfig(db);

  // The subscription is the operator's revenue. The circle is not a party to
  // it, so it is recorded against the member and nowhere in the books.
  if (payment.purpose === 'platform_subscription') {
    db.prepare(
      `INSERT INTO platform_subscriptions (id, member_id, period, amount, paid_on, payment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id, period) DO NOTHING`,
    ).run(
      newId('sub'),
      payment.member_id,
      payment.period,
      payment.gross_amount,
      confirmedOn,
      payment.id,
      nowISO(),
    );

    db.prepare(
      "UPDATE payment_intents SET status = 'confirmed', confirmed_at = ?, settled_at = ? WHERE id = ?",
    ).run(nowISO(), confirmedOn, payment.id);
    return true;
  }

  if (payment.purpose === 'loan_application_fee') {
    const book = buildBook(db);
    const entryId = newId('je');

    // Only the net is posted. The rail's charge was settled between the member
    // and the rail; the circle never held it.
    post(db, book, {
      ...applicationFeeHeldEntry(
        { id: entryId, date: confirmedOn, reference: payment.provider_ref ?? undefined, postedBy: actorId },
        { memberId: payment.member_id, loanId: payment.loan_id!, net: payment.net_amount },
      ),
    });

    db.prepare(
      `UPDATE payment_intents SET status = 'confirmed', confirmed_at = ?, settled_at = ?, ledger_entry_id = ?
        WHERE id = ?`,
    ).run(nowISO(), confirmedOn, entryId, payment.id);

    writeSnapshot(db, config, confirmedOn);

    notify(db, {
      memberId: payment.member_id,
      kind: 'application_fee_paid',
      title: 'Application fee received',
      body:
        `${formatMoney(payment.gross_amount, config.currency)} received for loan ${payment.loan_id}. ` +
        `Your request can now go out to sponsors. If the loan is not approved, ` +
        `${formatMoney(payment.net_amount, config.currency)} is refunded.`,
      payload: { loanId: payment.loan_id, paymentId: payment.id },
      actionUrl: `/loans/${payment.loan_id}`,
    });

    return true;
  }

  throw ApiError.unprocessable(`No posting rule for a ${payment.purpose} payment`);
}

/**
 * Recognise a held application fee as income once the loan is approved.
 *
 * Called by the loan routes at the moment of approval, so the two can never
 * drift apart.
 */
export function earnApplicationFee(db: Db, loanId: string, onDate: string, actorId?: string): void {
  const payment = applicationFeeFor(db, loanId);
  if (!payment || payment.status !== 'confirmed' || !payment.ledger_entry_id) return;

  // Already recognised?
  const already = db
    .prepare(
      `SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.loan_id = ? AND jl.account = 'FEE_INCOME'`,
    )
    .get(loanId);
  if (already) return;

  const book = buildBook(db);
  post(db, book, {
    ...applicationFeeEarnedEntry(
      { id: newId('je'), date: onDate, postedBy: actorId },
      { memberId: payment.member_id, loanId, net: payment.net_amount },
    ),
  });
}

/**
 * Give a held application fee back when the loan does not go ahead.
 *
 * The refund is the **net** — what the circle actually received. The member
 * was told before paying that the rail's charge is not recoverable.
 */
export function refundApplicationFee(
  db: Db,
  loanId: string,
  onDate: string,
  reason: string,
  actorId?: string,
): Money {
  const config = loadConfig(db);
  if (!config.applicationFee.refundable) return 0;

  const payment = applicationFeeFor(db, loanId);
  if (!payment || payment.status !== 'confirmed' || payment.refund_entry_id) return 0;

  const amount =
    config.applicationFee.refundMode === 'gross' ? payment.gross_amount : payment.net_amount;

  const book = buildBook(db);
  const entryId = newId('je');

  post(db, book, {
    ...applicationFeeRefundedEntry(
      { id: entryId, date: onDate, postedBy: actorId },
      { memberId: payment.member_id, loanId, amount },
    ),
  });

  db.prepare("UPDATE payment_intents SET status = 'refunded', refund_entry_id = ? WHERE id = ?").run(
    entryId,
    payment.id,
  );

  notify(db, {
    memberId: payment.member_id,
    kind: 'application_fee_refunded',
    title: 'Your application fee has been refunded',
    body:
      `${formatMoney(amount, config.currency)} has been returned for loan ${loanId}: ${reason}. ` +
      (config.applicationFee.refundMode === 'net' && payment.fee_amount > 0
        ? `The ${formatMoney(payment.fee_amount, config.currency)} payment charge is not recoverable.`
        : ''),
    payload: { loanId, paymentId: payment.id },
  });

  return amount;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerPaymentRoutes(router: Router, db: Db): void {
  /** Which rails are wired, and what each still needs. */
  router.get('/payments/providers', () => ({ providers: listProviders() }));

  router.get('/payments', ({ principal, query }) => {
    const mine = query.get('all') !== 'true' || !['cashier', 'chair'].includes(principal!.role);

    const rows = (
      mine
        ? db
            .prepare('SELECT * FROM payment_intents WHERE member_id = ? ORDER BY created_at DESC LIMIT 200')
            .all(principal!.memberId)
        : db.prepare('SELECT * FROM payment_intents ORDER BY created_at DESC LIMIT 200').all()
    ) as unknown as PaymentRow[];

    return { payments: rows };
  });

  /**
   * Start collecting the application fee for a loan.
   *
   * Safe to call repeatedly: the idempotency key is derived from the loan, so
   * a member who taps twice gets the same intent back rather than a second
   * charge.
   */
  router.post('/loans/:id/application-fee', async ({ params, body, principal }) => {
    const config = loadConfig(db);
    const loan = loadLoan(db, params.id);

    if (loan.member_id !== principal!.memberId) {
      throw ApiError.forbidden('Only the borrower may pay the fee for their own application');
    }
    if (loan.status !== 'awaiting_sponsors') {
      throw ApiError.conflict(`Loan ${loan.id} is ${loan.status}; no application fee is due`);
    }

    const existing = applicationFeeFor(db, loan.id);
    if (existing && existing.status === 'confirmed') {
      throw ApiError.conflict('The application fee for this loan has already been paid');
    }
    if (existing && (existing.status === 'pending' || existing.status === 'initiated')) {
      // Already in flight — hand back the same intent rather than charging again.
      return { payment: existing, alreadyInFlight: true };
    }

    const providerName = str(body, 'provider', { optional: true }) || config.applicationFee.provider;
    const provider = providerFor(providerName);
    const split = splitPlatformFee(config.applicationFee.amount, config.applicationFee.processingFeeRate);
    const member = findMember(db, principal!.memberId);

    const created = transact(db, () => {
      const id = newId('pay');
      // One live fee per loan, whatever the client does.
      const idempotencyKey = `application_fee:${loan.id}`;

      db.prepare(
        `INSERT INTO payment_intents
           (id, idempotency_key, purpose, member_id, loan_id, gross_amount, fee_amount, net_amount,
            beneficiary, provider, status, created_at)
         VALUES (?, ?, 'loan_application_fee', ?, ?, ?, ?, ?, 'circle', ?, 'pending', ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(
        id,
        idempotencyKey,
        member.id,
        loan.id,
        split.gross,
        split.processingFee,
        split.net,
        providerName,
        nowISO(),
      );

      const intent = db
        .prepare('SELECT * FROM payment_intents WHERE idempotency_key = ?')
        .get(idempotencyKey) as unknown as PaymentRow;

      audit(db, {
        actorId: principal!.memberId,
        action: 'application_fee_started',
        entityType: 'loan',
        entityId: loan.id,
        detail: { paymentId: intent.id, gross: split.gross, net: split.net },
      });

      return intent;
    });

    /*
     * The push happens after the transaction, never inside it.
     *
     * Initiating is a network call to the rail, and holding a SQLite write
     * transaction open across it would block every other write for as long as
     * PalmPesa takes to answer. The intent is already durable by this point,
     * so a failure here leaves a pending intent somebody can retry or pay in
     * cash — which is the right outcome, rather than losing the record of the
     * attempt.
     */
    const push = await pushToRail(db, provider, created, {
      payerName: member.full_name,
      payerPhone: member.phone,
      payerEmail: member.email ?? undefined,
      narrative: `Loan application fee — ${config.circleName}`,
      currency: config.currency,
    });

    return {
      payment: findPayment(db, created.id),
      split,
      instruction: push.instruction,
      explanation: describeFeeSplit(split, (amount) => formatMoney(amount, config.currency)),
    };
  });

  /**
   * Send the prompt, and record what the rail said.
   *
   * Every failure here is recoverable by hand, so none of them is fatal: a
   * circle must never be unable to take money because an API is down. What
   * the member is told changes, not whether the intent survives.
   */
  async function pushToRail(
    database: Db,
    provider: ReturnType<typeof providerFor>,
    intent: PaymentRow,
    details: {
      payerName: string;
      payerPhone: string;
      payerEmail?: string;
      narrative: string;
      currency: string;
    },
  ): Promise<{ instruction: string }> {
    if (!provider.supportsPush) {
      return { instruction: 'Hand the money to the cashier, who will confirm it against a receipt.' };
    }
    if (!provider.configured) {
      return {
        instruction:
          `The ${provider.name} rail is not connected yet. Pay the cashier and ask them to record it.`,
      };
    }

    try {
      const result = await provider.initiate({
        intentId: intent.id,
        // The intent id is what goes out as the rail's transaction_id and
        // comes back as the callback's reference.
        reference: intent.id,
        grossAmount: intent.gross_amount,
        currency: details.currency,
        payerPhone: details.payerPhone,
        payerName: details.payerName,
        payerEmail: details.payerEmail,
        narrative: details.narrative,
      });

      database
        .prepare("UPDATE payment_intents SET status = 'initiated', provider_ref = ?, initiated_at = ? WHERE id = ?")
        .run(result.providerRef, nowISO(), intent.id);

      return {
        instruction: result.instruction ?? 'A prompt has been sent to your handset.',
      };
    } catch (error) {
      const reason = (error as Error).message;
      database.prepare('UPDATE payment_intents SET failure_reason = ? WHERE id = ?').run(reason, intent.id);

      return {
        instruction:
          `The prompt could not be sent (${reason}). Pay the cashier instead and ask them to record it.`,
      };
    }
  }

  /**
   * Confirm a payment by hand.
   *
   * The cashier's route, used for cash and bank payments and whenever a rail
   * is unreachable. Requires evidence, and posts exactly once.
   */
  router.post(
    '/payments/:id/confirm',
    ({ params, body, principal }) => {
      const payment = findPayment(db, params.id);
      const proof = str(body, 'proof', { max: 200 });
      const confirmedOn = dateField(body, 'paidOn', today());

      if (payment.status === 'confirmed') {
        return { payment, alreadyConfirmed: true };
      }
      if (payment.status === 'refunded' || payment.status === 'expired') {
        throw ApiError.conflict(`That payment is ${payment.status} and cannot be confirmed`);
      }

      return transact(db, () => {
        db.prepare('UPDATE payment_intents SET proof_reference = ?, recorded_by = ? WHERE id = ?').run(
          proof,
          principal!.memberId,
          payment.id,
        );

        const posted = postConfirmation(
          db,
          { ...payment, proof_reference: proof },
          confirmedOn,
          principal!.memberId,
        );

        audit(db, {
          actorId: principal!.memberId,
          action: 'payment_confirmed',
          entityType: 'payment',
          entityId: payment.id,
          detail: { proof, posted },
        });

        return { payment: findPayment(db, payment.id), posted };
      });
    },
    { roles: CASHIER_ROLES },
  );

  /**
   * A rail's callback.
   *
   * Public, because the rail cannot hold a member token — which is exactly why
   * the signature check is not optional. An unverified callback would let
   * anyone who can reach this endpoint credit any account.
   */
  const handleCallback = async ({ params, body, rawBody, req }: Ctx) => {
    const provider = providerFor(params.provider);
    const signature =
      (req.headers['x-webhook-signature'] as string | undefined) ??
      (req.headers['x-signature'] as string | undefined);

    // The bytes as they arrived. Re-serialising the parsed body can reorder
    // keys and produce a different digest from the one the sender signed.
    if (!provider.verifyCallback(rawBody ?? '', signature)) {
      throw ApiError.unauthorized('Callback signature did not verify');
    }

    let parsed;
    try {
      parsed = provider.parseCallback(body);
    } catch (error) {
      if (error instanceof ProviderNotConfiguredError) throw ApiError.unprocessable(error.message);
      throw ApiError.badRequest((error as Error).message);
    }

    /*
     * The reference is ours, the order id is theirs.
     *
     * `transaction_id` goes out as the intent id and comes back as the
     * callback's `reference`, so that is the first thing to match on. The
     * rail's own order id is the fallback, for callbacks that carry only it.
     */
    const payment = (db
      .prepare('SELECT * FROM payment_intents WHERE id = ? AND provider = ?')
      .get(parsed.providerRef, params.provider) ??
      db
        .prepare('SELECT * FROM payment_intents WHERE provider = ? AND provider_ref = ?')
        .get(params.provider, parsed.providerRef)) as unknown as PaymentRow | undefined;

    // One PalmPesa account serves several products, so callbacks for other
    // systems reach this endpoint too. Acknowledge rather than 404: a rail
    // that gets an error will retry something that was never ours.
    if (!payment) return { received: true, ignored: 'not a payment of this circle' };

    // Repeat deliveries are expected and must be harmless.
    if (payment.status === 'confirmed') return { received: true, alreadyConfirmed: true };

    /*
     * PENDING is not a confirmation.
     *
     * The member has been sent the prompt and has not answered it. Treating
     * that as payment would credit a fee nobody has paid — and PalmPesa does
     * send interim callbacks.
     */
    if (parsed.status === 'pending') {
      return { received: true, status: 'pending' };
    }

    return transact(db, () => {
      if (parsed.status === 'failed') {
        db.prepare("UPDATE payment_intents SET status = 'failed', failure_reason = ? WHERE id = ?").run(
          parsed.failureReason ?? 'declined',
          payment.id,
        );
        return { received: true, status: 'failed' };
      }

      // Record the rail's own receipt: it is what a member quotes in a
      // dispute, and what a settlement line is matched against later.
      if (parsed.railReceipt) {
        db.prepare('UPDATE payment_intents SET proof_reference = ? WHERE id = ?').run(
          parsed.railReceipt,
          payment.id,
        );
      }

      const posted = postConfirmation(db, payment, today());
      return { received: true, status: 'confirmed', posted };
    });
  };

  // The path KobeOS's rails are configured to call, so one PalmPesa account
  // can serve both systems without per-product callback URLs.
  router.post('/webhooks/:provider', handleCallback, { public: true });

  // The original path, kept so anything already pointed at it keeps working.
  router.post('/payments/callback/:provider', handleCallback, { public: true });

  // -------------------------------------------------------------------------
  // The platform subscription
  // -------------------------------------------------------------------------

  router.get('/subscription', ({ principal }) => {
    const config = loadConfig(db);
    const status = subscriptionFor(db, principal!.memberId);

    return {
      operator: config.platform.operator,
      monthlyAmount: config.platform.memberSubscription,
      provider: config.platform.subscriptionProvider,
      status,
      paidPeriods: subscriptionPeriods(db, principal!.memberId),
      note:
        'This subscription is payable to ' +
        `${config.platform.operator} for use of the software. It is not a contribution to the circle ` +
        'and does not appear in the circle’s books. If it lapses you can still see your money, ' +
        'repay what you owe and vote — only borrowing and sponsoring are withheld.',
    };
  });

  /** Start collecting a month's subscription. */
  router.post('/subscription/pay', ({ body, principal }) => {
    const config = loadConfig(db);
    const period = str(body, 'period', { optional: true }) || monthKey(today());

    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw ApiError.badRequest('"period" must be a month in YYYY-MM form');
    }

    const already = db
      .prepare('SELECT 1 FROM platform_subscriptions WHERE member_id = ? AND period = ?')
      .get(principal!.memberId, period);
    if (already) throw ApiError.conflict(`Your subscription for ${period} is already paid`);

    const providerName = str(body, 'provider', { optional: true }) || config.platform.subscriptionProvider;
    const provider = providerFor(providerName);

    return transact(db, () => {
      const id = newId('pay');
      const idempotencyKey = `subscription:${principal!.memberId}:${period}`;

      db.prepare(
        `INSERT INTO payment_intents
           (id, idempotency_key, purpose, member_id, gross_amount, fee_amount, net_amount,
            beneficiary, provider, status, period, created_at)
         VALUES (?, ?, 'platform_subscription', ?, ?, 0, ?, 'operator', ?, 'pending', ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(
        id,
        idempotencyKey,
        principal!.memberId,
        config.platform.memberSubscription,
        config.platform.memberSubscription,
        providerName,
        period,
        nowISO(),
      );

      const intent = db
        .prepare('SELECT * FROM payment_intents WHERE idempotency_key = ?')
        .get(idempotencyKey) as unknown as PaymentRow;

      return {
        payment: intent,
        instruction: provider.configured
          ? 'A prompt has been sent to your handset.'
          : `The ${providerName} rail is not connected yet. Pay the cashier and ask them to record it.`,
      };
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Compare what the rails say against what the books say.
   *
   * Anything listed here is a discrepancy someone must resolve: money the
   * rail confirmed that never posted, or an intent stuck in flight.
   */
  router.get('/payments/reconciliation', ({ query }) => {
    const from = query.get('from') ?? '1970-01-01';
    const to = query.get('to') ?? today();

    const confirmed = db
      .prepare(
        `SELECT * FROM payment_intents
          WHERE status = 'confirmed' AND settled_at BETWEEN ? AND ? ORDER BY settled_at`,
      )
      .all(from, to) as unknown as PaymentRow[];

    const unposted = confirmed.filter(
      (payment) => payment.purpose !== 'platform_subscription' && !payment.ledger_entry_id,
    );

    const stuck = db
      .prepare(
        `SELECT * FROM payment_intents
          WHERE status IN ('pending','initiated') AND created_at < ?`,
      )
      .all(new Date(Date.now() - 86_400_000).toISOString()) as unknown as PaymentRow[];

    const toCircle = confirmed.filter((payment) => payment.beneficiary === 'circle');
    const toOperator = confirmed.filter((payment) => payment.beneficiary === 'operator');

    const sum = (rows: PaymentRow[], field: 'gross_amount' | 'fee_amount' | 'net_amount') =>
      rows.reduce((total, row) => total + row[field], 0);

    return {
      period: { from, to },
      circle: {
        count: toCircle.length,
        grossCollected: sum(toCircle, 'gross_amount'),
        railCharges: sum(toCircle, 'fee_amount'),
        netReceived: sum(toCircle, 'net_amount'),
      },
      operator: {
        count: toOperator.length,
        collected: sum(toOperator, 'gross_amount'),
      },
      discrepancies: {
        confirmedButNotPosted: unposted,
        inFlightOverADay: stuck,
      },
      clean: unposted.length === 0 && stuck.length === 0,
    };
  });
}
