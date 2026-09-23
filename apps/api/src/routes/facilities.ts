/**
 * External capital.
 *
 * A member may put money into the circle two ways, and the difference matters
 * enough that the API keeps them apart:
 *
 *   - buy shares, and own more of the circle (see `/members/:id/shares`);
 *   - advance a *facility*, and be repaid with a return (here).
 *
 * A facility is a loan to the circle. It does not dilute anyone and it carries
 * no vote. What it earns depends entirely on how much of it the circle
 * actually lent out — see `facility.ts` in the core engine for the waterfall.
 */

import {
  accrueFacilityInterest,
  createFacility,
  facilityAccrualEntry,
  facilityDrawdownEntry,
  facilityPaymentEntry,
  facilityOutstanding,
  facilityStatement,
  formatMoney,
  issuedCapital,
  lendingHeadroom,
  monthKey,
  repaymentQueue,
  splitUtilisation,
  today,
} from '@mamogoro/core';

import { CASHIER_ROLES } from '../auth.js';
import {
  audit,
  buildBook,
  buildRegister,
  loadConfig,
  loadFacilities,
  loadSnapshots,
  notify,
  post,
  totalDeployed,
  writeSnapshot,
} from '../circle.js';
import { type Db, newId, nowISO, transact } from '../db.js';
import { ApiError, type Router, dateField, intField, moneyField, str } from '../http.js';
import { findMember } from './members.js';

