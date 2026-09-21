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
                  sponsorship, governance, payments, capital, statements, the
                  approval gate and the ledger.               290 tests

apps/api          REST API. Node's built-in HTTP and node:sqlite — no native
                  build, no database server, no framework.   121 tests

apps/admin        The admin panel every member can sign into. Plain ES modules,
                  no build step. Served by the API. One module per workspace
                  under views/, shared pieces under lib/.

apps/mobile       The member app. Expo / React Native.

docs/             FINANCIAL-MODEL.md — every rule, worked through.
                  API.md — the endpoints.
```

**411 tests, all passing.** The financial rules are proved against the worked
examples the circle agreed, not against whatever the code happens to do.

---

## Running it

Requires Node 22.5 or later (for `node:sqlite`). Nothing else.

```bash
npm install
npm test                  # 411 tests across core and api
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
> `apps/api/data/mamogoro.db` and enrol real members before any circle uses
> this.
>
> **Set `MAMOGORO_SECRET`** (at least 16 characters) before deploying. It
> signs the session tokens. With it unset the server generates a random key
> for that process and says so, which means everyone is signed out whenever it
> restarts — deliberately, so an unconfigured deployment is obvious rather
> than quietly insecure. There is no default key to fall back on.

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

### But cover alone never approves a loan

Removing the committee removes the meeting, not the control. Between "fully
covered" and "approved" sit eight automatic checks, and a loan that fails any
of them does not go through however well sponsored it is:

| Gate | What it catches |
|---|---|
| Sponsor cover | The members have not finished deciding |
| Cover still live | Shares that were free in March and have since been pledged to somebody else |
| Borrower standing | Suspended, subscription incomplete, contributions behind |
| Platform subscription | Lapsed — borrowing and sponsoring only |
| Arrears | An existing loan already behind |
| Borrowing ceiling | Above what policy allows this member |
| Concentration | Would put too much of the book in one pair of hands |
| Spendable cash | The money is not actually in the account |

Every decision is written down with the whole gate list and the policy version
that produced it, approved or not — a member turned away by a rule is owed the
same explanation as one let through by it:

```
TSh 3,000,000 approved — every check passed
  ✓ Sponsor cover        TSh 3,000,000 against TSh 3,000,000 required
  ✓ Cover still live     TSh 3,000,000 genuinely uncommitted
  ✓ Borrower standing    In good standing
  ✓ Arrears              None
  ✓ Borrowing ceiling    TSh 3,000,000 against a ceiling of TSh 8,400,000
  ✓ Concentration        3.8% of the book, within the 25% limit
  ✓ Spendable cash       TSh 284,747,500 can go out today
  Policy version 2026.09
```

**Humans handle exceptions, not loans.** Exactly two gates can be authorised
past, and only by the chair: the policy ceiling and the concentration limit —
the cases where the rule is a number the members chose and this request sits
outside it. Somebody asking for TSh 80,000,000 against a TSh 50,000,000 ceiling
is exceptional, not ineligible, so the request still gathers sponsors and then
goes to one person with a reason recorded against their name.

Nobody may authorise past missing cover or missing cash. Those are not policies
to be relaxed; they are the facts the policy exists to protect. A fully covered
loan the circle cannot pay for waits in the funding queue instead — "we will,
when we can" is a better answer than a refusal.

On default the loss is absorbed in a fixed order: the borrower's own shares
first, then the sponsors' pro rata to what they pledged, then personal
receivables, and only what no pledge reached is written off against the circle.

Cover is released as the loan is repaid, not held until it closes. Once
TSh 10,000,000 of a TSh 50,000,000 loan has come back, each of its nine
sponsors carries TSh 4,000,000 rather than TSh 5,000,000 — freeing
TSh 9,000,000 of capacity to back the next borrower.

**And that is the only way cover comes back on its own.** A sponsor cannot ask
to be released. If they want their capacity back before the loan runs its
course they must pay the cover they are still carrying, and that money stands
in place of their shares — released back to them on the same proportional rule,
taken first if the borrower defaults. A guarantee somebody can walk out of when
it starts to look risky is not a guarantee; it is a promise that holds only
while it costs nothing, which is exactly when the borrower does not need it.
The borrower is untouched either way: their schedule is what they agreed, and
it does not move because somebody else lost their nerve.

### Before a request reaches anyone, the fee is paid

A borrower pays a fixed **TSh 50,000** for their request to be circulated to
sponsors. KobeTech collects it over USSD, keeps 5%, and remits TSh 47,500 to
the circle — and only that net ever touches the books, because the circle never
held the rest. It is a liability until the loan is decided and becomes income
only on approval; if the loan does not go ahead, the net is refunded.

Each member also pays KobeTech a monthly subscription to use the platform.
That is the operator's revenue and never appears in the circle's ledger. If it
lapses, borrowing and sponsoring are withheld — but never reading, repaying or
voting.

### A surplus is not money in the account

The income statement says whether the circle made a surplus; the cash flow
statement says whether it has anything to show for it. They are different
questions, and a circle that only reads the first one is the circle that finds
out at a meeting that it cannot fund the loan it has just approved.

Three sections, named for what the members actually do rather than for a
textbook: **lending** (money out to borrowers, principal back), **earnings**
(interest and fees received, less running costs and the investor's return), and
**capital** (subscriptions, savings and facilities). A circle funding its
lending out of earnings is compounding; one funding it out of capital is
growing on money it will have to give back — the same closing balance, a
completely different position.

Nothing is accumulated separately: every figure is read off the cash lines of
entries already posted, so `opening + movement = closing` is a fact about the
ledger rather than a second opinion about it. The page says whether it ties
back, and would say so loudly if it did not.

Each member also has a statement of their own: every shilling that passed
between them and the circle, signed from their point of view rather than the
ledger's, with a running total and their live position — shares held, principal
still owed, and cover still locked after repayments released the rest. Every
member can read every other member's, for the same reason they can read the
ledger.

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
only the secretary and chair can enrol members, and only the chair can enrol
somebody *as* an officer — whoever enrols an account sets its password, so
that restriction is what stops a secretary appointing themselves. Deleting is
nobody's privilege: it goes to a vote.

**Authorisation reads the member's current row, not the token.** Roles and
memberships change, and a token lasts twelve hours. Standing is looked up on
every request so an officer who has been stood down stops having the power
immediately rather than when their token expires.

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
