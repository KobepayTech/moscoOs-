/**
 * The internal capital exchange.
 *
 * The circle publishes what it needs; members offer portions; the offers
 * become facilities. Nothing here holds money of its own — the moment a call
 * closes, every allocation is an ordinary facility drawdown and the ledger,
 * the utilisation waterfall and the repayment queue apply to it unchanged.
 *
 * The rules that make this safe live in `exchange.ts` in the core engine, and
 * they are not negotiable at this layer: a call that fails validation is not
 * published, and there is no authorisation path past it. Those guards exist
 * because this is members' savings, and a circle owes them a standard of care
 * it does not owe an outside investor.
 */

import {
  type CapitalOffer,
  type FundingCall,
  allocateOffers,
  assessFundingNeed,
  callPosition,
  capitalPosition,
  createFacility,
  describeOffer,
  facilityDrawdownEntry,
  facilityFromAllocation,
  formatMoney,
  issuedCapital,
  today,
  validateFundingCall,
} from '@mamogoro/core';

import { CASHIER_ROLES } from '../auth.js';
import {
  audit,
  buildBook,
  buildRegister,
  capitalInputs,
  loadConfig,
  loadFacilities,
  notify,
  notifyCircle,
  post,
  writeSnapshot,
} from '../circle.js';
import { type Db, newId, nowISO, transact } from '../db.js';
import { ApiError, type Router, dateField, intField, moneyField, str } from '../http.js';
import { findMember } from './members.js';

interface CallRow {
  id: string;
  purpose: string;
  target: number;
  minimum_offer: number;
  term_months: number;
  monthly_rate: number;
  opens_on: string;
  closes_on: string;
  status: FundingCall['status'];
  opened_by: string;
  closed_on: string | null;
}

interface OfferRow {
  id: string;
  call_id: string;
  member_id: string;
  amount: number;
  offered_on: string;
  status: CapitalOffer['status'];
  allocated: number | null;
  facility_id: string | null;
}

function toCall(row: CallRow): FundingCall {
  return {
    id: row.id,
    purpose: row.purpose,
    target: row.target,
    minimumOffer: row.minimum_offer,
    termMonths: row.term_months,
    monthlyRate: row.monthly_rate,
    opensOn: row.opens_on,
    closesOn: row.closes_on,
    status: row.status,
  };
}

function toOffer(row: OfferRow): CapitalOffer {
  return {
    id: row.id,
    callId: row.call_id,
    memberId: row.member_id,
    amount: row.amount,
    offeredOn: row.offered_on,
    status: row.status,
  };
}

function loadCall(db: Db, id: string): CallRow {
  const row = db.prepare('SELECT * FROM funding_calls WHERE id = ?').get(id) as unknown as
    | CallRow
    | undefined;
  if (!row) throw ApiError.notFound(`No funding call with id ${id}`);
  return row;
}

function loadOffers(db: Db, callId: string): OfferRow[] {
  return db
    .prepare('SELECT * FROM capital_offers WHERE call_id = ? ORDER BY offered_on, rowid')
    .all(callId) as unknown as OfferRow[];
}

