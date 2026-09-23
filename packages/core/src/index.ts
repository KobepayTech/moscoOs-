/**
 * @mamogoro/core — the domain engine behind Mamogoro Circles.
 *
 * Everything here is pure: no I/O, no database, no clock of its own. The API
 * layer supplies the facts (who holds what, what was paid when) and this
 * decides what follows from them. That separation is what makes the circle's
 * rules testable against the worked examples the members agreed, rather than
 * being scattered through request handlers.
 *
 * Start with `docs/FINANCIAL-MODEL.md` for the reasoning; start with
 * `amortisation.ts` for the code.
 */

export * from './money.js';
export * from './dates.js';
export * from './config.js';
export * from './rate.js';
export * from './amortisation.js';
export * from './shares.js';
export * from './facility.js';
export * from './sponsorship.js';
export * from './governance.js';
export * from './ledger.js';
export * from './eligibility.js';
export * from './payments.js';
export * from './capital.js';
export * from './statements.js';
export * from './approval.js';
export * from './settlement.js';

export const CORE_VERSION = '0.1.0';
