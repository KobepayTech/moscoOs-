# Working in this repository

Mamogoro Circles is a savings-and-lending circle (chama / stokvel) run as
software. Read `docs/FINANCIAL-MODEL.md` before changing anything that touches
money — every rule in it was specified by the circle's members and is proved
against their own worked examples.

## Commands

```bash
npm install              # workspaces: packages/core, apps/api, apps/admin, apps/mobile
npm test                 # 457 tests — core (309) then api (148)
npm run seed             # a circle with eight months of history; asserts the books balance
npm run dev:api          # API + admin panel on http://localhost:4000

npm test --workspace @mamogoro/core    # just the engine
npx tsc -p packages/core/tsconfig.json --noEmit
cd apps/mobile && npm start            # Expo
```

Node 22.5+ is required — the API uses `node:sqlite`, which is built in. There
is no native build step and no database server.

The seeded circle signs in with any member's phone number and the password
`mamogoro123`. The chair is `+255710000000`, the cashier `+255710000137`.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | The domain engine. Pure, no I/O, no dependencies. |
| `apps/api` | REST API. `node:http` + `node:sqlite`, no framework. |
| `apps/admin/public` | Admin panel: plain ES modules, no build step, served by the API. `app.js` is the shell only — the route table, the frame and start-up. Each workspace is a module in `views/`; what they share is in `lib/`. |
| `apps/mobile` | Member app: Expo / React Native. |

Build output nests under `dist/src/` (the tsconfig `rootDir` is `.` so tests
compile alongside source). Entry points are `dist/src/server.js` and
`dist/src/seed.js`, not `dist/server.js`.

## Invariants — do not break these

**Money is integer shillings.** Never a float, never a decimal string. Crossing
from a rate back to an amount goes through `applyRate` or `allocate` in
`money.ts`; `allocate` uses largest-remainder so split amounts always sum to
exactly the total.

**State is derived, never stored.** The share register, the ledger and every
loan's position are rebuilt from recorded history on each request
(`circle.ts`). There are no mutable balance columns. If you are tempted to add
one, cache on the last transaction id instead.

**A loan's schedule is frozen at disbursement.** It is serialised into
`loans.schedule_json` and read back from there. A later change to the circle's
rate must never alter what an existing borrower agreed to.

**The ledger is append-only.** `postEntry` refuses anything that does not
balance. Corrections are reversals (`reverseEntry`), never edits or deletes.
A governance vote against a financial record produces a reversal and marks the
original void — it stays visible.

**Approval is a state transition, not a decision.** A loan approves itself in
`POST /sponsorships/:id/respond`. Do not add a committee step.

**But cover alone never approves a loan.** `assessApproval` in `approval.ts`
runs eight gates between "fully covered" and "approved": cover, cover still
live, borrower standing, subscription, arrears, ceiling, concentration and
spendable cash. Every decision is recorded with the gate list and a policy
version (`loan_decisions`), because an automated decision that cannot explain
itself is worse than a committee.

**Only two gates may be authorised past**, and only by the roles in
`approval.exceptionAuthorisers`: the policy ceiling and the concentration
limit. Nobody may authorise past missing cover or missing cash — those are not
policies to relax, they are the facts the policy protects. Never add a gate to
`exceptionableGates` without saying why in `FINANCIAL-MODEL.md`.

**PalmPesa collects; KobePay receives.** PalmPesa is the only rail that talks
to a handset, implemented against the contract KobeOS runs
(`server/src/creators/palmpesa.service.ts` in that repo). KobePay is a
settlement *account*, not a service — there is no payout endpoint anywhere, so
never add a "KobePay provider". Settlement is imported and matched
(`settlement.ts`). PalmPesa cannot refund; a refund is a manual payout recorded
against the intent.

**Callbacks are verified over the raw bytes.** `x-webhook-signature` is
`HMAC-SHA256(`${WEBHOOK_SECRET}:${provider}`, rawBody)`, matching KobeOS so one
sender reaches both. Never re-serialise the parsed body to check a signature,
never add a default secret, and never compare digests with `!==`. A `PENDING`
callback is not a confirmation.

**A sponsor cannot be released except by paying their cover.** Cover comes back
one way as a matter of course: the borrower repays. The only other exit is
`buyoutQuote` — pay what you are still carrying, and the cash stands in place
of your shares. A guarantee somebody can walk out of when it starts to look
risky is not a guarantee.

## Conventions

- The engine is pure and takes a date rather than reading a clock. Pass `asOf`.
- Every config number lives in `packages/core/src/config.ts`. Changing policy
  should never mean changing logic. `validateConfig` rejects contradictory
  combinations.
- Route role guards: `CASHIER_ROLES` for anything that records money,
  `REGISTRAR_ROLES` for enrolment. Reading is open to every member.
- Admin panel: everything interpolated into `innerHTML` goes through `esc()`.
- Tests assert the circle's own worked examples (a TSh 50,000,000 loan pays
  TSh 6,125,000 a month then a flat TSh 35,000,000). If a change makes one of
  those fail, the change is wrong until the members say otherwise.

## Where things are

- Loan maths: `packages/core/src/amortisation.ts`
- Investor utilisation waterfall: `packages/core/src/facility.ts`
- Sponsor cover and the default cascade: `packages/core/src/sponsorship.ts`
- Rate derivation: `packages/core/src/rate.ts`
- Voting and what may be deleted: `packages/core/src/governance.ts`
- Lendable capital, forecasts and concentration: `packages/core/src/capital.ts`
- Application fee and subscription: `packages/core/src/payments.ts`
- Cash flow and member statements: `packages/core/src/statements.ts`
- The approval gate and exceptions: `packages/core/src/approval.ts`
- Settlement matching: `packages/core/src/settlement.ts`
- Payment rails: `apps/api/src/providers.ts`
- Storage ↔ engine bridge: `apps/api/src/circle.ts`
