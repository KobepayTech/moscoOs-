/**
 * Sign-in, enrolment and the member register.
 */

import {
  annualFeeDue,
  feeEntry,
  formatMoney,
  holdingValue,
  incomeStatement,
  isFullyPaidMember,
  memberNetWorth,
  netAssetValuePerShare,
  ownershipRatio,
  reconcileContributions,
  requiredEntryCapital,
  requiredEntryPayment,
  savingsContributionEntry,
  shareSubscriptionEntry,
  sharesOf,
  sharesOutstandingForMembership,
  subscribe,
  summariseRegister,
  today,
  type Book,
} from '@mamogoro/core';

import { CASHIER_ROLES, REGISTRAR_ROLES, hashPassword, issueToken, verifyPassword, type Role } from '../auth.js';
import {
  audit,
  buildBook,
  buildRegister,
  loadConfig,
  memberOutstandingPrincipal,
  notify,
  post,
  recordShareMovement,
  selfCoverForMember,
  writeSnapshot,
} from '../circle.js';
import { type Db, newId, nowISO, transact } from '../db.js';
import { ApiError, type Router, dateField, enumField, moneyField, str } from '../http.js';

interface MemberRow {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  national_id: string | null;
  role: Role;
  password_hash: string;
  joined_on: string;
  status: string;
  suspended_reason: string | null;
  annual_fee_paid_on: string | null;
}

export function findMember(db: Db, memberId: string): MemberRow {
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) as unknown as
    | MemberRow
    | undefined;
  if (!row) throw ApiError.notFound(`No member with id ${memberId}`);
  return row;
}

function publicMember(row: MemberRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    role: row.role,
    joinedOn: row.joined_on,
    status: row.status,
  };
}

