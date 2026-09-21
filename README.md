# Mamogoro Circles

[![CI](https://github.com/KobepayTech/moscoOs-/actions/workflows/ci.yml/badge.svg?branch=claude/mamogoro-circles-platform-7k4sfb)](https://github.com/KobepayTech/moscoOs-/actions/workflows/ci.yml)

A circles operating system: a savings-and-lending circle (chama / stokvel) run
as software, with share capital, member contributions, sponsor-underwritten
lending, external investor facilities, a public double-entry ledger, and
deletion by member vote.

Thirty members, fifty shares each at TSh 100,000 — TSh 150,000,000 of share
capital. Members borrow against cover pledged by other members. An investor may
lend the circle further capital and is paid a return on the part of it the
circle actually lends out. Every member can read every entry in the books.

---

## What is here

```
packages/core     The domain engine. Pure TypeScript, no I/O, no dependencies.
                  Money, shares, interest, amortisation, the facility waterfall,
                  sponsorship, governance and the ledger.     173 tests

apps/api          REST API. Node's built-in HTTP and node:sqlite — no native
                  build, no database server, no framework.    44 tests

apps/admin        The admin panel every member can sign into. Plain ES modules,
                  no build step. Served by the API.

apps/mobile       The member app. Expo / React Native.

docs/             FINANCIAL-MODEL.md — every rule, worked through.
                  API.md — the endpoints.
```

**217 tests, all passing.** The financial rules are proved against the worked
examples the circle agreed, not against whatever the code happens to do.

---

## Running it

Requires Node 22.5 or later (for `node:sqlite`). Nothing else.

```bash
npm install
npm test                  # 217 tests across core and api
npm run seed              # a circle with eight months of history
npm run dev:api           # http://localhost:4000
```

Then open **http://localhost:4000/** and sign in with any seeded member's phone
number and the password `mamogoro123`:

| Role | Name | Phone |
|---|---|---|
| Chair | Amani Mushi | `+255710000000` |
| Cashier | Neema Kileo | `+255710000137` |
| Secretary | Baraka Shirima | `+255710000274` |
| Investor | Juma Mbwana | `+255710000548` |
| Borrower (the 50M loan) | Elia Swai | `+255710000822` |

> The seed is demonstration data with a shared password. Delete
> `data/mamogoro.db` and enrol real members before any circle uses this.
> Set `MAMOGORO_SECRET` in production — the server refuses to start with the
> development signing key when `NODE_ENV=production`.

### The member app

```bash
cd apps/mobile
npm install
npm start                 # then scan the QR with Expo Go
```

Point it at your API by editing `expo.extra.apiUrl` in `app.json`. On a
physical device that must be your machine's LAN address, not `localhost`.

---

## The rules, in brief

The full derivation is in [docs/FINANCIAL-MODEL.md](docs/FINANCIAL-MODEL.md).

### Shares

Fifty shares at TSh 100,000 is what a seat costs — TSh 5,000,000. Shares decide
three things at once: who is a member, what they earn from the circle, and what
they stand to lose when they sponsor someone. The monthly TSh 100,000
contribution buys one more share, so a member's stake grows every month they
pay.

### The lending rate is derived, not chosen

Every shilling of interest has four calls on it: the return owed to external
capital, the circle's running costs, the loans that will not come back, and the
growth the members want on their own capital. Solving that identity against the
founding capital structure gives **2.34% a month**, published as **2.5%**.

Idle money is the real risk, not the rate. A circle lending out only 40% of its
capital would need 3.75% a month on what it does lend to stand still.
`/rate-model` shows the whole derivation and the sensitivity table.

### The loan schedule

Whatever you take, you return 10% of it every month; the interest is collected
inside those payments; and the final payment is flat, with no interest on it.

For TSh 50,000,000 over three months at 2.5%:

| # | Due | Principal | Interest | Total |
|---|---|---|---|---|
| 1 | +1 month | 5,000,000 | 1,125,000 | **6,125,000** |
| 2 | +2 months | 5,000,000 | 1,125,000 | **6,125,000** |
| 3 | +3 months | 5,000,000 | 1,125,000 | **6,125,000** |
| Final | +3 months | 35,000,000 | **0** | **35,000,000** |

Interest is charged on the declining balance, not flat on the original
principal — TSh 3,375,000 rather than TSh 3,750,000. Settle early and the
unearned portion is rebated, so repaying quickly is never a penalty.

### External capital earns only when it is used

A member may lend the circle money rather than buy shares with it. That is a
*facility*: a liability, not capital. It does not dilute anyone and carries no
vote.

Lending draws the members' own capital first. With TSh 150,000,000 of equity
and a TSh 200,000,000 facility:

| Lending out | Facility at work | Investor earns |
|---|---|---|
| 150,000,000 | 0 | nothing |
| **200,000,000** | **50,000,000** | on 50,000,000 |
| 350,000,000 | 200,000,000 | on all of it |

Utilisation is accrued day by day against a reading of the book taken on every
disbursement and every repayment — an audit of what happened, not an estimate.

### Loans are underwritten by members, not by a committee

A borrower asks other members to stand behind a named amount of the loan. Each
one's shares are on the line if it defaults. When the pledges cover the loan,
**it approves itself** — there is no committee decision left to make, and the
cashier is simply told to pay it out.

On default the loss is absorbed in a fixed order: the borrower's own shares
first, then the sponsors' pro rata to what they pledged, then personal
receivables, and only what no pledge reached is written off against the circle.

### Deletion is by vote — except the books

Any member can propose that a record be removed. It carries when half the
shares vote and two-thirds of those cast are in favour. Weight follows shares.

**Financial records are never deleted, only reversed.** A vote against a ledger
entry posts a balancing reversal and marks the original void; the original
stays visible with the resolution attached. A circle whose books can be edited
by majority is a circle whose books mean nothing.

---

## Design notes

**Money is integers.** Every amount is a whole number of shillings. A circle's
books must reconcile to the shilling, not to "close enough". Any crossing from
a rate back to an amount goes through `applyRate` or `allocate`, both of which
round deterministically; `allocate` uses largest-remainder so a dividend run or
a loss cascade never leaves an orphaned shilling.

**State is derived, never stored.** The share register, the ledger and every
loan's position are rebuilt from recorded history on each request. There are no
mutable balance columns that could drift away from the transactions that
produced them.

**The schedule is frozen at disbursement.** What a member owes is fixed when
they receive the money. A later change to the circle's rate cannot reach back
and alter it.

**The domain engine has no dependencies and no I/O.** That is what makes the
rules testable against the worked examples directly, rather than through a
database and an HTTP stack.

**Reading is open, recording is not.** Every member can sign into the admin
panel and see everything. Only the cashier and chair can record money moving;
only the secretary and chair can enrol members. Deleting is nobody's privilege
— it goes to a vote.

---

## Choices worth flagging to the circle

Three places where the implementation follows the rule as agreed, but the
committee may want to look again:

1. **Short-term loans are expensive in annualised terms.** A flat 5% over five
   days annualises to 365%, against 30% for a term loan. The product is
   implemented exactly as specified and the annualised figure is shown on every
   quote, so nobody takes one blind. Setting
   `shortTermLoan.interestMode: 'prorated'` makes the charge scale with
   duration instead — the same 5% window then costs TSh 41,667 for five days
   rather than TSh 250,000. Both modes are implemented and tested.

2. **The balloon and the last instalment fall on the same day.** Following the
   rule literally (three instalments, *then* the flat remainder) puts
   TSh 41,125,000 due in month three. That matches the trade cycle the loan is
   written against, but `termLoan.balloonGraceDays` can push the balloon a
   fortnight later if members would rather separate them.

3. **The concentration ceiling does not bind on a standard seat.** It cannot —
   the first member to subscribe holds 100% of a one-member register. Only
   holdings beyond the 50-share minimum are constrained.

---

## Configuration

Every number the circle can argue about lives in
`packages/core/src/config.ts`, and can be changed without touching a line of
logic. `validateConfig()` refuses combinations that contradict each other —
most importantly a lending rate at or below the cost of external capital, which
would make every facility-funded loan lose money.

Live changes go through `PATCH /config` (chair only).

---

## Licence

Unpublished. All rights reserved.
