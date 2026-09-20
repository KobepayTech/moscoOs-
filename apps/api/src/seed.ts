/**
 * Seed a worked circle.
 *
 * Builds the founding scenario end to end so the apps have something real to
 * show and so the whole stack can be exercised without clicking through it:
 *
 *   - thirty members, fifty shares each — TSh 150,000,000 of share capital
 *   - one of them advances a TSh 200,000,000 facility as external capital
 *   - several loans in different states: fully repaid, mid-schedule, awaiting
 *     sponsors, in arrears, and one short-term bullet
 *   - an open deletion proposal with votes part-cast
 *
 * Every figure goes through the same engine and the same endpoints the apps
 * use, so if the seed produces a balanced set of books, the paths that
 * produced them work.
 */

import { pathToFileURL } from 'node:url';

import {
  addDays,
  buildTermLoanSchedule,
  createFacility,
  addMonths,
  defaultCircleConfig,
  disbursementEntry,
  facilityDrawdownEntry,
  feeEntry,
  formatMoney,
  monthKey,
  repaymentEntry,
  shareSubscriptionEntry,
  startOfMonth,
  today,
  trialBalance,
} from '@mamogoro/core';

import { hashPassword } from './auth.js';
import { buildBook, notify, post, recordShareMovement, saveConfig, writeSnapshot } from './circle.js';
import { openDb, newId, nowISO, transact, type Db } from './db.js';

const NAMES = [
  'Amani Mushi', 'Neema Kileo', 'Baraka Shirima', 'Zawadi Massawe', 'Juma Mbwana',
  'Rehema Kimaro', 'Elia Swai', 'Sifa Mrema', 'Godfrey Temu', 'Upendo Nyerere',
  'Hamisi Rajabu', 'Grace Lyimo', 'Thabiti Msuya', 'Pendo Macha', 'Salum Kikwete',
  'Joyce Munisi', 'Emmanuel Mollel', 'Doreen Sanga', 'Frank Ndosi', 'Anna Chuwa',
  'Salma Athumani', 'Peter Mwakalinga', 'Faraja Lema', 'Devotha Urassa', 'Yusuf Kilonzo',
  'Christina Moshi', 'Ibrahim Mbise', 'Happiness Kaaya', 'Deogratius Minja', 'Fatuma Hassan',
];

/** Months of history the seeded circle has behind it. */
const HISTORY_MONTHS = 8;

export interface SeedSummary {
  startedOn: string;
  memberIds: string[];
  /** Month keys every member has contributed for. */
  contributionPeriods: string[];
  /** Shares in issue once founding subscriptions and contributions are in. */
  issuedShares: number;
  equityCapital: number;
  facilityPrincipal: number;
}

/**
 * Populate a circle with eight months of history behind it.
 *
 * Dates are relative to the day the seed runs, not fixed in the calendar: a
 * demonstration circle whose members last contributed in January looks broken
 * when you open it in September, and every eligibility rule that depends on
 * being up to date would fire for the wrong reason.
 */