export function registerMemberRoutes(router: Router, db: Db): void {
  // -------------------------------------------------------------------------
  // Sign in
  // -------------------------------------------------------------------------

  router.post(
    '/auth/login',
    ({ body }) => {
      const phone = str(body, 'phone');
      const password = str(body, 'password');

      const row = db.prepare('SELECT * FROM members WHERE phone = ?').get(phone) as unknown as
        | MemberRow
        | undefined;

      // Same message either way: telling a caller that a phone number exists
      // but the password is wrong hands them half the credential.
      const invalid = ApiError.unauthorized('That phone number and password do not match');
      if (!row || !verifyPassword(password, row.password_hash)) throw invalid;

      if (row.status === 'exited') {
        throw ApiError.forbidden('This membership has been closed');
      }

      audit(db, { actorId: row.id, action: 'login' });

      return {
        token: issueToken({ sub: row.id, role: row.role, name: row.full_name }),
        member: publicMember(row),
      };
    },
    { public: true },
  );

  router.post('/auth/change-password', ({ body, principal }) => {
    const current = str(body, 'currentPassword');
    const next = str(body, 'newPassword');

    const row = findMember(db, principal!.memberId);
    if (!verifyPassword(current, row.password_hash)) {
      throw ApiError.unauthorized('Your current password is not correct');
    }

    db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(next), row.id);
    audit(db, { actorId: row.id, action: 'change_password' });
    return { ok: true };
  });

  router.get('/auth/me', ({ principal }) => {
    const config = loadConfig(db);
    const row = findMember(db, principal!.memberId);
    const register = buildRegister(db, config);
    const book = buildBook(db);

    const retained = retainedEarnings(book);
    const contributions = reconcileContributions(
      config,
      { joinedOn: row.joined_on, monthsPaid: countContributions(db, row.id) },
      today(),
    );

    return {
      member: publicMember(row),
      shares: {
        held: sharesOf(register, row.id),
        required: config.shares.minimumMembershipShares,
        outstanding: sharesOutstandingForMembership(register, config, row.id),
        parValue: config.shares.parValue,
        parValueHeld: holdingValue(register, row.id),
        netAssetValue: memberNetWorth(register, row.id, retained),
        netAssetValuePerShare: netAssetValuePerShare(register, retained),
        ownershipRatio: ownershipRatio(register, row.id),
        fullyPaid: isFullyPaidMember(register, config, row.id),
      },
      standing: {
        annualFeeDue: annualFeeDue(row.joined_on, row.annual_fee_paid_on, today()),
        contributions,
        outstandingPrincipal: memberOutstandingPrincipal(db, config, row.id),
        availableToPledge: selfCoverForMember(db, config, row.id),
        suspended: row.status === 'suspended',
        suspendedReason: row.suspended_reason,
      },
    };
  });

  // -------------------------------------------------------------------------
  // The register
  // -------------------------------------------------------------------------

  router.get('/members', () => {
    const config = loadConfig(db);
    const register = buildRegister(db, config);

    const rows = db
      .prepare('SELECT * FROM members ORDER BY full_name')
      .all() as unknown as MemberRow[];

    return {
      register: summariseRegister(register),
      members: rows.map((row) => ({
        ...publicMember(row),
        shares: sharesOf(register, row.id),
        shareValue: holdingValue(register, row.id),
        ownershipRatio: ownershipRatio(register, row.id),
        fullyPaid: isFullyPaidMember(register, config, row.id),
      })),
    };
  });

  router.get('/members/:id', ({ params }) => {
    const config = loadConfig(db);
    const row = findMember(db, params.id);
    const register = buildRegister(db, config);
    const book = buildBook(db);

    return {
      ...publicMember(row),
      shares: sharesOf(register, row.id),
      shareValue: holdingValue(register, row.id),
      netAssetValue: memberNetWorth(register, row.id, retainedEarnings(book)),
      ownershipRatio: ownershipRatio(register, row.id),
      outstandingPrincipal: memberOutstandingPrincipal(db, config, row.id),
      availableToPledge: selfCoverForMember(db, config, row.id),
      shareHistory: register.transactions.filter((tx) => tx.memberId === row.id),
      contributions: reconcileContributions(
        config,
        { joinedOn: row.joined_on, monthsPaid: countContributions(db, row.id) },
        today(),
      ),
    };
  });

  /**
   * Enrol a member and take up their founding shares in one step.
   *
   * Membership and share capital arrive together by design: a "member" who has
   * not paid for shares has no stake, cannot be diluted, and therefore cannot
   * meaningfully sponsor anyone.
   */
  router.post(
    '/members',
    ({ body, principal }) => {
      const config = loadConfig(db);

      const fullName = str(body, 'fullName', { max: 120 });
      const phone = str(body, 'phone', { max: 32 });
      const email = str(body, 'email', { optional: true, max: 160 });
      const nationalId = str(body, 'nationalId', { optional: true, max: 40 });
      const password = str(body, 'password');
      const role = enumField<Role>(body, 'role', ['member', 'cashier', 'secretary', 'chair'], 'member');
      const joinedOn = dateField(body, 'joinedOn', today());
      const sharesTaken = moneyField(body, 'shares', { optional: true }) || config.shares.minimumMembershipShares;
      const feesPaid = moneyField(body, 'feesPaid', { optional: true });

      const existing = db.prepare('SELECT id FROM members WHERE phone = ?').get(phone);
      if (existing) throw ApiError.conflict(`A member is already registered on ${phone}`);

      if (sharesTaken < config.shares.minimumMembershipShares) {
        throw ApiError.unprocessable(
          `Membership requires at least ${config.shares.minimumMembershipShares} shares ` +
            `(${formatMoney(requiredEntryCapital(config), config.currency)}); ${sharesTaken} were offered`,
        );
      }

      const expectedFees = config.membership.joiningFee + config.membership.annualFee;
      if (feesPaid > 0 && feesPaid !== expectedFees) {
        throw ApiError.unprocessable(
          `Opening fees are ${formatMoney(expectedFees, config.currency)} ` +
            `(joining ${formatMoney(config.membership.joiningFee, config.currency)} plus annual ` +
            `${formatMoney(config.membership.annualFee, config.currency)})`,
        );
      }

      return transact(db, () => {
        const id = newId('mem');
        const capital = sharesTaken * config.shares.parValue;

        db.prepare(
          `INSERT INTO members
             (id, full_name, phone, email, national_id, role, password_hash, joined_on, status,
              annual_fee_paid_on, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(
          id,
          fullName,
          phone,
          email || null,
          nationalId || null,
          role,
          hashPassword(password),
          joinedOn,
          feesPaid > 0 ? joinedOn : null,
          nowISO(),
        );

        recordShareMovement(db, {
          memberId: id,
          kind: 'subscription',
          shares: sharesTaken,
          amount: capital,
          occurredOn: joinedOn,
          narration: 'Founding subscription',
        });

        const book = buildBook(db);
        post(db, book, {
          ...shareSubscriptionEntry(
            { id: newId('je'), date: joinedOn, postedBy: principal!.memberId },
            { memberId: id, amount: capital },
          ),
        });

        if (feesPaid > 0) {
          db.prepare(
            `INSERT INTO fees (id, member_id, kind, amount, paid_on, created_at) VALUES (?, ?, 'joining', ?, ?, ?)`,
          ).run(newId('fee'), id, feesPaid, joinedOn, nowISO());

          post(db, book, {
            ...feeEntry(
              { id: newId('je'), date: joinedOn, postedBy: principal!.memberId },
              { memberId: id, amount: feesPaid, description: 'Joining fee and annual subscription' },
            ),
          });
        }

        writeSnapshot(db, config, joinedOn);
        audit(db, {
          actorId: principal!.memberId,
          action: 'member_enrolled',
          entityType: 'member',
          entityId: id,
          detail: { shares: sharesTaken, capital },
        });

        notify(db, {
          memberId: id,
          kind: 'welcome',
          title: `Welcome to ${config.circleName}`,
          body:
            `You hold ${sharesTaken} shares worth ${formatMoney(capital, config.currency)}. ` +
            `Your monthly contribution is ${formatMoney(config.membership.monthlyContribution, config.currency)}.`,
        });

        return { id, fullName, shares: sharesTaken, capital, entryPayment: requiredEntryPayment(config) };
      });
    },
    { roles: REGISTRAR_ROLES },
  );

  /** Take up further shares beyond the founding holding. */
  router.post(
    '/members/:id/shares',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const member = findMember(db, params.id);
      const shares = moneyField(body, 'shares');
      const occurredOn = dateField(body, 'paidOn', today());

      if (shares <= 0) throw ApiError.badRequest('"shares" must be greater than zero');

      // Validated through the engine so the holding ceiling and the authorised
      // capital limit are enforced by the same code the tests cover. The
      // register is a throwaway copy; only the recorded movement below is kept.
      const register = buildRegister(db, config);
      subscribe(register, config, { memberId: member.id, shares, occurredOn });

      return transact(db, () => {
        const amount = shares * config.shares.parValue;
        recordShareMovement(db, {
          memberId: member.id,
          kind: 'subscription',
          shares,
          amount,
          occurredOn,
          narration: 'Additional subscription',
        });

        const book = buildBook(db);
        post(db, book, {
          ...shareSubscriptionEntry(
            { id: newId('je'), date: occurredOn, postedBy: principal!.memberId },
            { memberId: member.id, amount },
          ),
        });

        writeSnapshot(db, config, occurredOn);
        audit(db, {
          actorId: principal!.memberId,
          action: 'shares_subscribed',
          entityType: 'member',
          entityId: member.id,
          detail: { shares, amount },
        });

        return { memberId: member.id, shares, amount };
      });
    },
    { roles: CASHIER_ROLES },
  );

  // -------------------------------------------------------------------------
  // Contributions and fees
  // -------------------------------------------------------------------------

  /**
   * Record a monthly contribution.
   *
   * Under the founding rules the contribution buys a share at par, so the
   * member's stake grows every month rather than sitting as a balance. A
   * circle that prefers a savings balance flips `monthlyContributionBuysShares`.
   */
  router.post(
    '/members/:id/contributions',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const member = findMember(db, params.id);
      const period = str(body, 'period');
      const amount = moneyField(body, 'amount');
      const paidOn = dateField(body, 'paidOn', today());
      const reference = str(body, 'reference', { optional: true });

      if (!/^\d{4}-\d{2}$/.test(period)) {
        throw ApiError.badRequest('"period" must be a month in YYYY-MM form');
      }
      if (amount !== config.membership.monthlyContribution) {
        throw ApiError.unprocessable(
          `The monthly contribution is ${formatMoney(config.membership.monthlyContribution, config.currency)}; ` +
            `${formatMoney(amount, config.currency)} was offered. Record part payments as a fee instead.`,
        );
      }

      const already = db
        .prepare('SELECT id FROM contributions WHERE member_id = ? AND period = ?')
        .get(member.id, period);
      if (already) throw ApiError.conflict(`${member.full_name} has already contributed for ${period}`);

      return transact(db, () => {
        db.prepare(
          `INSERT INTO contributions (id, member_id, period, amount, paid_on, reference, recorded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(newId('con'), member.id, period, amount, paidOn, reference || null, principal!.memberId, nowISO());

        const book = buildBook(db);

        if (config.membership.monthlyContributionBuysShares) {
          const shares = Math.floor(amount / config.shares.parValue);
          if (shares > 0) {
            recordShareMovement(db, {
              memberId: member.id,
              kind: 'monthly_contribution',
              shares,
              amount: shares * config.shares.parValue,
              occurredOn: paidOn,
              narration: `Monthly contribution for ${period}`,
            });
            post(db, book, {
              ...shareSubscriptionEntry(
                { id: newId('je'), date: paidOn, reference: reference || undefined, postedBy: principal!.memberId },
                { memberId: member.id, amount: shares * config.shares.parValue },
              ),
              narration: `Monthly contribution for ${period} — ${member.full_name}`,
            });
          }
        } else {
          post(db, book, {
            ...savingsContributionEntry(
              { id: newId('je'), date: paidOn, reference: reference || undefined, postedBy: principal!.memberId },
              { memberId: member.id, amount },
            ),
          });
        }

        writeSnapshot(db, config, paidOn);
        audit(db, {
          actorId: principal!.memberId,
          action: 'contribution_recorded',
          entityType: 'member',
          entityId: member.id,
          detail: { period, amount },
        });

        return { memberId: member.id, period, amount, paidOn };
      });
    },
    { roles: CASHIER_ROLES },
  );

  router.post(
    '/members/:id/fees',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const member = findMember(db, params.id);
      const kind = enumField(body, 'kind', ['joining', 'annual', 'penalty', 'other'] as const);
      const amount = moneyField(body, 'amount');
      const paidOn = dateField(body, 'paidOn', today());

      if (amount <= 0) throw ApiError.badRequest('"amount" must be greater than zero');

      return transact(db, () => {
        db.prepare(
          `INSERT INTO fees (id, member_id, kind, amount, paid_on, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(newId('fee'), member.id, kind, amount, paidOn, nowISO());

        if (kind === 'annual') {
          db.prepare('UPDATE members SET annual_fee_paid_on = ? WHERE id = ?').run(paidOn, member.id);
        }

        const book = buildBook(db);
        post(db, book, {
          ...feeEntry(
            { id: newId('je'), date: paidOn, postedBy: principal!.memberId },
            { memberId: member.id, amount, description: `${kind} fee` },
          ),
        });

        audit(db, {
          actorId: principal!.memberId,
          action: 'fee_recorded',
          entityType: 'member',
          entityId: member.id,
          detail: { kind, amount },
        });

        return { memberId: member.id, kind, amount, paidOn };
      });
    },
    { roles: CASHIER_ROLES },
  );

  router.get('/members/:id/contributions', ({ params }) => {
    const config = loadConfig(db);
    const member = findMember(db, params.id);

    const rows = db
      .prepare('SELECT * FROM contributions WHERE member_id = ? ORDER BY period DESC')
      .all(member.id) as unknown as { period: string; amount: number; paid_on: string; reference: string | null }[];

    return {
      memberId: member.id,
      monthly: config.membership.monthlyContribution,
      summary: reconcileContributions(
        config,
        { joinedOn: member.joined_on, monthsPaid: rows.length },
        today(),
      ),
      history: rows.map((row) => ({
        period: row.period,
        amount: row.amount,
        paidOn: row.paid_on,
        reference: row.reference,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  router.get('/notifications', ({ principal, query }) => {
    const unreadOnly = query.get('unread') === 'true';
    const rows = db
      .prepare(
        `SELECT * FROM notifications
          WHERE member_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
          ORDER BY created_at DESC LIMIT 200`,
      )
      .all(principal!.memberId) as unknown as {
      id: string;
      kind: string;
      title: string;
      body: string;
      payload: string | null;
      action_url: string | null;
      read_at: string | null;
      created_at: string;
    }[];

    return {
      unread: rows.filter((row) => !row.read_at).length,
      notifications: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        payload: row.payload ? JSON.parse(row.payload) : null,
        actionUrl: row.action_url,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
    };
  });

  router.post('/notifications/:id/read', ({ params, principal }) => {
    const result = db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND member_id = ?')
      .run(nowISO(), params.id, principal!.memberId);

    if (result.changes === 0) throw ApiError.notFound('No such notification');
    return { ok: true };
  });
}

/** How many months a member has contributed for. */
export function countContributions(db: Db, memberId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM contributions WHERE member_id = ?')
    .get(memberId) as unknown as { n: number };
  return row.n;
}

/** Surplus retained in the circle: income less expenses to date. */
export function retainedEarnings(book: Book): number {
  return incomeStatement(book).surplus;
}
