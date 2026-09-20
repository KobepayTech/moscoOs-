/**
 * The circle at a glance, plus the rate model.
 *
 * `/dashboard` is what the admin panel opens on and what a chair would read
 * out at a meeting. `/rate-model` exposes the derivation behind the lending
 * rate, so the committee can see what the number is made of and what happens
 * if lending slows down.
 */

import {
  accrueFacilityInterest,
  breakEvenUtilisation,
  deriveSustainableRate,
  facilityOutstanding,
  financialPosition,
  formatMoney,
  incomeStatement,
  issuedCapital,
  lendingHeadroom,
  mergeConfig,
  netAssetValuePerShare,
  projectEquityGrowth,
  rateInputsFromConfig,
  rateSensitivity,
  splitUtilisation,
  summariseRegister,
  today,
  trialBalance,
} from '@mamogoro/core';

import {
  buildBook,
  buildRegister,
  loadConfig,
  loadFacilities,
  loadSnapshots,
  loanPosition,
  saveConfig,
  totalDeployed,
  type LoanRow,
} from '../circle.js';
import { type Db } from '../db.js';
import { type Router } from '../http.js';

export function registerDashboardRoutes(router: Router, db: Db): void {
  router.get('/config', () => loadConfig(db));

  router.patch(
    '/config',
    ({ body }) => {
      const current = loadConfig(db);
      return saveConfig(db, mergeConfig(current, (body ?? {}) as never));
    },
    { roles: ['chair'] },
  );

  router.get('/health', () => ({ ok: true, at: new Date().toISOString() }), { public: true });

  /**
   * The circle's position, in the terms members actually discuss it.
   */
  router.get('/dashboard', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();

    const register = buildRegister(db, config, asOf);
    const book = buildBook(db, asOf);
    const facilities = loadFacilities(db);

    const equityPool = issuedCapital(register);
    const deployed = totalDeployed(db, asOf);
    const split = splitUtilisation(equityPool, deployed, facilities, asOf, config.facility.allocation);
    const headroom = lendingHeadroom(config, equityPool, deployed, facilities, asOf);
    const income = incomeStatement(book);
    const position = financialPosition(book, asOf);
    const balance = trialBalance(book, asOf);

    const loans = db.prepare('SELECT * FROM loans').all() as unknown as LoanRow[];
    const live = loans.filter((loan) => loan.status === 'disbursed');

    let inArrears = 0;
    let arrearsAmount = 0;
    for (const loan of live) {
      const state = loanPosition(db, config, loan, asOf);
      if (state.product === 'term') {
        if (state.state.status === 'in_arrears' || state.state.status === 'defaulted') {
          inArrears += 1;
          arrearsAmount += state.state.arrears;
        }
      } else if (state.state.status === 'overdue') {
        inArrears += 1;
        arrearsAmount += state.state.payoffAmount;
      }
    }

    const snapshots = loadSnapshots(db);
    const accrual =
      facilities.length > 0 && snapshots.length > 0
        ? accrueFacilityInterest(facilities, snapshots, {
            from: snapshots[0].date,
            to: asOf,
            accrualBasisDays: config.facility.accrualBasisDays,
            allocation: config.facility.allocation,
          })
        : null;

    return {
      asOf,
      circle: { name: config.circleName, currency: config.currency },

      membership: {
        ...summariseRegister(register),
        active: (
          db.prepare("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").get() as unknown as {
            n: number;
          }
        ).n,
        netAssetValuePerShare: netAssetValuePerShare(register, income.surplus),
      },

      capital: {
        equityPool,
        facilityCommitted: facilities.reduce((total, f) => total + facilityOutstanding(f), 0),
        totalCapital: headroom.totalCapital,
        deployed,
        available: headroom.available,
        utilisationRatio: headroom.utilisationRatio,
        maxSingleLoan: headroom.maxSingleLoan,
        equityUtilised: split.equityUtilised,
        facilityUtilised: split.facilityUtilisedTotal,
        facilityIdle: split.facilityIdle,
      },

      lending: {
        total: loans.length,
        awaitingSponsors: loans.filter((loan) => loan.status === 'awaiting_sponsors').length,
        awaitingDisbursement: loans.filter((loan) => loan.status === 'approved').length,
        live: live.length,
        settled: loans.filter((loan) => loan.status === 'settled').length,
        defaulted: loans.filter((loan) => loan.status === 'defaulted').length,
        inArrears,
        arrearsAmount,
        portfolioAtRisk: deployed === 0 ? 0 : arrearsAmount / deployed,
      },

      performance: {
        income,
        position,
        investorReturnAccrued: accrual?.totalInterestAccrued ?? 0,
        booksBalance: balance.balanced,
      },

      governance: {
        openProposals: (
          db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'").get() as unknown as {
            n: number;
          }
        ).n,
      },

      headline:
        `${formatMoney(deployed, config.currency)} of ${formatMoney(headroom.totalCapital, config.currency)} ` +
        `is out on loan (${(headroom.utilisationRatio * 100).toFixed(1)}%). ` +
        `${formatMoney(headroom.available, config.currency)} is free to lend.`,
    };
  });

  /**
   * Where the lending rate comes from.
   *
   * Recomputed against the circle's *current* capital, so the committee can
   * see whether the published rate still covers what it has to cover as the
   * capital base changes.
   */
  router.get('/rate-model', ({ query }) => {
    const config = loadConfig(db);
    const asOf = query.get('asOf') ?? today();

    const register = buildRegister(db, config, asOf);
    const facilities = loadFacilities(db);

    const equityCapital = issuedCapital(register) || config.shares.parValue * config.shares.minimumMembershipShares * config.targetMembership;
    const facilityCapital = facilities.reduce((total, f) => total + facilityOutstanding(f), 0);

    const inputs = rateInputsFromConfig(config, { equityCapital, facilityCapital });
    const model = deriveSustainableRate(inputs);
    const published = config.termLoan.monthlyInterestRate;

    return {
      asOf,
      capital: { equityCapital, facilityCapital },
      model,
      publishedRate: published,
      /** True when the rate the circle charges still covers what it must. */
      publishedRateIsSufficient: published >= model.recommendedMonthlyRate,
      breakEven: breakEvenUtilisation(inputs, published),
      sensitivity: rateSensitivity(inputs),
      projection: projectEquityGrowth(inputs, published, {
        months: 12,
        monthlyContributionsTotal:
          config.membership.monthlyContribution *
          (db.prepare("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").get() as unknown as {
            n: number;
          }).n,
      }),
      explanation: explainRate(config, model, published),
    };
  });

  /** Re-derive the rate and, optionally, adopt it. */
  router.post(
    '/rate-model/adopt',
    () => {
      const config = loadConfig(db);
      const register = buildRegister(db, config);
      const facilities = loadFacilities(db);

      const inputs = rateInputsFromConfig(config, {
        equityCapital: issuedCapital(register),
        facilityCapital: facilities.reduce((total, f) => total + facilityOutstanding(f), 0),
      });
      const model = deriveSustainableRate(inputs);

      const updated = saveConfig(db, {
        ...config,
        termLoan: { ...config.termLoan, monthlyInterestRate: model.publishedMonthlyRate },
      });

      return {
        previousRate: config.termLoan.monthlyInterestRate,
        adoptedRate: model.publishedMonthlyRate,
        model,
        note:
          'Existing loans keep the schedule frozen at their disbursement; this rate applies to new lending only.',
        config: updated,
      };
    },
    { roles: ['chair'] },
  );
}

function explainRate(
  config: ReturnType<typeof loadConfig>,
  model: ReturnType<typeof deriveSustainableRate>,
  published: number,
): string {
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  const money = (amount: number) => formatMoney(amount, config.currency);

  const parts = [
    `Of every shilling lent, ${pct(model.components.costOfExternalCapital)} a month goes to external capital,`,
    `${pct(model.components.operatingCost)} to running costs,`,
    `${pct(model.components.expectedCreditLoss)} to expected losses,`,
    `and ${pct(model.components.equityGrowthTarget)} to the members' own return.`,
    `That adds to ${pct(model.recommendedMonthlyRate)} a month, published as ${pct(published)}.`,
    `At ${pct(model.inputs.targetUtilisation)} utilisation the circle expects a surplus of`,
    `${money(model.projectedMonthlySurplus)} a month.`,
  ];

  return parts.join(' ');
}
