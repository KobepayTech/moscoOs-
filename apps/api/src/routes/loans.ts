/**
 * Lending: apply, get sponsored, get disbursed, repay.
 *
 * The flow a member walks through:
 *
 *   1. `POST /loans/quote`   — see the schedule before committing to anything
 *   2. `POST /loans`         — apply; eligibility is checked here, once
 *   3. `POST /loans/:id/sponsors` — ask members to stand behind it
 *   4. sponsors accept       — and the moment cover is complete the loan
 *                              approves itself and lands in the cashier's queue
 *   5. `POST /loans/:id/disburse` — the cashier records the money going out
 *   6. `POST /loans/:id/repayments` — instalments come back in
 *
 * Nobody approves a loan by judgement. Approval is what *happens* when enough
 * members have put their own shares behind it, which is the circle's whole
 * theory of credit expressed as a state transition.
 */

import {
  addDays,
  applyRepayments,
  assessEligibility,
  buildShortTermLoan,
  buildTermLoanSchedule,
  coverageStatus,
  disbursementEntry,
  defaultWriteOffEntry,
  evaluateApproval,
  expirePledges,
  formatMoney,
  pledgeableCapacity,
  repaymentEntry,
  runDefaultCascade,
  settlementQuote,
  sharesOf,
  suggestSponsors,
  today,
  totalPledgedOut,
  validatePledge,
  type MemberStanding,
} from '@mamogoro/core';

import { CASHIER_ROLES } from '../auth.js';
import {
  audit,
  buildBook,
  buildRegister,
  exposureOf,
  headroom,
  loadConfig,
  loadLoan,
  loadPledges,
  loadPledgesBySponsor,
  loadRepayments,
  loanPosition,
  memberOutstandingPrincipal,
  notify,
  notifyCircle,
  post,
  recordShareMovement,
  scheduleFor,
  selfCoverForMember,
  shortTermFor,
  sponsorshipRequestFor,
  writeSnapshot,
  type LoanRow,
} from '../circle.js';
import { type Db, newId, nowISO, transact } from '../db.js';
import { ApiError, type Router, arrayField, dateField, enumField, intField, moneyField, str } from '../http.js';
import { countContributions, findMember } from './members.js';

/** Assemble the standing the eligibility engine needs. */
function standingOf(db: Db, config: ReturnType<typeof loadConfig>, memberId: string, asOf: string): MemberStanding {
  const member = findMember(db, memberId);

  const loans = db
    .prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('disbursed','defaulted')")
    .all(memberId) as unknown as LoanRow[];

  let loansInArrears = 0;
  let activeTermLoans = 0;
  let activeShortTermLoans = 0;

  for (const loan of loans) {
    const position = loanPosition(db, config, loan, asOf);
    if (position.product === 'term') {
      activeTermLoans += 1;
      if (position.state.status === 'in_arrears' || position.state.status === 'defaulted') loansInArrears += 1;
    } else {
      activeShortTermLoans += 1;
      if (position.state.status === 'overdue') loansInArrears += 1;
    }
  }

  const lastShortTerm = db
    .prepare(
      `SELECT settled_on FROM loans
        WHERE member_id = ? AND product = 'short_term' AND status = 'settled' AND settled_on IS NOT NULL
        ORDER BY settled_on DESC LIMIT 1`,
    )
    .get(memberId) as unknown as { settled_on: string } | undefined;

  const contributionsPaid = countContributions(db, memberId);
  const monthsSinceJoining = Math.max(
    0,
    (new Date(`${asOf}T00:00:00Z`).getUTCFullYear() - new Date(`${member.joined_on}T00:00:00Z`).getUTCFullYear()) *
      12 +
      (new Date(`${asOf}T00:00:00Z`).getUTCMonth() - new Date(`${member.joined_on}T00:00:00Z`).getUTCMonth()),
  );

  return {
    memberId,
    joinedOn: member.joined_on,
    missedContributions: Math.max(0, monthsSinceJoining - contributionsPaid),
    annualFeePaid: member.annual_fee_paid_on !== null,
    outstandingPrincipal: memberOutstandingPrincipal(db, config, memberId, asOf),
    loansInArrears,
    activeTermLoans,
    activeShortTermLoans,
    lastShortTermSettledOn: lastShortTerm?.settled_on ?? null,
    pledgedOut: totalPledgedOut(loadPledgesBySponsor(db, memberId), memberId),
    suspended: member.status === 'suspended',
  };
}