export function registerFacilityRoutes(router: Router, db: Db): void {
  /**
   * The utilisation report — the heart of the investor relationship.
   *
   * Shows, for the period, how much of each facility was actually working and
   * what that earned. An investor whose money sat idle sees zero here, and
   * sees *why*.
   */
  /** The note recorded when the facility was created, if any. */
  function noteFor(database: Db, facilityId: string): string | null {
    const row = database.prepare('SELECT note FROM facilities WHERE id = ?').get(facilityId) as unknown as
      | { note: string | null }
      | undefined;
    return row?.note ?? null;
  }

  router.get('/facilities', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const from = query.get('from') ?? earliestSnapshot(db) ?? asOf;

    const facilities = loadFacilities(db);
    const snapshots = loadSnapshots(db);
    const register = buildRegister(db, config, asOf);
    const equityPool = issuedCapital(register);
    const deployed = totalDeployed(db, asOf);

    const accrual = accrueFacilityInterest(facilities, snapshots, {
      from,
      to: asOf,
      accrualBasisDays: config.facility.accrualBasisDays,
      allocation: config.facility.allocation,
    });

    const split = splitUtilisation(equityPool, deployed, facilities, asOf, config.facility.allocation);

    return {
      asOf,
      period: { from, to: asOf },
      capital: {
        equityPool,
        facilityCommitted: facilities.reduce((total, f) => total + facilityOutstanding(f), 0),
        deployed,
        headroom: lendingHeadroom(config, equityPool, deployed, facilities, asOf),
      },
      today: {
        equityUtilised: split.equityUtilised,
        facilityUtilised: split.facilityUtilisedTotal,
        facilityIdle: split.facilityIdle,
        utilisationRatio: split.utilisationRatio,
        perFacility: split.perFacility,
      },
      facilities: facilities.map((facility) => {
        const facilityAccrual = accrual.perFacility.find((row) => row.facilityId === facility.id)!;
        const statement = facilityStatement(facility, facilityAccrual, {
          asOf,
          noticeDays: config.facility.withdrawalNoticeDays,
        });
        return {
          ...facility,
          investorName: findMember(db, facility.investorMemberId).full_name,
          // Where this capital came from — a private arrangement or a
          // published call. Provenance a member is entitled to see.
          note: noteFor(db, facility.id),
          utilisedNow: split.perFacility.get(facility.id) ?? 0,
          accrual: facilityAccrual,
          totalDue: statement.totalDue,
          withdrawable: statement.withdrawable,
          earliestWithdrawalOn: statement.earliestWithdrawalOn,
          explanation: explainFacility(config, facility, facilityAccrual, split.perFacility.get(facility.id) ?? 0),
        };
      }),
      totals: {
        interestAccrued: accrual.totalInterestAccrued,
        averageDeployed: accrual.averageDeployed,
        averageEquityUtilised: accrual.averageEquityUtilised,
      },
    };
  });

  /** Accept external capital from a member. */
  router.post(
    '/facilities',
    ({ body, principal }) => {
      const config = loadConfig(db);
      const investorMemberId = str(body, 'investorMemberId');
      const amount = moneyField(body, 'principal');
      const fundedOn = dateField(body, 'fundedOn', today());
      const seniority = intField(body, 'seniority', { fallback: 0, min: 0 });
      const note = str(body, 'note', { optional: true, max: 400 });

      const investor = findMember(db, investorMemberId);
      if (investor.status !== 'active') {
        throw ApiError.unprocessable('External capital may only be advanced by an active member of the circle');
      }
      if (amount <= 0) throw ApiError.badRequest('"principal" must be greater than zero');

      const rate = typeof (body as Record<string, unknown>).monthlyRate === 'number'
        ? ((body as Record<string, number>).monthlyRate)
        : config.facility.investorMonthlyRate;

      if (rate >= config.termLoan.monthlyInterestRate) {
        throw ApiError.unprocessable(
          `A facility rate of ${(rate * 100).toFixed(2)}% a month is at or above the circle's lending rate of ` +
            `${(config.termLoan.monthlyInterestRate * 100).toFixed(2)}%. Every loan funded from it would lose money.`,
        );
      }

      return transact(db, () => {
        const facility = createFacility(config, {
          id: newId('fac'),
          investorMemberId,
          principal: amount,
          fundedOn,
          monthlyRate: rate,
          seniority,
        });

        db.prepare(
          `INSERT INTO facilities
             (id, investor_member_id, principal, monthly_rate, seniority, funded_on, committed_until,
              repaid_principal, paid_interest, status, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?)`,
        ).run(
          facility.id,
          facility.investorMemberId,
          facility.principal,
          facility.monthlyRate,
          facility.seniority,
          facility.fundedOn,
          facility.committedUntil,
          note || null,
          nowISO(),
        );

        const book = buildBook(db);
        post(db, book, {
          ...facilityDrawdownEntry(
            { id: newId('je'), date: fundedOn, postedBy: principal!.memberId },
            { facilityId: facility.id, investorMemberId, amount },
          ),
        });

        writeSnapshot(db, config, fundedOn);

        notify(db, {
          memberId: investorMemberId,
          kind: 'facility_received',
          title: `Your ${formatMoney(amount, config.currency)} has been received`,
          body:
            `This is external capital, not share capital: it does not change your shareholding. You earn ` +
            `${(facility.monthlyRate * 100).toFixed(2)}% a month on whatever part of it the circle actually ` +
            `lends out, and nothing on the part that sits idle. You may call it back from ` +
            `${facility.committedUntil}.`,
          payload: { facilityId: facility.id },
          actionUrl: '/facilities',
        });

        audit(db, {
          actorId: principal!.memberId,
          action: 'facility_created',
          entityType: 'facility',
          entityId: facility.id,
          detail: { investorMemberId, amount, rate },
        });

        return facility;
      });
    },
    { roles: CASHIER_ROLES },
  );

  /**
   * Book the return earned on external capital for a period.
   *
   * Recognising the expense as it is earned, rather than when it is paid,
   * keeps the circle's monthly surplus honest: the investor's claim exists
   * whether or not there is cash to settle it yet.
   */
  router.post(
    '/facilities/accrue',
    ({ body, principal }) => {
      const config = loadConfig(db);
      const from = dateField(body, 'from');
      const to = dateField(body, 'to');

      const facilities = loadFacilities(db);
      if (facilities.length === 0) throw ApiError.conflict('There are no facilities to accrue against');

      const accrual = accrueFacilityInterest(facilities, loadSnapshots(db), {
        from,
        to,
        accrualBasisDays: config.facility.accrualBasisDays,
        allocation: config.facility.allocation,
      });

      return transact(db, () => {
        const book = buildBook(db);
        const posted: unknown[] = [];

        for (const row of accrual.perFacility) {
          if (row.interestAccrued <= 0) continue;

          post(db, book, {
            ...facilityAccrualEntry(
              { id: newId('je'), date: to, postedBy: principal!.memberId },
              {
                facilityId: row.facilityId,
                investorMemberId: row.investorMemberId,
                amount: row.interestAccrued,
                period: `${from} to ${to}`,
              },
            ),
          });

          notify(db, {
            memberId: row.investorMemberId,
            kind: 'facility_accrual',
            title: `${formatMoney(row.interestAccrued, config.currency)} earned on your capital`,
            body:
              `Between ${from} and ${to} an average of ${formatMoney(row.averageUtilised, config.currency)} of ` +
              `your ${formatMoney(row.principal, config.currency)} was out on loan ` +
              `(${(row.utilisationRatio * 100).toFixed(1)}% of it), earning ` +
              `${formatMoney(row.interestAccrued, config.currency)}.`,
            payload: { facilityId: row.facilityId },
            actionUrl: '/facilities',
          });

          posted.push({
            facilityId: row.facilityId,
            amount: row.interestAccrued,
            averageUtilised: row.averageUtilised,
          });
        }

        audit(db, {
          actorId: principal!.memberId,
          action: 'facility_accrued',
          detail: { from, to, total: accrual.totalInterestAccrued },
        });

        return { period: { from, to }, posted, total: accrual.totalInterestAccrued, accrual };
      });
    },
    { roles: CASHIER_ROLES },
  );

  /** Pay an investor: earned return first, then capital. */
  router.post(
    '/facilities/:id/payments',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const interest = moneyField(body, 'interest', { optional: true });
      const principalPaid = moneyField(body, 'principal', { optional: true });
      const paidOn = dateField(body, 'paidOn', today());

      if (interest + principalPaid <= 0) throw ApiError.badRequest('Nothing to pay');

      const facility = loadFacilities(db).find((row) => row.id === params.id);
      if (!facility) throw ApiError.notFound(`No facility with id ${params.id}`);

      if (principalPaid > facilityOutstanding(facility)) {
        throw ApiError.unprocessable(
          `That facility has ${formatMoney(facilityOutstanding(facility), config.currency)} of capital ` +
            `outstanding; ${formatMoney(principalPaid, config.currency)} was offered`,
        );
      }

      if (principalPaid > 0 && facility.committedUntil && paidOn < facility.committedUntil) {
        throw ApiError.unprocessable(
          `This facility is committed until ${facility.committedUntil}. Capital cannot be returned before then ` +
            'without a resolution of the circle.',
        );
      }

      return transact(db, () => {
        const book = buildBook(db);
        post(db, book, {
          ...facilityPaymentEntry(
            { id: newId('je'), date: paidOn, postedBy: principal!.memberId },
            {
              facilityId: facility.id,
              investorMemberId: facility.investorMemberId,
              interest,
              principal: principalPaid,
            },
          ),
        });

        const repaidAfter = facility.repaidPrincipal + principalPaid;
        db.prepare(
          `UPDATE facilities SET repaid_principal = ?, paid_interest = ?, status = ? WHERE id = ?`,
        ).run(
          repaidAfter,
          facility.paidInterest + interest,
          repaidAfter >= facility.principal ? 'repaid' : 'active',
          facility.id,
        );

        writeSnapshot(db, config, paidOn);

        notify(db, {
          memberId: facility.investorMemberId,
          kind: 'facility_payment',
          title: `${formatMoney(interest + principalPaid, config.currency)} paid to you`,
          body:
            `${formatMoney(interest, config.currency)} of earned return and ` +
            `${formatMoney(principalPaid, config.currency)} of capital, paid on ${paidOn}.`,
          payload: { facilityId: facility.id },
        });

        audit(db, {
          actorId: principal!.memberId,
          action: 'facility_paid',
          entityType: 'facility',
          entityId: facility.id,
          detail: { interest, principal: principalPaid, paidOn },
        });

        return { facilityId: facility.id, interest, principal: principalPaid, paidOn };
      });
    },
    { roles: CASHIER_ROLES },
  );

  /** Order in which facilities would be repaid if capital were returned. */
  router.get('/facilities/repayment-queue', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const from = query.get('from') ?? earliestSnapshot(db) ?? asOf;

    const facilities = loadFacilities(db);
    const accrual = accrueFacilityInterest(facilities, loadSnapshots(db), {
      from,
      to: asOf,
      accrualBasisDays: config.facility.accrualBasisDays,
      allocation: config.facility.allocation,
    });

    return {
      asOf,
      queue: repaymentQueue(facilities, accrual.perFacility).map((row) => ({
        ...row,
        investorName: findMember(db, row.investorMemberId).full_name,
      })),
    };
  });
}

function earliestSnapshot(db: Db): string | null {
  const row = db.prepare('SELECT MIN(snapshot_date) AS d FROM book_snapshots').get() as unknown as
    | { d: string | null }
    | undefined;
  return row?.d ?? null;
}

/** Plain-language account of why a facility earned what it earned. */
function explainFacility(
  config: ReturnType<typeof loadConfig>,
  facility: ReturnType<typeof loadFacilities>[number],
  accrual: { averageUtilised: number; interestAccrued: number; utilisationRatio: number },
  utilisedNow: number,
): string {
  const money = (amount: number) => formatMoney(amount, config.currency);

  if (accrual.averageUtilised === 0 && utilisedNow === 0) {
    return (
      `None of your ${money(facility.principal)} has been lent out yet, so it has earned nothing. The circle ` +
      'lends its own share capital first; your capital starts earning once lending goes beyond that.'
    );
  }

  return (
    `An average of ${money(accrual.averageUtilised)} of your ${money(facility.principal)} has been out on loan ` +
    `(${(accrual.utilisationRatio * 100).toFixed(1)}% of it), earning ${money(accrual.interestAccrued)}. ` +
    `Right now ${money(utilisedNow)} is working.`
  );
}