export function registerExchangeRoutes(router: Router, db: Db): void {
  /**
   * Whether the circle should be raising, and on what terms.
   *
   * Read before drafting a call, and open to everyone: a member being asked to
   * lend the circle money is entitled to see the same figure the committee saw
   * when it decided to ask.
   */
  router.get('/exchange/need', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const position = capitalPosition(config, capitalInputs(db, config, asOf), {
      formatAmount: (amount) => formatMoney(amount, config.currency),
    });

    const termMonths = config.termLoan.defaultTermMonths + config.exchange.maturityBufferMonths;
    const windowDays = termMonths * 30;

    // Only the dependable part: money owed by members already behind is not
    // something to decide against raising on.
    const inflow = position.inflows
      .filter((entry) => entry.windowDays <= windowDays)
      .reduce((total, entry) => Math.max(total, entry.dependable), 0);

    const need = assessFundingNeed(config, {
      committedLending: position.committed.amount,
      spendableNow: position.capital.spendableNow,
      expectedInflow: inflow,
    });

    return {
      asOf,
      ...need,
      enabled: config.exchange.enabled,
      context: {
        approvedAwaitingCash: position.committed.amount,
        spendableNow: position.capital.spendableNow,
        dependableInflow: inflow,
      },
    };
  });

  router.get('/exchange/calls', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();

    const rows = db
      .prepare('SELECT * FROM funding_calls ORDER BY created_at DESC')
      .all() as unknown as CallRow[];

    return {
      calls: rows.map((row) => {
        const call = toCall(row);
        return callPosition(config, call, loadOffers(db, row.id).map(toOffer), asOf);
      }),
    };
  });

  router.get('/exchange/calls/:id', ({ params, query, principal }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const call = toCall(loadCall(db, params.id));
    const offers = loadOffers(db, params.id);

    const mine = offers.find(
      (offer) =>
        offer.member_id === principal!.memberId &&
        ['offered', 'accepted', 'scaled'].includes(offer.status),
    );

    return {
      ...callPosition(config, call, offers.map(toOffer), asOf),
      // Every member can see who is funding the circle. Who lends it money is
      // not a private matter between one member and the committee.
      offers: offers.map((offer) => ({
        id: offer.id,
        memberId: offer.member_id,
        memberName: findMember(db, offer.member_id).full_name,
        amount: offer.amount,
        offeredOn: offer.offered_on,
        status: offer.status,
        allocated: offer.allocated,
      })),
      yourOffer: mine ? toOffer(mine) : null,
    };
  });

  /**
   * Publish a call.
   *
   * Every guard runs here, because published is the point of no return:
   * members will have committed money by the time anybody re-reads the terms.
   */
  router.post(
    '/exchange/calls',
    ({ body, principal }) => {
      const config = loadConfig(db);

      if (!config.exchange.enabled) {
        throw ApiError.unprocessable('This circle has not opened the capital exchange');
      }

      const purpose = str(body, 'purpose', { max: 300 });
      const target = moneyField(body, 'target');
      const minimumOffer = moneyField(body, 'minimumOffer', { optional: true }) || 1_000_000;
      const termMonths = intField(body, 'termMonths', { min: 1, max: 60 });
      const opensOn = dateField(body, 'opensOn', today());
      const closesOn = dateField(body, 'closesOn');

      const rateField = (body as Record<string, unknown>).monthlyRate;
      if (typeof rateField !== 'number') {
        throw ApiError.badRequest('"monthlyRate" is required: members must be told what they will earn');
      }

      const register = buildRegister(db, config);
      const facilities = loadFacilities(db);

      const problems = validateFundingCall(
        config,
        { target, minimumOffer, termMonths, monthlyRate: rateField, opensOn, closesOn },
        {
          existingFacilityPrincipal: facilities
            .filter((facility) => facility.status === 'active')
            .reduce((total, facility) => total + facility.principal - facility.repaidPrincipal, 0),
          equityCapital: issuedCapital(register),
        },
      );

      if (problems.length > 0) {
        throw ApiError.unprocessable('This call cannot be published as it stands', problems);
      }

      return transact(db, () => {
        const id = newId('call');

        db.prepare(
          `INSERT INTO funding_calls
             (id, purpose, target, minimum_offer, term_months, monthly_rate, opens_on, closes_on,
              status, opened_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(
          id,
          purpose,
          target,
          minimumOffer,
          termMonths,
          rateField,
          opensOn,
          closesOn,
          principal!.memberId,
          nowISO(),
        );

        const quote = describeOffer(config, toCall(loadCall(db, id)), minimumOffer);

        notifyCircle(db, {
          kind: 'funding_call',
          title: `The circle is seeking ${formatMoney(target, config.currency)}`,
          body:
            `${purpose}. ${termMonths} months at ${(rateField * 100).toFixed(2)}% a month, minimum ` +
            `${formatMoney(minimumOffer, config.currency)}. Offers close ${closesOn}. ${quote.note}`,
          actionUrl: `/exchange/calls/${id}`,
        });

        audit(db, {
          actorId: principal!.memberId,
          action: 'funding_call_opened',
          entityType: 'funding_call',
          entityId: id,
          detail: { target, termMonths, monthlyRate: rateField },
        });

        return callPosition(config, toCall(loadCall(db, id)), [], today());
      });
    },
    { roles: CASHIER_ROLES },
  );

  /**
   * Offer capital.
   *
   * Any member may, which is the point — this is the circle borrowing from
   * itself rather than from whoever the committee happens to know.
   */
  router.post('/exchange/calls/:id/offers', ({ params, body, principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const row = loadCall(db, params.id);
    const call = toCall(row);
    const amount = moneyField(body, 'amount');

    const position = callPosition(config, call, loadOffers(db, call.id).map(toOffer), asOf);
    if (!position.open) {
      throw ApiError.conflict(
        row.status === 'open'
          ? `This call is open from ${call.opensOn} to ${call.closesOn}`
          : `This call is ${row.status}`,
      );
    }

    if (amount < call.minimumOffer) {
      throw ApiError.unprocessable(
        `The smallest offer on this call is ${formatMoney(call.minimumOffer, config.currency)}`,
      );
    }

    const member = findMember(db, principal!.memberId);
    if (member.status !== 'active') {
      throw ApiError.forbidden('Only an active member may lend the circle capital');
    }

    return transact(db, () => {
      // One live offer per member per call. Changing your mind is a withdrawal
      // and a fresh offer, so the register never holds two numbers for one
      // person and has to guess which they meant.
      db.prepare(
        `UPDATE capital_offers SET status = 'withdrawn'
          WHERE call_id = ? AND member_id = ? AND status IN ('offered','accepted','scaled')`,
      ).run(call.id, principal!.memberId);

      const id = newId('off');
      db.prepare(
        `INSERT INTO capital_offers (id, call_id, member_id, amount, offered_on, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'offered', ?)`,
      ).run(id, call.id, principal!.memberId, amount, asOf, nowISO());

      audit(db, {
        actorId: principal!.memberId,
        action: 'capital_offered',
        entityType: 'funding_call',
        entityId: call.id,
        detail: { offerId: id, amount },
      });

      const after = callPosition(config, call, loadOffers(db, call.id).map(toOffer), asOf);

      const quote = describeOffer(config, call, amount);

      return {
        offerId: id,
        amount,
        bestCase: quote.bestCase,
        note: quote.note,
        // Kept separate from the explanation above: one is how a facility
        // earns, the other is what may happen to this particular offer.
        warning:
          after.oversubscribedBy > 0
            ? 'This call is oversubscribed. Offers are scaled back pro rata when it closes, so you may be ' +
              'taken up on less than you offered.'
            : undefined,
        call: after,
      };
    });
  });

  router.post('/exchange/offers/:id/withdraw', ({ params, principal }) => {
    const offer = db.prepare('SELECT * FROM capital_offers WHERE id = ?').get(params.id) as unknown as
      | OfferRow
      | undefined;

    if (!offer) throw ApiError.notFound('No such offer');
    if (offer.member_id !== principal!.memberId) {
      throw ApiError.forbidden('Only the member who made an offer can withdraw it');
    }
    if (offer.status === 'accepted' || offer.status === 'scaled') {
      throw ApiError.conflict(
        'This offer has already been taken up and is now a facility. Ask for the capital back under ' +
          'its own terms instead.',
      );
    }
    if (offer.status !== 'offered') throw ApiError.conflict(`This offer is ${offer.status}`);

    db.prepare("UPDATE capital_offers SET status = 'withdrawn' WHERE id = ?").run(offer.id);

    audit(db, {
      actorId: principal!.memberId,
      action: 'capital_offer_withdrawn',
      entityType: 'funding_call',
      entityId: offer.call_id,
      detail: { offerId: offer.id },
    });

    return { withdrawn: true };
  });

  /**
   * Close a call and turn the allocations into facilities.
   *
   * The one place money actually moves. Each allocation becomes a drawdown
   * posted to the ledger exactly as a privately negotiated facility would be,
   * because that is what it is.
   */
  router.post(
    '/exchange/calls/:id/close',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const asOf = dateField(body, 'fundedOn', today());
      const row = loadCall(db, params.id);

      if (row.status !== 'open') throw ApiError.conflict(`This call is already ${row.status}`);

      const call = toCall(row);
      const offers = loadOffers(db, call.id);
      const allocations = allocateOffers(config, call, offers.map(toOffer));

      return transact(db, () => {
        const created: { offerId: string; memberId: string; facilityId: string; principal: number }[] = [];

        for (const allocation of allocations) {
          if (allocation.allocated <= 0) {
            db.prepare("UPDATE capital_offers SET status = 'declined', allocated = 0 WHERE id = ?").run(
              allocation.offerId,
            );
            continue;
          }

          const terms = facilityFromAllocation(call, allocation, asOf);
          const facility = createFacility(config, {
            id: newId('fac'),
            investorMemberId: terms.investorMemberId,
            principal: terms.principal,
            fundedOn: terms.fundedOn,
            monthlyRate: terms.monthlyRate,
            committedUntil: terms.committedUntil,
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
            `Capital exchange: ${call.purpose}`,
            nowISO(),
          );

          const book = buildBook(db);
          post(db, book, {
            ...facilityDrawdownEntry(
              { id: newId('je'), date: asOf, postedBy: principal!.memberId },
              {
                facilityId: facility.id,
                investorMemberId: facility.investorMemberId,
                amount: facility.principal,
              },
            ),
          });

          db.prepare(
            `UPDATE capital_offers SET status = ?, allocated = ?, facility_id = ? WHERE id = ?`,
          ).run(
            allocation.scaledBackBy > 0 ? 'scaled' : 'accepted',
            allocation.allocated,
            facility.id,
            allocation.offerId,
          );

          notify(db, {
            memberId: allocation.memberId,
            kind: 'capital_accepted',
            title:
              allocation.scaledBackBy > 0
                ? `${formatMoney(allocation.allocated, config.currency)} of your offer was taken up`
                : `Your ${formatMoney(allocation.allocated, config.currency)} has been taken up`,
            body:
              `${allocation.reason}. You earn ${(call.monthlyRate * 100).toFixed(2)}% a month on whatever ` +
              `part of it the circle actually lends out, and nothing on the part that sits idle. ` +
              `You may call it back from ${facility.committedUntil}.`,
            payload: { facilityId: facility.id, callId: call.id },
            actionUrl: '/facilities',
          });

          created.push({
            offerId: allocation.offerId,
            memberId: allocation.memberId,
            facilityId: facility.id,
            principal: facility.principal,
          });
        }

        const raised = created.reduce((total, entry) => total + entry.principal, 0);

        db.prepare("UPDATE funding_calls SET status = ?, closed_on = ? WHERE id = ?").run(
          raised >= call.target ? 'filled' : 'closed',
          asOf,
          call.id,
        );

        writeSnapshot(db, config, asOf);

        notifyCircle(db, {
          kind: 'funding_call',
          title: `The call for ${formatMoney(call.target, config.currency)} has closed`,
          body:
            `${formatMoney(raised, config.currency)} was raised from ${created.length} member(s) ` +
            `for ${call.termMonths} months. It is external capital, not share capital: nobody's ` +
            'shareholding has changed.',
          actionUrl: '/facilities',
        });

        audit(db, {
          actorId: principal!.memberId,
          action: 'funding_call_closed',
          entityType: 'funding_call',
          entityId: call.id,
          detail: { raised, target: call.target, facilities: created.length },
        });

        return {
          callId: call.id,
          raised,
          target: call.target,
          status: raised >= call.target ? 'filled' : 'closed',
          allocations,
          facilities: created,
        };
      });
    },
    { roles: CASHIER_ROLES },
  );

  router.post(
    '/exchange/calls/:id/cancel',
    ({ params, principal }) => {
      const row = loadCall(db, params.id);
      if (row.status !== 'open' && row.status !== 'draft') {
        throw ApiError.conflict(`This call is ${row.status} and cannot be cancelled`);
      }

      return transact(db, () => {
        db.prepare("UPDATE funding_calls SET status = 'cancelled', closed_on = ? WHERE id = ?").run(
          today(),
          row.id,
        );
        // Nobody's money was ever taken, so every offer simply lapses.
        db.prepare(
          "UPDATE capital_offers SET status = 'declined' WHERE call_id = ? AND status = 'offered'",
        ).run(row.id);

        audit(db, {
          actorId: principal!.memberId,
          action: 'funding_call_cancelled',
          entityType: 'funding_call',
          entityId: row.id,
        });

        return { cancelled: true };
      });
    },
    { roles: CASHIER_ROLES },
  );
}