function loanSummary(db: Db, config: ReturnType<typeof loadConfig>, loan: LoanRow, asOf: string) {
  const borrower = findMember(db, loan.member_id);
  const base = {
    id: loan.id,
    memberId: loan.member_id,
    memberName: borrower.full_name,
    product: loan.product,
    principal: loan.principal,
    purpose: loan.purpose,
    status: loan.status,
    appliedOn: loan.applied_on,
    approvedOn: loan.approved_on,
    disbursedOn: loan.disbursed_on,
    maturityOn: loan.maturity_on,
    settledOn: loan.settled_on,
  };

  if (loan.status === 'draft' || loan.status === 'awaiting_sponsors' || loan.status === 'approved') {
    const request = sponsorshipRequestFor(db, loan);
    return {
      ...base,
      coverage: coverageStatus(request, {
        selfCover: selfCoverForMember(db, config, loan.member_id, asOf),
        asOf,
      }),
    };
  }

  if (loan.status === 'declined' || loan.status === 'cancelled') {
    return { ...base, declineReason: loan.decline_reason };
  }

  const position = loanPosition(db, config, loan, asOf);
  return position.product === 'term'
    ? { ...base, schedule: position.schedule, state: position.state }
    : { ...base, loan: position.loan, state: position.state };
}

export function registerLoanRoutes(router: Router, db: Db): void {
  // -------------------------------------------------------------------------
  // Quote — what would this cost me?
  // -------------------------------------------------------------------------

  /**
   * Price a loan without applying for one.
   *
   * A borrower should be able to see the exact instalment and the exact
   * balloon before they ask anybody to sponsor them.
   */
  router.post('/loans/quote', ({ body, principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const product = enumField(body, 'product', ['term', 'short_term'] as const, 'term');
    const amount = moneyField(body, 'principal');

    if (amount <= 0) throw ApiError.badRequest('"principal" must be greater than zero');

    const space = headroom(db, config, asOf);
    const standing = standingOf(db, config, principal!.memberId, asOf);
    const register = buildRegister(db, config, asOf);

    const eligibility = assessEligibility(config, register, standing, space, {
      product,
      asOf,
      requestedPrincipal: amount,
    });

    if (product === 'short_term') {
      const days = intField(body, 'days', { fallback: config.shortTermLoan.maxDays, min: 1 });
      if (days > config.shortTermLoan.maxDays) {
        throw ApiError.unprocessable(
          `Short-term loans run at most ${config.shortTermLoan.maxDays} days; ${days} were asked for`,
        );
      }

      const loan = buildShortTermLoan({
        principal: amount,
        flatRate: config.shortTermLoan.flatRate,
        days,
        disbursedOn: asOf,
        mode: config.shortTermLoan.interestMode,
        minimumFee: config.shortTermLoan.minimumFee,
      });

      return {
        product,
        quote: loan,
        eligibility,
        coverageRequired: Math.round(amount * config.shortTermLoan.requiredSponsorCoverage),
        selfCover: selfCoverForMember(db, config, principal!.memberId, asOf),
        explanation:
          `You would repay ${formatMoney(loan.totalRepayable, config.currency)} on ${loan.dueOn}: ` +
          `${formatMoney(amount, config.currency)} plus a flat charge of ${formatMoney(loan.fee, config.currency)}.`,
      };
    }

    const termMonths = intField(body, 'termMonths', {
      fallback: config.termLoan.defaultTermMonths,
      min: config.termLoan.minTermMonths,
      max: config.termLoan.maxTermMonths,
    });

    const schedule = buildTermLoanSchedule({
      principal: amount,
      monthlyInterestRate: config.termLoan.monthlyInterestRate,
      termMonths,
      minimumMonthlyPrincipalRate: config.termLoan.minimumMonthlyPrincipalRate,
      disbursedOn: asOf,
      balloonGraceDays: config.termLoan.balloonGraceDays,
    });

    return {
      product,
      quote: schedule,
      eligibility,
      coverageRequired: Math.round(amount * config.sponsorship.coverageRatio),
      selfCover: selfCoverForMember(db, config, principal!.memberId, asOf),
      explanation:
        `You would pay ${formatMoney(schedule.levelServiceInstalment, config.currency)} a month for ` +
        `${termMonths} months, then a final flat payment of ${formatMoney(schedule.balloon, config.currency)} ` +
        `on ${schedule.maturityOn} with no interest on it. Total cost of the loan: ` +
        `${formatMoney(schedule.scheduledInterest, config.currency)}.`,
    };
  });

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  router.post('/loans', ({ body, principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const product = enumField(body, 'product', ['term', 'short_term'] as const, 'term');
    const amount = moneyField(body, 'principal');
    const purpose = str(body, 'purpose', { optional: true, max: 400 });

    if (amount <= 0) throw ApiError.badRequest('"principal" must be greater than zero');

    const space = headroom(db, config, asOf);
    const standing = standingOf(db, config, principal!.memberId, asOf);
    const register = buildRegister(db, config, asOf);

    const eligibility = assessEligibility(config, register, standing, space, {
      product,
      asOf,
      requestedPrincipal: amount,
    });

    if (!eligibility.eligible) {
      throw ApiError.unprocessable(
        'You are not able to take this loan yet',
        eligibility.problems.filter((problem) => problem.code !== 'sponsors_required'),
      );
    }

    return transact(db, () => {
      const id = newId('loan');
      const coverageRatio =
        product === 'short_term' ? config.shortTermLoan.requiredSponsorCoverage : config.sponsorship.coverageRatio;

      if (product === 'term') {
        const termMonths = intField(body, 'termMonths', {
          fallback: config.termLoan.defaultTermMonths,
          min: config.termLoan.minTermMonths,
          max: config.termLoan.maxTermMonths,
        });

        db.prepare(
          `INSERT INTO loans
             (id, member_id, product, principal, purpose, status, monthly_rate, term_months, principal_step,
              coverage_ratio, applied_on, created_at)
           VALUES (?, ?, 'term', ?, ?, 'awaiting_sponsors', ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          principal!.memberId,
          amount,
          purpose || null,
          config.termLoan.monthlyInterestRate,
          termMonths,
          config.termLoan.minimumMonthlyPrincipalRate,
          coverageRatio,
          asOf,
          nowISO(),
        );
      } else {
        const days = intField(body, 'days', { fallback: config.shortTermLoan.maxDays, min: 1 });
        if (days > config.shortTermLoan.maxDays) {
          throw ApiError.unprocessable(
            `Short-term loans run at most ${config.shortTermLoan.maxDays} days; ${days} were asked for`,
          );
        }

        db.prepare(
          `INSERT INTO loans
             (id, member_id, product, principal, purpose, status, flat_rate, term_days,
              coverage_ratio, applied_on, created_at)
           VALUES (?, ?, 'short_term', ?, ?, 'awaiting_sponsors', ?, ?, ?, ?, ?)`,
        ).run(
          id,
          principal!.memberId,
          amount,
          purpose || null,
          config.shortTermLoan.flatRate,
          days,
          coverageRatio,
          asOf,
          nowISO(),
        );
      }

      audit(db, {
        actorId: principal!.memberId,
        action: 'loan_applied',
        entityType: 'loan',
        entityId: id,
        detail: { product, amount },
      });

      const loan = loadLoan(db, id);
      return {
        ...loanSummary(db, config, loan, asOf),
        eligibility,
        nextStep: 'Choose sponsors and send them requests',
      };
    });
  });

  // -------------------------------------------------------------------------
  // Sponsorship
  // -------------------------------------------------------------------------

  /** Who could sponsor this loan, and for how much. */
  router.get('/loans/:id/sponsor-suggestions', ({ params, principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const loan = loadLoan(db, params.id);

    if (loan.member_id !== principal!.memberId) {
      throw ApiError.forbidden('Only the borrower can see suggestions for their own loan');
    }

    const request = sponsorshipRequestFor(db, loan);
    const coverage = coverageStatus(request, {
      selfCover: selfCoverForMember(db, config, loan.member_id, asOf),
      asOf,
    });

    const members = db
      .prepare("SELECT id FROM members WHERE status = 'active' AND id != ?")
      .all(loan.member_id) as unknown as { id: string }[];

    const alreadyAsked = new Set(request.pledges.map((pledge) => pledge.sponsorId));
    const exposures = members
      .filter((member) => !alreadyAsked.has(member.id))
      .map((member) => exposureOf(db, config, member.id, asOf));

    return {
      coverage,
      suggestions: suggestSponsors(config, coverage.shortfall, exposures).map((suggestion) => ({
        ...suggestion,
        memberName: findMember(db, suggestion.memberId).full_name,
      })),
    };
  });

  /**
   * Ask members to stand behind this loan.
   *
   * Each request is validated against the sponsor's real capacity before it is
   * sent, so a sponsor is never asked to accept something the rules would then
   * reject.
   */
  router.post('/loans/:id/sponsors', ({ params, body, principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const loan = loadLoan(db, params.id);

    if (loan.member_id !== principal!.memberId) {
      throw ApiError.forbidden('Only the borrower may request sponsors for their loan');
    }
    if (loan.status !== 'awaiting_sponsors') {
      throw ApiError.conflict(`Loan ${loan.id} is ${loan.status} and is no longer gathering sponsors`);
    }

    const requests = arrayField<{ sponsorId?: string; amount?: number }>(body, 'sponsors');
    if (requests.length === 0) throw ApiError.badRequest('Name at least one sponsor');

    const expiresOn = addDays(asOf, Math.ceil(config.sponsorship.responseWindowHours / 24));

    return transact(db, () => {
      const created: unknown[] = [];

      for (const entry of requests) {
        const sponsorId = String(entry.sponsorId ?? '');
        const amount = Number(entry.amount ?? 0);

        if (!sponsorId) throw ApiError.badRequest('Each sponsor needs a "sponsorId"');
        if (!Number.isInteger(amount) || amount <= 0) {
          throw ApiError.badRequest(`Pledge amount for ${sponsorId} must be a positive whole number`);
        }

        const sponsor = findMember(db, sponsorId);
        if (sponsor.status !== 'active') {
          throw ApiError.unprocessable(`${sponsor.full_name} is not an active member`);
        }

        // Re-read the request each time so two sponsors in one call cannot
        // both be validated against the same stale state.
        const request = sponsorshipRequestFor(db, loan);
        const validation = validatePledge(
          config,
          request,
          { sponsorId, amount },
          exposureOf(db, config, sponsorId, asOf),
        );

        if (!validation.ok) {
          throw ApiError.unprocessable(`Cannot ask ${sponsor.full_name} for that amount`, validation.problems);
        }

        const pledgeId = newId('pl');
        db.prepare(
          `INSERT INTO pledges (id, loan_id, sponsor_id, amount, status, requested_on, expires_on, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        ).run(pledgeId, loan.id, sponsorId, amount, asOf, expiresOn, nowISO());

        notify(db, {
          memberId: sponsorId,
          kind: 'sponsorship_request',
          title: `${principal!.name} has asked you to sponsor a loan`,
          body:
            `${principal!.name} is applying for ${formatMoney(loan.principal, config.currency)} and has asked ` +
            `you to stand behind ${formatMoney(amount, config.currency)} of it. If the loan defaults, that much ` +
            `of your shareholding can be called. You have until ${expiresOn} to answer.`,
          payload: { loanId: loan.id, pledgeId, amount },
          actionUrl: `/sponsorships/${pledgeId}`,
        });

        created.push({ pledgeId, sponsorId, sponsorName: sponsor.full_name, amount, expiresOn });
      }

      audit(db, {
        actorId: principal!.memberId,
        action: 'sponsors_requested',
        entityType: 'loan',
        entityId: loan.id,
        detail: { count: created.length },
      });

      const request = sponsorshipRequestFor(db, loan);
      return {
        requested: created,
        coverage: coverageStatus(request, {
          selfCover: selfCoverForMember(db, config, loan.member_id, asOf),
          asOf,
        }),
      };
    });
  });

  /** A sponsor's own inbox. */
  router.get('/sponsorships', ({ principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const pledges = loadPledgesBySponsor(db, principal!.memberId);

    return {
      capacity: exposureOf(db, config, principal!.memberId, asOf),
      pledges: pledges.map((pledge) => {
        const loan = loadLoan(db, pledge.loanId);
        const borrower = findMember(db, loan.member_id);
        return {
          ...pledge,
          borrowerName: borrower.full_name,
          loanPrincipal: loan.principal,
          loanPurpose: loan.purpose,
          loanStatus: loan.status,
        };
      }),
    };
  });

  /**
   * Accept or decline.
   *
   * Accepting is the whole approval mechanism: if this pledge completes the
   * cover, the loan approves itself here and the cashier is told to pay out.
   */
  router.post('/sponsorships/:pledgeId/respond', ({ params, body, principal }) => {
    const config = loadConfig(db);
    const asOf = today();
    const decision = enumField(body, 'decision', ['accept', 'decline'] as const);
    const note = str(body, 'note', { optional: true, max: 300 });

    const row = db.prepare('SELECT * FROM pledges WHERE id = ?').get(params.pledgeId) as unknown as
      | { id: string; loan_id: string; sponsor_id: string; amount: number; status: string; expires_on: string }
      | undefined;

    if (!row) throw ApiError.notFound('No such sponsorship request');
    if (row.sponsor_id !== principal!.memberId) {
      throw ApiError.forbidden('Only the member who was asked can answer this request');
    }
    if (row.status !== 'pending') {
      throw ApiError.conflict(`You have already answered this request (${row.status})`);
    }
    if (asOf > row.expires_on) {
      db.prepare("UPDATE pledges SET status = 'expired' WHERE id = ?").run(row.id);
      throw ApiError.conflict(`This request closed on ${row.expires_on}`);
    }

    const loan = loadLoan(db, row.loan_id);
    if (loan.status !== 'awaiting_sponsors') {
      throw ApiError.conflict(`That loan is ${loan.status} and no longer needs sponsors`);
    }

    return transact(db, () => {
      // Re-check capacity at acceptance: the sponsor may have pledged
      // elsewhere, or borrowed, since they were asked. This pledge itself is
      // excluded — it is what they are answering, not a prior commitment.
      if (decision === 'accept') {
        const exposure = exposureOf(db, config, principal!.memberId, asOf, { excludePledgeId: row.id });
        const capacity = pledgeableCapacity(exposure, config.shares.parValue);
        if (row.amount > capacity) {
          throw ApiError.unprocessable(
            `You can no longer cover ${formatMoney(row.amount, config.currency)}: your available cover is ` +
              `${formatMoney(capacity, config.currency)} after your other pledges and borrowing.`,
          );
        }
      }

      db.prepare('UPDATE pledges SET status = ?, responded_on = ?, note = ? WHERE id = ?').run(
        decision === 'accept' ? 'accepted' : 'declined',
        asOf,
        note || null,
        row.id,
      );

      const borrower = findMember(db, loan.member_id);

      notify(db, {
        memberId: loan.member_id,
        kind: 'sponsorship_response',
        title:
          decision === 'accept'
            ? `${principal!.name} has agreed to sponsor you`
            : `${principal!.name} has declined to sponsor you`,
        body:
          decision === 'accept'
            ? `${principal!.name} is standing behind ${formatMoney(row.amount, config.currency)} of your loan.`
            : `${principal!.name} will not be sponsoring this loan${note ? `: ${note}` : '.'}`,
        payload: { loanId: loan.id, pledgeId: row.id },
        actionUrl: `/loans/${loan.id}`,
      });

      const request = sponsorshipRequestFor(db, loan);
      const selfCover = selfCoverForMember(db, config, loan.member_id, asOf);
      const approval = evaluateApproval(request, { selfCover, asOf });

      let approvedNow = false;

      if (approval.approved && config.sponsorship.autoApproveOnFullCoverage) {
        db.prepare("UPDATE loans SET status = 'approved', approved_on = ? WHERE id = ?").run(asOf, loan.id);
        approvedNow = true;

        notify(db, {
          memberId: loan.member_id,
          kind: 'loan_approved',
          title: 'Your loan is fully sponsored and approved',
          body:
            `${formatMoney(loan.principal, config.currency)} is approved. The cashier will confirm where to ` +
            'collect the money.',
          payload: { loanId: loan.id },
          actionUrl: `/loans/${loan.id}`,
        });

        // The cashier's queue is a notification, not a separate workflow:
        // there is only ever one thing for them to do, which is pay it out.
        for (const cashier of db
          .prepare("SELECT id FROM members WHERE role IN ('cashier','chair') AND status = 'active'")
          .all() as unknown as { id: string }[]) {
          notify(db, {
            memberId: cashier.id,
            kind: 'disbursement_due',
            title: `Disbursement due: ${formatMoney(loan.principal, config.currency)} to ${borrower.full_name}`,
            body: `Loan ${loan.id} reached full sponsor cover on ${asOf} and is ready to pay out.`,
            payload: { loanId: loan.id },
            actionUrl: `/cashier/disbursements`,
          });
        }

        // Every member can see who is standing behind whom.
        notifyCircle(db, {
          kind: 'ledger',
          title: `${borrower.full_name}'s loan was approved`,
          body:
            `${formatMoney(loan.principal, config.currency)} approved on ${asOf}, covered by ` +
            `${approval.coverage.acceptedSponsorCount} sponsor(s) and the borrower's own shares.`,
          exclude: [loan.member_id],
          actionUrl: `/ledger`,
        });
      }

      audit(db, {
        actorId: principal!.memberId,
        action: `sponsorship_${decision}`,
        entityType: 'loan',
        entityId: loan.id,
        detail: { pledgeId: row.id, amount: row.amount, approvedNow },
      });

      return {
        decision,
        approvedNow,
        coverage: approval.coverage,
      };
    });
  });

  /** Withdraw a request the borrower no longer needs. */
  router.post('/loans/:id/sponsors/:pledgeId/withdraw', ({ params, principal }) => {
    const loan = loadLoan(db, params.id);
    if (loan.member_id !== principal!.memberId) {
      throw ApiError.forbidden('Only the borrower may withdraw a sponsorship request');
    }

    const result = db
      .prepare("UPDATE pledges SET status = 'withdrawn' WHERE id = ? AND loan_id = ? AND status = 'pending'")
      .run(params.pledgeId, loan.id);

    if (result.changes === 0) {
      throw ApiError.conflict('That request has already been answered or withdrawn');
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Reading loans
  // -------------------------------------------------------------------------

  router.get('/loans', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const status = query.get('status');
    const memberId = query.get('memberId');

    const clauses: string[] = [];
    const args: string[] = [];
    if (status) {
      clauses.push('status = ?');
      args.push(status);
    }
    if (memberId) {
      clauses.push('member_id = ?');
      args.push(memberId);
    }

    const rows = db
      .prepare(
        `SELECT * FROM loans ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY applied_on DESC`,
      )
      .all(...args) as unknown as LoanRow[];

    return { loans: rows.map((loan) => loanSummary(db, config, loan, asOf)) };
  });

  router.get('/loans/:id', ({ params, query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const loan = loadLoan(db, params.id);

    const pledges = loadPledges(db, loan.id).map((pledge) => ({
      ...pledge,
      sponsorName: findMember(db, pledge.sponsorId).full_name,
    }));

    return {
      ...loanSummary(db, config, loan, asOf),
      pledges,
      repayments: loadRepayments(db, loan.id),
    };
  });

  /** What it would cost to clear this loan today. */
  router.get('/loans/:id/settlement', ({ params, query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();
    const loan = loadLoan(db, params.id);

    if (loan.status !== 'disbursed') {
      throw ApiError.conflict(`Loan ${loan.id} is ${loan.status}; there is nothing to settle`);
    }
    // A short-term loan is a single bullet, so there is nothing to rebate:
    // what it costs to clear today is simply what is outstanding.
    const position = loanPosition(db, config, loan, asOf);
    if (position.product === 'short_term') {
      return { asOf, payoffAmount: position.state.payoffAmount, state: position.state };
    }

    const quote = settlementQuote(scheduleFor(db, config, loan), loadRepayments(db, loan.id), {
      asOf,
      penaltyMonthlyRate: config.termLoan.penaltyMonthlyRate,
      accrualBasisDays: config.facility.accrualBasisDays,
      rebateUnearnedInterest: config.termLoan.earlySettlementRebate,
    });

    return {
      ...quote,
      explanation:
        quote.interestRebate > 0
          ? `Settling today saves you ${formatMoney(quote.savingVersusSchedule, config.currency)}: ` +
            `${formatMoney(quote.interestRebate, config.currency)} of the interest you have already paid covers ` +
            'months you will not now use, and it is credited back.'
          : `Settling today costs ${formatMoney(quote.payoffAmount, config.currency)}.`,
    };
  });

  // -------------------------------------------------------------------------
  // Disbursement
  // -------------------------------------------------------------------------

  /**
   * Pay the money out.
   *
   * The schedule is computed here and frozen into the loan record: what the
   * member owes is fixed at the moment they receive the money, and a later
   * change to the circle's rate cannot reach back and alter it.
   */
  router.post(
    '/loans/:id/disburse',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const loan = loadLoan(db, params.id);
      const disbursedOn = dateField(body, 'disbursedOn', today());
      const reference = str(body, 'reference', { optional: true, max: 120 });

      if (loan.status !== 'approved') {
        throw ApiError.conflict(
          `Loan ${loan.id} is ${loan.status}. Only a fully sponsored, approved loan can be paid out.`,
        );
      }

      const space = headroom(db, config, disbursedOn);
      if (loan.principal > space.available) {
        throw ApiError.unprocessable(
          `The circle has ${formatMoney(space.available, config.currency)} free to lend but this loan is ` +
            `${formatMoney(loan.principal, config.currency)}. Wait for repayments or raise more capital.`,
        );
      }

      return transact(db, () => {
        let scheduleJson: string;
        let maturityOn: string;

        if (loan.product === 'term') {
          const schedule = buildTermLoanSchedule({
            principal: loan.principal,
            monthlyInterestRate: loan.monthly_rate ?? config.termLoan.monthlyInterestRate,
            termMonths: loan.term_months ?? config.termLoan.defaultTermMonths,
            minimumMonthlyPrincipalRate: loan.principal_step ?? config.termLoan.minimumMonthlyPrincipalRate,
            disbursedOn,
            balloonGraceDays: config.termLoan.balloonGraceDays,
          });
          scheduleJson = JSON.stringify(schedule);
          maturityOn = schedule.maturityOn;
        } else {
          const shortTerm = buildShortTermLoan({
            principal: loan.principal,
            flatRate: loan.flat_rate ?? config.shortTermLoan.flatRate,
            days: loan.term_days ?? config.shortTermLoan.maxDays,
            disbursedOn,
            mode: config.shortTermLoan.interestMode,
            minimumFee: config.shortTermLoan.minimumFee,
          });
          scheduleJson = JSON.stringify(shortTerm);
          maturityOn = shortTerm.dueOn;
        }

        db.prepare(
          `UPDATE loans SET status = 'disbursed', disbursed_on = ?, maturity_on = ?, schedule_json = ?,
                            disbursed_by = ? WHERE id = ?`,
        ).run(disbursedOn, maturityOn, scheduleJson, principal!.memberId, loan.id);

        const book = buildBook(db);
        post(db, book, {
          ...disbursementEntry(
            { id: newId('je'), date: disbursedOn, reference: reference || undefined, postedBy: principal!.memberId },
            { loanId: loan.id, memberId: loan.member_id, principal: loan.principal },
          ),
        });

        writeSnapshot(db, config, disbursedOn);

        const borrower = findMember(db, loan.member_id);
        const schedule = JSON.parse(scheduleJson);

        notify(db, {
          memberId: loan.member_id,
          kind: 'loan_disbursed',
          title: `${formatMoney(loan.principal, config.currency)} has been released to you`,
          body:
            loan.product === 'term'
              ? `Your first instalment of ${formatMoney(schedule.levelServiceInstalment, config.currency)} is ` +
                `due on ${schedule.rows[0].dueOn}. The final flat payment of ` +
                `${formatMoney(schedule.balloon, config.currency)} is due on ${maturityOn}.`
              : `Repay ${formatMoney(schedule.totalRepayable, config.currency)} by ${maturityOn}.`,
          payload: { loanId: loan.id },
          actionUrl: `/loans/${loan.id}`,
        });

        notifyCircle(db, {
          kind: 'ledger',
          title: `${formatMoney(loan.principal, config.currency)} disbursed to ${borrower.full_name}`,
          body: `Loan ${loan.id} was paid out on ${disbursedOn}.`,
          exclude: [loan.member_id],
          actionUrl: '/ledger',
        });

        audit(db, {
          actorId: principal!.memberId,
          action: 'loan_disbursed',
          entityType: 'loan',
          entityId: loan.id,
          detail: { principal: loan.principal, disbursedOn },
        });

        return loanSummary(db, config, loadLoan(db, loan.id), disbursedOn);
      });
    },
    { roles: CASHIER_ROLES },
  );

  // -------------------------------------------------------------------------
  // Repayment
  // -------------------------------------------------------------------------

  router.post(
    '/loans/:id/repayments',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const loan = loadLoan(db, params.id);
      const amount = moneyField(body, 'amount');
      const paidOn = dateField(body, 'paidOn', today());
      const reference = str(body, 'reference', { optional: true, max: 120 });

      if (amount <= 0) throw ApiError.badRequest('"amount" must be greater than zero');
      if (loan.status !== 'disbursed' && loan.status !== 'defaulted') {
        throw ApiError.conflict(`Loan ${loan.id} is ${loan.status} and is not taking repayments`);
      }

      return transact(db, () => {
        db.prepare(
          `INSERT INTO repayments (id, loan_id, member_id, amount, paid_on, reference, recorded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId('rep'),
          loan.id,
          loan.member_id,
          amount,
          paidOn,
          reference || null,
          principal!.memberId,
          nowISO(),
        );

        // Split the payment the same way the servicing engine does, so the
        // books record income exactly as the loan records it.
        const repayments = loadRepayments(db, loan.id);
        let towardPrincipal = amount;
        let towardInterest = 0;
        let towardPenalty = 0;

        if (loan.product === 'term') {
          const state = applyRepayments(scheduleFor(db, config, loan), repayments, {
            asOf: paidOn,
            penaltyMonthlyRate: config.termLoan.penaltyMonthlyRate,
            accrualBasisDays: config.facility.accrualBasisDays,
          });
          const allocation = state.allocations[state.allocations.length - 1];
          towardPrincipal = allocation.towardPrincipal;
          towardInterest = allocation.towardInterest;
          towardPenalty = allocation.towardPenalty;
        } else {
          // A bullet loan: the fee is earned first, then principal.
          const shortTerm = shortTermFor(db, config, loan);
          const paidBefore = repayments
            .filter((repayment) => repayment.paidOn < paidOn || repayment.id !== repayments.at(-1)?.id)
            .reduce((total, repayment) => total + repayment.amount, 0);
          const feeRemaining = Math.max(0, shortTerm.fee - paidBefore);
          towardInterest = Math.min(feeRemaining, amount);
          towardPrincipal = amount - towardInterest;
        }

        const book = buildBook(db);
        post(db, book, {
          ...repaymentEntry(
            { id: newId('je'), date: paidOn, reference: reference || undefined, postedBy: principal!.memberId },
            {
              loanId: loan.id,
              memberId: loan.member_id,
              principal: towardPrincipal,
              interest: towardInterest,
              penalty: towardPenalty,
            },
          ),
        });

        writeSnapshot(db, config, paidOn);

        // Settle the loan if nothing is left owing.
        const position = loanPosition(db, config, loadLoan(db, loan.id), paidOn);
        const cleared =
          position.product === 'term'
            ? position.state.status === 'settled'
            : position.state.status === 'settled';

        if (cleared) {
          db.prepare("UPDATE loans SET status = 'settled', settled_on = ? WHERE id = ?").run(paidOn, loan.id);
          notify(db, {
            memberId: loan.member_id,
            kind: 'loan_settled',
            title: 'Your loan is fully repaid',
            body: `Loan ${loan.id} was cleared on ${paidOn}. The sponsors who backed you have been released.`,
            payload: { loanId: loan.id },
          });

          for (const pledge of loadPledges(db, loan.id)) {
            if (pledge.status !== 'accepted') continue;
            notify(db, {
              memberId: pledge.sponsorId,
              kind: 'sponsorship_released',
              title: 'A loan you sponsored has been repaid',
              body:
                `${findMember(db, loan.member_id).full_name} has cleared their loan, so the ` +
                `${formatMoney(pledge.amount, config.currency)} you had committed is free again.`,
              payload: { loanId: loan.id },
            });
          }
        }

        audit(db, {
          actorId: principal!.memberId,
          action: 'repayment_recorded',
          entityType: 'loan',
          entityId: loan.id,
          detail: { amount, paidOn, towardPrincipal, towardInterest, towardPenalty },
        });

        return {
          recorded: { amount, paidOn, towardPrincipal, towardInterest, towardPenalty },
          loan: loanSummary(db, config, loadLoan(db, loan.id), paidOn),
        };
      });
    },
    { roles: CASHIER_ROLES },
  );

  // -------------------------------------------------------------------------
  // Default
  // -------------------------------------------------------------------------

  /**
   * Call a loan in default and run the cascade.
   *
   * This takes shares from real people, so it is deliberately explicit: the
   * cashier must name the date, and the response reports exactly who lost what
   * before anyone has to ask.
   */
  router.post(
    '/loans/:id/default',
    ({ params, body, principal }) => {
      const config = loadConfig(db);
      const loan = loadLoan(db, params.id);
      const occurredOn = dateField(body, 'occurredOn', today());
      const reason = str(body, 'reason', { max: 400 });

      if (loan.status !== 'disbursed') {
        throw ApiError.conflict(`Loan ${loan.id} is ${loan.status} and cannot be called in default`);
      }

      const position = loanPosition(db, config, loan, occurredOn);
      const loss =
        position.product === 'term'
          ? position.state.principalOutstanding + position.state.interestOutstanding
          : position.state.outstanding;

      if (loss <= 0) throw ApiError.conflict('There is nothing outstanding on this loan');

      return transact(db, () => {
        const register = buildRegister(db, config, occurredOn);
        const request = sponsorshipRequestFor(db, loan);
        const cascade = runDefaultCascade(register, request, loss, occurredOn);

        // Persist every share movement the cascade produced.
        if (cascade.borrower.sharesForfeited > 0) {
          recordShareMovement(db, {
            memberId: loan.member_id,
            kind: 'dilution',
            shares: -cascade.borrower.sharesForfeited,
            amount: cascade.borrower.valueRecovered,
            occurredOn,
            narration: `Default on loan ${loan.id}`,
            loanId: loan.id,
          });
        }

        for (const call of cascade.sponsorCalls) {
          if (call.sharesForfeited > 0) {
            recordShareMovement(db, {
              memberId: call.sponsorId,
              kind: 'dilution',
              shares: -call.sharesForfeited,
              amount: call.valueRecovered,
              occurredOn,
              narration: `Sponsor call on loan ${loan.id}`,
              loanId: loan.id,
            });
          }
          db.prepare("UPDATE pledges SET status = 'called' WHERE id = ?").run(call.pledgeId);
        }

        const outstandingPrincipal =
          position.product === 'term' ? position.state.principalOutstanding : position.state.outstanding;

        const book = buildBook(db);
        post(db, book, {
          ...defaultWriteOffEntry(
            { id: newId('je'), date: occurredOn, postedBy: principal!.memberId },
            {
              loanId: loan.id,
              memberId: loan.member_id,
              outstandingPrincipal,
              recoveredFromShares: Math.min(
                cascade.totalRecovered,
                outstandingPrincipal,
              ),
              sponsorReceivable: Math.min(
                cascade.totalReceivable,
                Math.max(0, outstandingPrincipal - cascade.totalRecovered),
              ),
              writtenOff: Math.max(
                0,
                outstandingPrincipal -
                  Math.min(cascade.totalRecovered, outstandingPrincipal) -
                  Math.min(
                    cascade.totalReceivable,
                    Math.max(0, outstandingPrincipal - cascade.totalRecovered),
                  ),
              ),
            },
          ),
        });

        db.prepare("UPDATE loans SET status = 'defaulted', defaulted_on = ?, decline_reason = ? WHERE id = ?").run(
          occurredOn,
          reason,
          loan.id,
        );

        writeSnapshot(db, config, occurredOn);

        const borrower = findMember(db, loan.member_id);

        notify(db, {
          memberId: loan.member_id,
          kind: 'loan_defaulted',
          title: 'Your loan has been called in default',
          body:
            `${formatMoney(loss, config.currency)} was outstanding on loan ${loan.id}. ` +
            `${cascade.borrower.sharesForfeited} of your shares have been forfeited to cover it.`,
          payload: { loanId: loan.id },
        });

        for (const call of cascade.sponsorCalls) {
          if (call.called <= 0) continue;
          notify(db, {
            memberId: call.sponsorId,
            kind: 'sponsor_called',
            title: 'A loan you sponsored has defaulted',
            body:
              `${borrower.full_name} defaulted on loan ${loan.id}. You were called for ` +
              `${formatMoney(call.called, config.currency)}: ${call.sharesForfeited} of your shares were ` +
              `forfeited` +
              (call.receivable > 0
                ? ` and ${formatMoney(call.receivable, config.currency)} remains owing from you.`
                : '.'),
            payload: { loanId: loan.id },
          });
        }

        audit(db, {
          actorId: principal!.memberId,
          action: 'loan_defaulted',
          entityType: 'loan',
          entityId: loan.id,
          detail: cascade,
        });

        return { loanId: loan.id, loss, cascade };
      });
    },
    { roles: CASHIER_ROLES },
  );

  /** Sweep pledges whose window has closed. */
  router.post('/loans/expire-pledges', ({ principal }) => {
    const asOf = today();
    const loans = db
      .prepare("SELECT * FROM loans WHERE status = 'awaiting_sponsors'")
      .all() as unknown as LoanRow[];

    let expired = 0;
    for (const loan of loans) {
      const request = sponsorshipRequestFor(db, loan);
      for (const pledge of expirePledges(request, asOf)) {
        db.prepare("UPDATE pledges SET status = 'expired' WHERE id = ?").run(pledge.id);
        expired += 1;
      }
    }

    audit(db, { actorId: principal!.memberId, action: 'pledges_expired', detail: { expired } });
    return { expired };
  });
}