export function seed(db: Db, options: { quiet?: boolean } = {}): SeedSummary {
  const log = options.quiet ? () => {} : (message: string) => console.log(message);
  const config = saveConfig(db, defaultCircleConfig());
  const currency = config.currency;
  const money = (amount: number) => formatMoney(amount, currency);

  const anchor = today();
  const START = addDays(startOfMonth(addMonths(anchor, -HISTORY_MONTHS)), 4);

  /** `ago(3)` is the same day of the month, three months back. */
  const ago = (months: number) => addMonths(anchor, -months);
  /** `daysAgo(10)` is ten days before today. */
  const daysAgo = (days: number) => addDays(anchor, -days);

  // Every month from joining up to last month is due and paid. The current
  // month is left open, which is what a real circle looks like mid-month.
  const contributionPeriods: string[] = [];
  for (let back = HISTORY_MONTHS; back >= 1; back -= 1) {
    contributionPeriods.push(monthKey(ago(back)));
  }

  transact(db, () => {
    // -----------------------------------------------------------------------
    // 1. Thirty members, fifty shares each
    // -----------------------------------------------------------------------

    const memberIds: string[] = [];

    NAMES.forEach((fullName, index) => {
      const id = `mem_${String(index + 1).padStart(2, '0')}`;
      const role =
        index === 0 ? 'chair' : index === 1 ? 'cashier' : index === 2 ? 'secretary' : 'member';

      db.prepare(
        `INSERT INTO members
           (id, full_name, phone, email, role, password_hash, joined_on, status, annual_fee_paid_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        fullName,
        `+2557${String(10000000 + index * 137).slice(0, 8)}`,
        `${fullName.split(' ')[0].toLowerCase()}@mamogoro.test`,
        role,
        // Demonstration credentials. The README says plainly that these must
        // be replaced before any real circle uses this.
        hashPassword('mamogoro123'),
        START,
        START,
        nowISO(),
      );

      recordShareMovement(db, {
        memberId: id,
        kind: 'subscription',
        shares: config.shares.minimumMembershipShares,
        amount: config.shares.minimumMembershipShares * config.shares.parValue,
        occurredOn: START,
        narration: 'Founding subscription',
      });

      memberIds.push(id);
    });

    const book = buildBook(db);

    for (const id of memberIds) {
      post(db, book, {
        ...shareSubscriptionEntry(
          { id: newId('je'), date: START },
          { memberId: id, amount: config.shares.minimumMembershipShares * config.shares.parValue },
        ),
      });

      const fees = config.membership.joiningFee + config.membership.annualFee;
      db.prepare(
        `INSERT INTO fees (id, member_id, kind, amount, paid_on, created_at) VALUES (?, ?, 'joining', ?, ?, ?)`,
      ).run(newId('fee'), id, fees, START, nowISO());

      post(db, book, {
        ...feeEntry(
          { id: newId('je'), date: START },
          { memberId: id, amount: fees, description: 'Joining fee and annual subscription' },
        ),
      });
    }

    log(`Enrolled ${memberIds.length} members — ${money(memberIds.length * 5_000_000)} of share capital`);

    // -----------------------------------------------------------------------
    // 2. Monthly contributions for the first two months
    // -----------------------------------------------------------------------

    for (const period of contributionPeriods) {
      const paidOn = `${period}-28`;
      for (const id of memberIds) {
        db.prepare(
          `INSERT INTO contributions (id, member_id, period, amount, paid_on, recorded_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'mem_02', ?)`,
        ).run(newId('con'), id, period, config.membership.monthlyContribution, paidOn, nowISO());

        const shares = Math.floor(config.membership.monthlyContribution / config.shares.parValue);
        recordShareMovement(db, {
          memberId: id,
          kind: 'monthly_contribution',
          shares,
          amount: shares * config.shares.parValue,
          occurredOn: paidOn,
          narration: `Monthly contribution for ${period}`,
        });

        post(db, book, {
          ...shareSubscriptionEntry(
            { id: newId('je'), date: paidOn },
            { memberId: id, amount: shares * config.shares.parValue },
          ),
          narration: `Monthly contribution for ${period}`,
        });
      }
    }

    log(`Recorded ${contributionPeriods.length} months of contributions for every member`);

    // -----------------------------------------------------------------------
    // 3. External capital: one member advances TSh 200,000,000
    // -----------------------------------------------------------------------

    const investorId = 'mem_05';
    const facilityFundedOn = addDays(START, 15);
    const facility = createFacility(config, {
      id: 'fac_01',
      investorMemberId: investorId,
      principal: 200_000_000,
      fundedOn: facilityFundedOn,
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
      'Founding external capital facility',
      nowISO(),
    );

    post(db, book, {
      ...facilityDrawdownEntry(
        { id: newId('je'), date: facilityFundedOn },
        { facilityId: facility.id, investorMemberId: investorId, amount: facility.principal },
      ),
    });

    log(`${NAMES[4]} advanced ${money(200_000_000)} as external capital`);

    // -----------------------------------------------------------------------
    // 4. Loans
    // -----------------------------------------------------------------------

    /** Disburse a term loan with sponsors behind it, and optionally repay it. */
    const writeTermLoan = (spec: {
      id: string;
      borrower: string;
      principal: number;
      disbursedOn: string;
      purpose: string;
      sponsors: { id: string; amount: number }[];
      instalmentsPaid: number;
      payBalloon?: boolean;
    }) => {
      const schedule = buildTermLoanSchedule({
        principal: spec.principal,
        monthlyInterestRate: config.termLoan.monthlyInterestRate,
        termMonths: config.termLoan.defaultTermMonths,
        minimumMonthlyPrincipalRate: config.termLoan.minimumMonthlyPrincipalRate,
        disbursedOn: spec.disbursedOn,
        balloonGraceDays: config.termLoan.balloonGraceDays,
      });

      db.prepare(
        `INSERT INTO loans
           (id, member_id, product, principal, purpose, status, monthly_rate, term_months, principal_step,
            coverage_ratio, applied_on, approved_on, disbursed_on, maturity_on, schedule_json,
            disbursed_by, created_at)
         VALUES (?, ?, 'term', ?, ?, 'disbursed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mem_02', ?)`,
      ).run(
        spec.id,
        spec.borrower,
        spec.principal,
        spec.purpose,
        config.termLoan.monthlyInterestRate,
        config.termLoan.defaultTermMonths,
        config.termLoan.minimumMonthlyPrincipalRate,
        config.sponsorship.coverageRatio,
        addDays(spec.disbursedOn, -5),
        addDays(spec.disbursedOn, -1),
        spec.disbursedOn,
        schedule.maturityOn,
        JSON.stringify(schedule),
        nowISO(),
      );

      for (const sponsor of spec.sponsors) {
        db.prepare(
          `INSERT INTO pledges
             (id, loan_id, sponsor_id, amount, status, requested_on, responded_on, expires_on, created_at)
           VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
        ).run(
          newId('pl'),
          spec.id,
          sponsor.id,
          sponsor.amount,
          addDays(spec.disbursedOn, -5),
          addDays(spec.disbursedOn, -2),
          addDays(spec.disbursedOn, -2),
          nowISO(),
        );
      }

      post(db, book, {
        ...disbursementEntry(
          { id: newId('je'), date: spec.disbursedOn },
          { loanId: spec.id, memberId: spec.borrower, principal: spec.principal },
        ),
      });

      // Repay the instalments the scenario calls for, splitting each the way
      // the servicing engine would.
      const serviceRows = schedule.rows.filter((row) => row.kind === 'service');
      for (let i = 0; i < Math.min(spec.instalmentsPaid, serviceRows.length); i += 1) {
        const row = serviceRows[i];
        db.prepare(
          `INSERT INTO repayments (id, loan_id, member_id, amount, paid_on, recorded_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'mem_02', ?)`,
        ).run(newId('rep'), spec.id, spec.borrower, row.totalDue, row.dueOn, nowISO());

        post(db, book, {
          ...repaymentEntry(
            { id: newId('je'), date: row.dueOn },
            {
              loanId: spec.id,
              memberId: spec.borrower,
              principal: row.principalDue,
              interest: row.interestDue,
            },
          ),
        });
      }

      if (spec.payBalloon && schedule.balloon > 0) {
        db.prepare(
          `INSERT INTO repayments (id, loan_id, member_id, amount, paid_on, recorded_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'mem_02', ?)`,
        ).run(newId('rep'), spec.id, spec.borrower, schedule.balloon, schedule.maturityOn, nowISO());

        post(db, book, {
          ...repaymentEntry(
            { id: newId('je'), date: schedule.maturityOn },
            { loanId: spec.id, memberId: spec.borrower, principal: schedule.balloon, interest: 0 },
          ),
        });

        db.prepare("UPDATE loans SET status = 'settled', settled_on = ? WHERE id = ?").run(
          schedule.maturityOn,
          spec.id,
        );
      }

      return schedule;
    };

    // The founding worked example: 50,000,000 over three months, mid-schedule.
    const headline = writeTermLoan({
      id: 'loan_01',
      borrower: 'mem_07',
      principal: 50_000_000,
      // Two months in: two instalments paid, the balloon still ahead.
      disbursedOn: ago(2),
      purpose: 'Stock purchase from Guangzhou — electronics for the season',
      sponsors: [
        { id: 'mem_01', amount: 5_000_000 },
        { id: 'mem_03', amount: 5_000_000 },
        { id: 'mem_04', amount: 5_000_000 },
        { id: 'mem_06', amount: 5_000_000 },
        { id: 'mem_08', amount: 5_000_000 },
        { id: 'mem_09', amount: 5_000_000 },
        { id: 'mem_10', amount: 5_000_000 },
        { id: 'mem_11', amount: 5_000_000 },
        { id: 'mem_12', amount: 5_000_000 },
      ],
      instalmentsPaid: 2,
    });

    log(
      `Loan 01 — ${money(50_000_000)} to ${NAMES[6]}: ` +
        `${money(headline.levelServiceInstalment)} a month, then a flat ${money(headline.balloon)} balloon`,
    );

    // A loan that ran its course and was fully repaid.
    writeTermLoan({
      id: 'loan_02',
      borrower: 'mem_13',
      principal: 20_000_000,
      disbursedOn: ago(6),
      purpose: 'Hardware stock for the Arusha shop',
      sponsors: [
        { id: 'mem_14', amount: 5_000_000 },
        { id: 'mem_15', amount: 5_000_000 },
        { id: 'mem_16', amount: 5_000_000 },
        { id: 'mem_17', amount: 5_000_000 },
      ],
      instalmentsPaid: 3,
      payBalloon: true,
    });

    // A loan that has fallen behind: nothing repaid, penalties running.
    writeTermLoan({
      id: 'loan_03',
      borrower: 'mem_20',
      principal: 30_000_000,
      disbursedOn: ago(4),
      purpose: 'Textiles consignment',
      sponsors: [
        { id: 'mem_21', amount: 8_000_000 },
        { id: 'mem_22', amount: 8_000_000 },
        { id: 'mem_23', amount: 9_000_000 },
      ],
      instalmentsPaid: 0,
    });

    // A short-term bullet loan, still running: ten days out, four to go.
    const shortTermDisbursed = daysAgo(10);
    const shortTermDue = addDays(shortTermDisbursed, 14);
    db.prepare(
      `INSERT INTO loans
         (id, member_id, product, principal, purpose, status, flat_rate, term_days, coverage_ratio,
          applied_on, approved_on, disbursed_on, maturity_on, schedule_json, disbursed_by, created_at)
       VALUES (?, 'mem_25', 'short_term', ?, ?, 'disbursed', ?, 14, ?, ?, ?, ?, ?, ?, 'mem_02', ?)`,
    ).run(
      'loan_04',
      5_000_000,
      'Bridging a customs payment for two weeks',
      config.shortTermLoan.flatRate,
      config.shortTermLoan.requiredSponsorCoverage,
      daysAgo(13),
      daysAgo(12),
      shortTermDisbursed,
      shortTermDue,
      JSON.stringify({
        terms: {
          principal: 5_000_000,
          flatRate: config.shortTermLoan.flatRate,
          days: 14,
          disbursedOn: shortTermDisbursed,
          mode: config.shortTermLoan.interestMode,
        },
        fee: 250_000,
        totalRepayable: 5_250_000,
        dueOn: shortTermDue,
        annualisedRate: (250_000 / 5_000_000) * (365 / 14),
      }),
      nowISO(),
    );

    db.prepare(
      `INSERT INTO pledges (id, loan_id, sponsor_id, amount, status, requested_on, responded_on, expires_on, created_at)
       VALUES (?, 'loan_04', 'mem_26', ?, 'accepted', ?, ?, ?, ?)`,
    ).run(newId('pl'), 5_000_000, daysAgo(13), daysAgo(13), daysAgo(10), nowISO());

    post(db, book, {
      ...disbursementEntry(
        { id: newId('je'), date: shortTermDisbursed },
        { loanId: 'loan_04', memberId: 'mem_25', principal: 5_000_000 },
      ),
    });

    log(`Loan 04 — ${money(5_000_000)} short-term to ${NAMES[24]}, flat fee ${money(250_000)}`);

    // A loan still gathering sponsors, so the apps have a live one to show.
    db.prepare(
      `INSERT INTO loans
         (id, member_id, product, principal, purpose, status, monthly_rate, term_months, principal_step,
          coverage_ratio, applied_on, created_at)
       VALUES ('loan_05', 'mem_28', 'term', ?, ?, 'awaiting_sponsors', ?, 3, ?, ?, ?, ?)`,
    ).run(
      15_000_000,
      'Expanding the poultry unit before the festive demand',
      config.termLoan.monthlyInterestRate,
      config.termLoan.minimumMonthlyPrincipalRate,
      config.sponsorship.coverageRatio,
      daysAgo(2),
      nowISO(),
    );

    for (const [sponsorId, amount, status] of [
      ['mem_29', 5_000_000, 'accepted'],
      ['mem_30', 5_000_000, 'pending'],
      ['mem_27', 3_000_000, 'pending'],
    ] as const) {
      const expiresOn = addDays(anchor, 1);

      db.prepare(
        `INSERT INTO pledges (id, loan_id, sponsor_id, amount, status, requested_on, expires_on, created_at)
         VALUES (?, 'loan_05', ?, ?, ?, ?, ?, ?)`,
      ).run(newId('pl'), sponsorId, amount, status, daysAgo(2), expiresOn, nowISO());

      if (status === 'pending') {
        notify(db, {
          memberId: sponsorId,
          kind: 'sponsorship_request',
          title: `${NAMES[27]} has asked you to sponsor a loan`,
          body:
            `${NAMES[27]} is applying for ${money(15_000_000)} and has asked you to stand behind ` +
            `${money(amount)} of it. You have until ${expiresOn} to answer.`,
          actionUrl: '/sponsorships',
        });
      }
    }

    log(`Loan 05 — ${money(15_000_000)} to ${NAMES[27]}, still gathering sponsors`);

    // -----------------------------------------------------------------------
    // 5. Snapshots, so investor returns accrue against the real path
    // -----------------------------------------------------------------------

    // One reading per month of history, plus every date money actually moved,
    // so the investor's accrual follows the real path of the book.
    const snapshotDates = new Set<string>([START, facilityFundedOn, anchor, shortTermDisbursed]);
    for (let back = HISTORY_MONTHS; back >= 0; back -= 1) {
      snapshotDates.add(ago(back));
      snapshotDates.add(`${monthKey(ago(back))}-28`);
    }

    for (const date of [...snapshotDates].sort()) {
      writeSnapshot(db, config, date);
    }

    // -----------------------------------------------------------------------
    // 6. An announcement and an open deletion proposal
    // -----------------------------------------------------------------------

    const noticePostedOn = daysAgo(4);

    db.prepare(
      'INSERT INTO announcements (id, title, body, posted_by, posted_on, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'ann_01',
      'Monthly meeting moved to the 22nd',
      'The monthly meeting moves to Saturday the 22nd at 14:00, at the usual place.',
      'mem_03',
      noticePostedOn,
      nowISO(),
    );

    db.prepare(
      'INSERT INTO announcements (id, title, body, posted_by, posted_on, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'ann_02',
      'Monthly meeting moved to the 22nd',
      'Duplicate post — the same notice went up twice.',
      'mem_03',
      noticePostedOn,
      nowISO(),
    );

    db.prepare(
      `INSERT INTO proposals
         (id, kind, entity_type, entity_id, reason, proposed_by, opened_on, closes_on, status, created_at)
       VALUES ('prop_01', 'delete', 'announcement', 'ann_02', ?, 'mem_04', ?, ?, 'open', ?)`,
    ).run(
      'This is a duplicate of the notice posted the same morning and is confusing members',
      daysAgo(3),
      addDays(anchor, 1),
      nowISO(),
    );

    // Weight is whatever those members hold once contributions are counted.
    const weight = config.shares.minimumMembershipShares + contributionPeriods.length;

    for (const [memberId, choice] of [
      ['mem_01', 'for'],
      ['mem_02', 'for'],
      ['mem_03', 'for'],
      ['mem_06', 'for'],
      ['mem_07', 'abstain'],
    ] as const) {
      db.prepare(
        `INSERT INTO votes (proposal_id, member_id, choice, cast_on, weight, created_at)
         VALUES ('prop_01', ?, ?, ?, ?, ?)`,
      ).run(memberId, choice, daysAgo(2), weight, nowISO());
    }

    log('Posted an announcement and opened a deletion proposal with five votes cast');
  });

  // ---------------------------------------------------------------------------
  // Verify the books
  // ---------------------------------------------------------------------------

  const balance = trialBalance(buildBook(db));
  if (!balance.balanced) {
    throw new Error(
      `Seeded books do not balance: debits ${balance.totalDebits} against credits ${balance.totalCredits}`,
    );
  }

  const founding = config.shares.minimumMembershipShares * NAMES.length;
  const fromContributions = NAMES.length * contributionPeriods.length;
  const issued = founding + fromContributions;

  log('');
  log(`Books balance: ${money(balance.totalDebits)} of debits against the same in credits.`);
  log('');
  log('Sign in with any member phone number and the password "mamogoro123".');
  log(`  Chair:     ${NAMES[0]}`);
  log(`  Cashier:   ${NAMES[1]}`);
  log(`  Secretary: ${NAMES[2]}`);
  log(`  Investor:  ${NAMES[4]}`);

  return {
    startedOn: START,
    memberIds: NAMES.map((_, index) => `mem_${String(index + 1).padStart(2, '0')}`),
    contributionPeriods,
    issuedShares: issued,
    equityCapital: issued * config.shares.parValue,
    facilityPrincipal: 200_000_000,
  };
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const db = openDb();

  const existing = db.prepare('SELECT COUNT(*) AS n FROM members').get() as unknown as { n: number };
  if (existing.n > 0 && !process.argv.includes('--force')) {
    console.error(
      `This database already holds ${existing.n} members. Re-seeding would duplicate them.\n` +
        'Delete the database file first, or pass --force if you are certain.',
    );
    process.exit(1);
  }

  seed(db);
  db.close();
}
