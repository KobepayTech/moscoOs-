# The Mamogoro financial model

Every rule the circle operates by, with the arithmetic worked through. Each
section names the module that implements it and the test file that proves it.

All amounts are Tanzanian shillings (TZS), held as whole integers. Nothing in
this system is stored as a floating-point amount of money.

---

## 1. Shares and membership

**Implemented in** `packages/core/src/shares.ts` · **proved in** `test/shares.test.ts`

| | |
|---|---|
| Par value of one share | TSh 100,000 |
| Shares required to join | 50 |
| Capital a member brings | **TSh 5,000,000** |
| Authorised share capital | 1,000,000 shares |
| Founding membership | 30 members |
| Shares in issue at founding | 30 × 50 = **1,500** |
| Share capital at founding | **TSh 150,000,000** |

Shares do three jobs at once, which is why the register has to serve all three
without contradiction:

1. **Admission.** Fifty shares is what a seat costs.
2. **Entitlement.** Surplus is split by holding, so shares decide what a member
   earns.
3. **Collateral.** A sponsor who is called on has their shares diluted, so
   shares are also what a member stands to lose.

### Concentration limit

No member may hold more than 25% of the shares in issue — a circle where one
member holds the majority is not a circle.

The limit does **not** apply to a member taking up their standard 50-share
seat. It cannot: the first member to subscribe necessarily holds 100% of a
one-member register, and the fourth still holds 25%. Enforcing the ratio there
would make the circle impossible to found. Only holdings *beyond* the
membership minimum count as concentration.

### Monthly contributions buy shares

The TSh 100,000 monthly contribution is exactly one share at par. A member's
stake therefore grows every month they pay, rather than sitting in a savings
balance. (Set `membership.monthlyContributionBuysShares: false` for a circle
that prefers a savings balance.)

After eight months, a founding member holds 58 shares — 50 subscribed plus 8
contributed.

---

## 2. The lending rate

**Implemented in** `packages/core/src/rate.ts` · **proved in** `test/rate.test.ts`

The rate is not chosen by feel. Every shilling of interest a borrower pays has
four calls on it, and the rate is whatever makes them add up.

Over one month, with `A` the average earning assets (capital actually out on
loan), `F_u` the average *utilised* facility balance and `E` the members'
equity:

```
r_L · A  +  other income  =  r_inv · F_u  +  opex  +  ecl · A  +  g · E
```

so

```
        r_inv · F_u  +  opex  +  g · E  -  other income
r_L  =  ───────────────────────────────────────────────  +  ecl
                              A
```

Idle capital is what makes this bite. If only 85% of the money is ever out on
loan, the 15% sitting in the account owes the investor nothing but still has to
be carried by the 85% that is working — which is why `A` is
utilisation-weighted while `E` is not.

### The founding numbers

| Input | Value |
|---|---|
| Member equity `E` | TSh 150,000,000 |
| Facility committed `F` | TSh 200,000,000 |
| Target utilisation | 85% |
| Investor rate `r_inv` | 1.00% / month |
| Running costs `opex` | TSh 2,000,000 / month |
| Expected credit loss `ecl` | 2% / year = 0.1667% / month |
| Members' target return `g` | 24% / year = 2% / month |

Earning assets: `0.85 × 350,000,000 = 297,500,000`

Lending draws equity first, so of that 297,500,000:
- equity at work: 150,000,000
- facility at work: **147,500,000**

```
r_L = (0.01 × 147,500,000 + 2,000,000 + 0.02 × 150,000,000) / 297,500,000 + 0.001667
    = (1,475,000 + 2,000,000 + 3,000,000) / 297,500,000 + 0.001667
    = 6,475,000 / 297,500,000 + 0.001667
    = 0.021765 + 0.001667
    = 0.023432
```

**≈ 2.34% a month**, rounded up to the published rate of **2.5% a month**
(30% nominal a year, 34.5% effective).

### What each component pays for

At 2.5%/month, of every shilling of interest:

| Component | Monthly rate | Share of the rate |
|---|---|---|
| Cost of external capital | 0.496% | 20% |
| Running costs | 0.672% | 27% |
| Expected losses | 0.167% | 7% |
| Members' target return | 1.008% | 40% |
| *Rounding surplus* | *0.157%* | *6%* |

### Idle money is the real risk

`rateSensitivity()` shows what happens as lending slows:

| Utilisation | On loan | Break-even rate | Rate needed |
|---|---|---|---|
| 40% | 140.0M | 1.595% | **3.750%** |
| 60% | 210.0M | 1.405% | **3.000%** |
| **85%** | **297.5M** | **1.335%** | **2.500%** |
| 100% | 350.0M | 1.310% | **2.250%** |

A circle lending out only 40% of its capital would need **3.75% a month** on
what it does lend — half again the published rate — to pay the same investor
and hit the same target. The committee should watch utilisation more closely
than it watches the rate.

`breakEvenUtilisation()` reports the floor: below **24.5%** utilisation (about
TSh 85,700,000 on loan), a 2.5% rate stops covering costs and the members' own
capital starts subsidising the lending.

---

## 3. The Mamogoro loan schedule

**Implemented in** `packages/core/src/amortisation.ts` · **proved in** `test/amortisation.test.ts`

The founding rule: *whatever you take, you return at least 10% of it every
month; the interest is collected inside those monthly payments; and the final
payment is flat — principal only, with no interest riding on it.*

### The worked example: TSh 50,000,000 over three months at 2.5%

**Step 1 — the scheduled principal path.** 10% of the original principal each
month:

| Month | Opening balance | Principal returned |
|---|---|---|
| 1 | 50,000,000 | 5,000,000 |
| 2 | 45,000,000 | 5,000,000 |
| 3 | 40,000,000 | 5,000,000 |

**Step 2 — interest on the declining balance.** Not flat on the original
principal: the borrower is charged for money they actually had.

```
month 1:  50,000,000 × 2.5%  =  1,250,000
month 2:  45,000,000 × 2.5%  =  1,125,000
month 3:  40,000,000 × 2.5%  =  1,000,000
                              ───────────
total interest                  3,375,000
```

(Flat interest would have been 50,000,000 × 2.5% × 3 = 3,750,000. The declining
balance saves the borrower 375,000 for following the schedule.)

**Step 3 — levelise.** The interest is spread evenly across the three
instalments, so the member has one number to remember:

```
instalment = 5,000,000 + 3,375,000 ÷ 3
           = 5,000,000 + 1,125,000
           = 6,125,000 a month
```

**Step 4 — the balloon.** After three instalments the member has returned
15,000,000 of principal and *every shilling of interest*. What is left falls
due at maturity, flat:

```
balloon = 50,000,000 − 15,000,000 = 35,000,000, interest-free
```

### The schedule

| # | Due | Opening | Principal | Interest | Total |
|---|---|---|---|---|---|
| 1 | +1 month | 50,000,000 | 5,000,000 | 1,125,000 | **6,125,000** |
| 2 | +2 months | 45,000,000 | 5,000,000 | 1,125,000 | **6,125,000** |
| 3 | +3 months | 40,000,000 | 5,000,000 | 1,125,000 | **6,125,000** |
| Final | +3 months | 35,000,000 | 35,000,000 | **0** | **35,000,000** |

```
Total repaid = 3 × 6,125,000 + 35,000,000 = 53,375,000
             = 50,000,000 principal + 3,375,000 interest  ✓
```

The engine refuses to build a schedule that does not reconcile exactly. That is
an assertion at build time, not a test-only check.

### Why front-load the interest?

Because the loan is written against a trade cycle: buy goods in January, they
arrive in late February, you sell through March and settle at the end. The
balloon is sized to the sale proceeds. Front-loading the interest means the
final payment is a number the borrower already knows and has been planning for,
with no charge added at the moment they are most stretched.

### Early settlement

Because interest is collected ahead of the calendar, a member who settles early
would otherwise be paying for months of borrowing that never happened.
`settlementQuote()` recomputes interest day by day on the balance actually
carried and rebates the difference.

Without this, early repayment would be a penalty — exactly the wrong incentive
for a circle that wants its capital recycled quickly.

Note that the rebate only arises when the member has paid *ahead of the
calendar*. Forty days into a three-month loan, having paid one instalment, a
borrower has slightly *under*paid interest relative to days elapsed, so the
payoff carries a small shortfall instead. Either way, settling early costs less
than running to maturity.

### Edge cases the engine handles

- **Over-stepped terms.** 60% a month over three months would repay 180% of
  principal if unchecked. Principal instalments are capped at what is
  outstanding, so the third month's principal is zero.
- **Full amortisation.** 10% a month over ten months leaves no balloon, and the
  balloon row is omitted entirely.
- **Month-end dates.** A loan taken on 31 January falls due 28 February, not
  3 March. Due dates clamp rather than drift.

---

## 4. Short-term loans

**Implemented in** `buildShortTermLoan()` · **proved in** `test/amortisation.test.ts`

A separate product: money out for days, repaid in one bullet with a flat charge.

| | |
|---|---|
| Maximum term | 30 days |
| Charge | flat 5% of the amount taken |
| Sponsor cover required | 100% |
| Concurrent loans per member | 1 |
| Cooling-off after settling | 7 days |
| Penalty | 0.5% a day overdue |

TSh 5,000,000 for five days costs TSh 250,000, repayable as TSh 5,250,000.

### A flag worth raising

A flat 5% charge is small in shillings but steep as an annual rate, because the
money is only out for days:

```
5% over 5 days  →  5% × (365 ÷ 5)  =  365% a year
5% over 30 days →  5% × (365 ÷ 30)  =  61% a year
```

Against the term loan's 30%/year, a five-day loan at a flat 5% is roughly
**twelve times more expensive** in annualised terms. The product is implemented
exactly as specified, because that is the rule the circle set — but
`annualisedRate` is returned on every quote and shown to the borrower, so
nobody takes one without seeing the number.

If the committee would rather the charge scale with duration, set
`shortTermLoan.interestMode: 'prorated'`. The same 5% over the same 30-day
window then costs TSh 41,667 for five days instead of TSh 250,000, and
annualises to 61% regardless of how long the money is out. Both modes are
implemented and tested; the choice is the circle's.

---

## 4a. Money that is not the circle's

Two flows run alongside the circle's own money and are deliberately kept apart
from it, because treating them as circle income would overstate what the
members have earned.

**Implemented in** `packages/core/src/payments.ts` · **proved in**
`test/payments.test.ts` and `apps/api/test/payments.test.ts`

### The loan application fee

A borrower pays **TSh 50,000** before their request is circulated to sponsors.
KobeTech collects it over USSD, keeps **5%**, and remits the rest to the
circle's KobePay account.

```
member pays ................. 50,000
KobeTech's charge (5%) ......  2,500
reaches the circle .......... 47,500
```

Three things follow from that, and all three are load-bearing:

**Only the net touches the books.** The circle receives 47,500 and never holds
the 2,500 — that was settled between the member and the rail. Posting the
gross would record money the circle never had.

**It is a liability, not income.** The fee is refundable until the loan is
decided, so on receipt it is credited to *Application fees held pending a
decision*. Only when the loan is approved has the circle done the thing the
member paid for, and only then does it become fee income:

| Event | Debit | Credit |
|---|---|---|
| Fee confirmed | Cash 47,500 | Application fees held 47,500 |
| Loan approved | Application fees held 47,500 | Fee income 47,500 |
| Loan cancelled | Application fees held 47,500 | Cash 47,500 |

**A refund returns the net.** The circle can only give back what it received.
The member is told this in the quote, before they pay, and again in the refund
notice.

The fee gates the *sponsor request*, not the application. A member can fill in
and price a loan for nothing; they pay when they are ready to ask other people
to put their shares behind it. Charging before the applicant knows what they
would repay would be charging for information they should have had free.

### The platform subscription

Each member pays **KobeTech** monthly, through PalmPesa, to use the software.
This never touches the circle's ledger at all: it is the operator's revenue
and the circle is not a party to it. The platform records it only to know who
may use the features it gates.

When a subscription lapses, the platform withholds **borrowing and
sponsoring** — and nothing else. A member whose software bill is unpaid can
still:

- see their own money, their loans and the whole ledger;
- repay what they owe;
- **vote**.

That line is deliberate. Locking someone out of their own savings over a
software bill would be indefensible, and a subscription billed by the operator
must not be able to disenfranchise a member inside their own circle. A member
is also given a grace period before a missed month counts as a lapse at all.

### Payments are safe to repeat

Every payment is an *intent* carrying an idempotency key. A USSD prompt the
member retries, a callback the rail delivers twice, a cashier who taps confirm
again — none of these charge twice or post twice. The key makes a repeated
request return the existing intent; a `ledger_entry_id` on the intent makes a
second posting impossible.

Callbacks are authenticated before they are believed. An unverified callback
would let anyone who can reach the endpoint credit any account.

---

## 5. External capital and the utilisation waterfall

**Implemented in** `packages/core/src/facility.ts` · **proved in** `test/facility.test.ts`

A member may put money into the circle two ways, and the difference matters:

- **buy shares** — and own more of the circle;
- **advance a facility** — and be repaid with a return.

A facility is a *loan to the circle*. It is a liability, not capital. It does
not dilute anyone and it carries no vote. If the investor also wants a bigger
share of the circle, that is a separate transaction against the register, and
the two must never be conflated — one dilutes the other members and the other
does not.

### What the investor is actually owed

Idle money earns nothing. Lending draws on member equity first; only once
lending passes the equity line does the facility start working, and the
investor is paid on the working part alone.

With TSh 150,000,000 of equity and a TSh 200,000,000 facility:

| Lending out | Equity at work | **Facility at work** | Investor earns |
|---|---|---|---|
| 50,000,000 | 50,000,000 | **0** | nothing |
| 150,000,000 | 150,000,000 | **0** | nothing |
| **200,000,000** | 150,000,000 | **50,000,000** | on 50,000,000 |
| 350,000,000 | 150,000,000 | **200,000,000** | on all of it |
| 500,000,000 | 150,000,000 | **200,000,000** | on all of it |

This is fair in both directions. The investor is not paid for money the circle
never used; the circle is not charged for capital sitting in its account.

It also gives the committee a sharp incentive that a flat return would not:
unused external capital costs *zero*, so the circle can safely hold a buffer —
but it only pays when it earns.

### Accrual follows the real path of the book

Utilisation moves every time a loan is disbursed or repaid, so the entitlement
is accrued **day by day** over the observed path, not estimated from a
month-end snapshot. The API writes a reading of the book on every disbursement
and every repayment; `accrueFacilityInterest()` walks those readings as a step
function.

```
daily accrual = utilised balance × (monthly rate × 12 ÷ 365)
```

For 50,000,000 working through a 31-day January at 1%/month:

```
50,000,000 × (0.12 ÷ 365) × 31 = TSh 509,589
```

### Several facilities at once

Facilities carry a `seniority`. Senior ranks fill first; facilities of equal
seniority share the tranche **pro rata by outstanding principal**, with any
shortfall from a capped facility spilling to the next rank.

When the circle *returns* capital, the order reverses: junior first, so the
senior lender stays in longest. Within each facility, accrued return is settled
before principal, so an investor whose money is being returned is never left
holding an unpaid entitlement on capital they no longer have in.

### Commitment period

A facility is committed for a minimum term (default three months from funding).
Capital cannot be called back before then without a resolution of the circle.
Without this, a circle could be left unable to fund loans it has already
approved.

---

## 6. Sponsorship and the default cascade

**Implemented in** `packages/core/src/sponsorship.ts` · **proved in** `test/sponsorship.test.ts`

The circle does not assess credit with a scorecard. It asks the borrower to
find members who will stand behind them, and those members put their own shares
on the line to do it.

A loan is approved when the pledges behind it cover the amount being lent — at
which point the committee has no discretion left to exercise, and the system
disburses. **Approval is a state transition, not a decision.**

That design converts the circle's credit risk into *member* risk, priced by the
members best placed to judge it. A member nobody will sponsor does not get a
loan, and no committee has to be the one to say so.

### Capacity

A member can only pledge what they could actually lose:

```
capacity = (shares held × par value)
         − already pledged to other live sponsorships
         − their own outstanding borrowing
```

Double-counting here is how guarantee schemes fail, so the arithmetic is
deliberately conservative: every shilling of cover is backed by a shilling of
share value that is not already spoken for. A member who has borrowed to their
limit cannot also underwrite.

### The founding example

A member borrowing TSh 50,000,000 needs TSh 50,000,000 of cover (1:1). Their
own 50 shares provide TSh 5,000,000, so they need about **nine other members**
at TSh 5,000,000 each.

Limits that apply:
- no sponsor may carry more than 50% of one loan;
- at most 20 sponsors per loan;
- requests expire after 72 hours.

Requests are validated against the sponsor's real capacity *before they are
sent*, so a sponsor is never asked to accept something the rules would then
reject. Capacity is re-checked at the moment of acceptance, excluding the
pledge being answered.

### Cover is released as the loan is repaid

A sponsor stands behind what can still be lost, and that shrinks with every
repayment. A pledge is therefore released in proportion to principal repaid:

```
still at risk = pledge × (principal outstanding ÷ original principal)
```

On a TSh 50,000,000 loan with nine sponsors at TSh 5,000,000 each, once
TSh 10,000,000 has come back each sponsor is carrying TSh 4,000,000 rather
than TSh 5,000,000 — and TSh 9,000,000 of cover across the circle is free
again.

Holding the whole pledge until settlement would be wrong twice over. It
overstates what the sponsor is risking for most of the loan's life, and locked
capacity is capacity that cannot back anybody else — so over-locking quietly
shrinks how much the circle can lend. The sponsors of a nearly-repaid loan
should be backing the next one, not sitting idle.

### It moves with the principal, after the interest is taken off

This is the part that is easy to get wrong. The instalment and the repayment
are different numbers:

```
instalment paid ........... 6,125,000
  less interest ........... 1,125,000   ← the cost of the loan, not a repayment
  principal repaid ........ 5,000,000   ← only this moves the collateral
```

Collateral is released against the **5,000,000**, never the 6,125,000. Freeing
against the gross payment would release more than the borrower has actually
repaid and leave the circle under-covered — by the end of a three-month loan
the gap would be the whole 3,375,000 of interest.

Stepping through the founding example, with a sponsor who pledged 5,000,000:

| After | Paid | of which interest | of which principal | Owing | Sponsor carries |
|---|---|---|---|---|---|
| month 1 | 6,125,000 | 1,125,000 | 5,000,000 | 45,000,000 | 4,500,000 |
| month 2 | 6,125,000 | 1,125,000 | 5,000,000 | 40,000,000 | 4,000,000 |
| month 3 | 6,125,000 | 1,125,000 | 5,000,000 | 35,000,000 | 3,500,000 |
| balloon | 35,000,000 | 0 | 35,000,000 | 0 | 0 |

### The invariant

Because release is proportional, **total cover always equals what is still
owed**. On the founding loan — nine sponsors at 5,000,000 plus the borrower's
own 5,000,000 against a 50,000,000 debt — the two move together at every step.
The circle is never under-covered, and never holds collateral against money
that has already come home.

That invariant is asserted in the tests at every instalment, so a change that
breaks it fails the build.

The figure is rounded **up**, so it never claims a sponsor is freer than they
are. A defaulted loan stays fully locked: that is precisely when cover is
called. A cancelled application releases everything at once.

Sponsors are told when it happens. Each repayment sends every sponsor a note
saying what was freed and what they still carry, so the release is something
they see rather than something they would have to go looking for.

### When a loan defaults

Loss is absorbed in a fixed order:

1. **The borrower's own shares**, in full, before anyone else is touched.
2. **The sponsors' shares**, pro rata to what each of them pledged, each capped
   at their pledge.
3. **Personal receivables** where a sponsor was called beyond their share value.
4. **Written off** against the circle only what the pledges never reached.

Worked example — a TSh 20,000,000 loan, TSh 15,000,000 lost, sponsors pledged
10,000,000 and 5,000,000:

| | |
|---|---|
| Borrower's 50 shares | 5,000,000 recovered, all shares forfeited |
| Remaining loss | 10,000,000, split 2:1 by pledge |
| Sponsor A called | 6,666,667 — holds 5,000,000 of shares, so 1,666,667 becomes a personal receivable |
| Sponsor B called | 3,333,333 — 34 whole shares forfeited, 16 remain |

Shares are forfeited **whole**, so recovery rounds *up* to the next share. A
TSh 120,000 call against TSh 100,000 shares takes two shares; the over-recovery
stays with the circle.

Forfeited shares go to **treasury** rather than being cancelled, so the circle
can re-issue them to an incoming member instead of shrinking its own capital.

Sponsors are never called for more than they pledged, however large the loss.
If cover was incomplete, the uncovered part is the circle's own loss — which is
precisely why cover must be complete before disbursement.

---

## 7. Governance: deletion by vote

**Implemented in** `packages/core/src/governance.ts` · **proved in** `test/governance.test.ts`

Every member can propose that a circle record be deleted. Nobody can delete one
alone.

| | |
|---|---|
| Voting window | 72 hours |
| Weight | by shares held |
| Quorum | 50% of voting weight must vote |
| Threshold | two-thirds of the weight *cast* |

Abstentions count toward quorum but not toward the threshold: turning up to say
"no opinion" helps the circle reach a decision without forcing the abstainer to
pick a side.

Vote weight is **frozen at the moment of casting**, so buying shares after
voting cannot retroactively strengthen a vote already cast. A member may change
their mind while the window is open; the latest position counts.

A result is settled early when no remaining vote could change it, so a clear
outcome does not have to wait out the clock.

### Financial records are never deleted — only reversed

This is the rule that matters most, and it is a deliberate departure from
"members can delete things".

A vote against a posted ledger entry, repayment, share movement or contribution
does not remove it. It posts a **balancing reversal** and marks the original
void. The original stays visible, with the resolution that voided it attached.

A circle whose books can be edited by majority is a circle whose books mean
nothing — and the members who lose from a quiet edit are exactly the ones who
were not watching. The books are the one thing a majority cannot erase.

Ordinary records — announcements, documents, meeting minutes, comments, loan
applications, sponsorship requests — *are* deleted on a successful vote, but a
snapshot is kept against the resolution that removed it, so "the circle voted
this away" never becomes "nobody can remember what it said".

A member is never actually deleted either: their share history has to remain
for the register to reconcile, so they are marked `exited` instead.

---

## 8. The books

**Implemented in** `packages/core/src/ledger.ts` · **proved in** `test/ledger.test.ts`

Every movement of money is posted as a balanced double-entry journal. Not
bureaucracy for its own sake: it is the only way a circle of thirty members can
prove, at any moment, that the cash it thinks it has and the loans it thinks
are out reconcile to the capital it was given.

### Chart of accounts

| Assets | Liabilities | Equity | Income | Expenses |
|---|---|---|---|---|
| Cash and bank | External capital facilities | Share capital | Interest on member loans | Return paid on external capital |
| Loans to members | Return payable to investors | Retained earnings | Fees and subscriptions | Operating expenses |
| Interest receivable | Member savings | | Penalties | Loans written off |
| Due from sponsors | | | | |

### Invariants the engine enforces

- an entry that does not balance **cannot be posted**;
- a line cannot be both a debit and a credit;
- amounts cannot be negative — post the opposite side instead;
- an entry cannot be posted twice, or reversed twice;
- a reversal cannot itself be reversed.

### The standard transactions

| Event | Debit | Credit |
|---|---|---|
| Member subscribes for shares | Cash | Share capital |
| Joining / annual fee | Cash | Fee income |
| Investor advances capital | Cash | Facility principal |
| Loan disbursed | Loans to members | Cash |
| Repayment received | Cash | Loans / Interest income / Penalty income |
| Investor return accrued | Facility interest expense | Return payable |
| Investor paid | Return payable + Facility principal | Cash |
| Loan written off | Share capital + Due from sponsors + Loan loss | Loans to members |

Note the write-off: share value taken from the borrower and their sponsors is a
reduction in **share capital**, not cash. The circle keeps the money it already
had, and the members who stood behind the loan carry the loss in their
holdings.

### Everything is derived

The share register, the ledger and every loan's position are rebuilt from
recorded history on each request — never stored as mutable balances that could
drift away from the transactions that produced them. A circle this size rebuilds
in microseconds.

---

## 9. Member eligibility

**Implemented in** `packages/core/src/eligibility.ts`

Checked *before* a member is allowed to go looking for sponsors. Finding ten
people willing to put their shares behind you is real social work; being told
afterwards that you were never eligible would waste it, and would spend goodwill
the circle needs for the next application.

A member is blocked from borrowing if they:

- have not completed their 50-share subscription;
- owe the current year's subscription;
- have missed 3 consecutive monthly contributions;
- have any loan in arrears;
- are suspended by resolution of the circle.

Ceilings that apply, whichever is lowest:

- 25% of the circle's total capital, per loan;
- whatever capital is actually free to lend;
- the product ceiling (TSh 10,000,000 for short-term loans).

Every rejection carries a reason the member can act on, and where possible the
number they need to reach.

---

## Summary of the founding configuration

```
Share par value ............ TSh    100,000
Shares to join ............. 50  (TSh 5,000,000)
Authorised capital ......... 1,000,000 shares
Monthly contribution ....... TSh    100,000  (= 1 share)
Annual subscription ........ TSh     50,000
Joining fee ................ TSh     20,000

Term loan rate ............. 2.5% / month on the declining balance
Term loan default term ..... 3 months
Monthly principal step ..... 10% of the amount taken
Balloon .................... interest-free
Penalty .................... 1% / month on arrears

Short-term loan ............ flat 5%, up to 30 days, 100% cover
Investor return ............ 1% / month on the utilised balance
Facility commitment ........ 3 months minimum

Sponsor cover .............. 1.0 × the loan
Sponsor response window .... 72 hours
Max one sponsor's share .... 50% of a loan

Voting window .............. 72 hours
Quorum ..................... 50% of shares
Pass threshold ............. two-thirds of votes cast
Financial records .......... reversible, never deletable
```

Every one of these lives in `packages/core/src/config.ts` and can be changed
without touching a line of logic. `validateConfig()` refuses combinations that
contradict each other — most importantly, a lending rate at or below the cost
of external capital, which would make every facility-funded loan lose money.

---

## 10. The capital engine

**Implemented in** `packages/core/src/capital.ts` · **proved in** `test/capital.test.ts`

Every other part of this model answers a question about one loan, one member
or one facility. This answers questions about the circle as a whole, and about
the future rather than the past: what can we lend today, what is coming back,
where has the risk bunched up, and which of the waiting requests can we
actually fund.

That is the difference between book-keeping and treasury. A ledger tells the
committee what happened; this tells them what they can do.

### Available is not the same as spendable

Two numbers get confused constantly, and the engine keeps them apart:

- **available** — what policy allows to be lent: total capital less what is
  already out.
- **cash on hand** — money actually in the account.

They diverge because cash includes amounts the circle holds but does not own:
application fees awaiting a decision, members' savings, a facility drawn but
not yet lent. **A circle can look under-lent on paper and still be unable to
disburse.** What can go out of the door is the lower of the two, and that is
what the cashier is shown.

The engine raises a danger alert when approved loans total more than can be
released — the circle has promised money it cannot pay.

### What is coming back

Scheduled repayments over the next 7, 30 and 90 days, with principal and
interest separated because only principal replenishes lendable capital.

Two rules keep the forecast honest:

- **Overdue amounts are never counted as future inflow.** Money that was due
  in April is not "expected in the next 30 days".
- **Money owed by members already behind is counted separately.** A borrower
  who missed last month's instalment is the least likely to make next
  month's. The `dependable` figure excludes them, and that is the figure used
  to promise anybody a funding date.

### Concentration

Borrowers ranked by what they owe, sponsors by what they still have locked
(not what they promised — see the release rule above). Plus a Herfindahl
index of the loan book: the sum of squared shares, where 1.0 means one
borrower holds everything and 1/n means it is spread evenly across n. One
number the committee can watch move, where a list of borrowers is only a list.

### What can be funded

The waiting queue is worked through **in order**, spending the purse down:
the second request is answered from what the first leaves. Answering each
independently would tell a committee it can fund four loans it can only fund
one of.

Where a request cannot be met today, the engine says when it could be — the
first window whose dependable inflow closes the gap — or says plainly that
repayments due within 90 days do not close it.

---

## 11. Statements

**Implemented in** `packages/core/src/statements.ts` · **proved in**
`test/statements.test.ts`

Section 8 gives the circle a balance sheet and an income statement. Neither
answers the question a meeting actually argues about, which is **where the
money went**. A circle can post a healthy surplus and have nothing in the
account: a surplus counts interest *earned*, cash counts interest *received*,
and the largest movements in a lending circle — money going out on loan and
coming back — never touch the income statement at all.

### The statement is derived, not accumulated

There is no separate record of cash movements that could drift out of step
with the ledger. Every figure is read off the `CASH` lines of entries already
posted: the signed cash on an entry is what moved, and the accounts on the
other side of that same entry say what it was for. A repayment whose lines are
`Cash 6,125,000 / Loans 5,000,000 / Interest 1,125,000` therefore splits into
5,000,000 of lending and 1,125,000 of earnings without anybody classifying it
by hand.

That makes the statement an audit of the books rather than a second opinion
about them, and it means

```
openingCash + netMovement = closingCash
```

is a fact rather than a hope. `reconciles` asserts it on every statement
anyway. It is returned rather than thrown, for the same reason `booksBalance`
is: a report that refuses to render tells nobody anything.

### Three sections, named for what members do

The textbook split — operating, investing, financing — was written for a
company that makes things, and it files a circle's single largest cash
movement under a footnote heading. These sections are named for what the
members recognise:

| Section | What is in it | What it means |
|---|---|---|
| **Lending** | Disbursements out, principal back | Usually negative, and that is health: capital being put to work |
| **Earnings** | Interest and fees received, less running costs and the investor's return | Income in the only form that can pay for anything |
| **Capital** | Subscriptions, savings, facility drawdowns and repayments | Money from the people who put it up, which the circle earned no part of |

The split exists to answer one question: **what paid for the lending?** A
circle whose lending is funded by *earnings* is compounding. One whose lending
is funded by *capital* is growing on borrowed strength. Same closing balance,
completely different position — and a single net cash figure hides the
difference entirely.

A reversal is an ordinary entry here, not a special case: it moved cash the
other way on the day it was posted, and that is what the statement should
show. A voided entry is not excluded either — voiding marks a record as
repudiated, but the reversal beside it is what undoes the money. Dropping the
original would double the correction.

### Member statements

The same discipline for one person. Every movement between a member and the
circle, with three deliberate choices:

**The sign follows the member, not the ledger.** Money they handed over is
positive; money they received is negative. That is the opposite of the cash
flow statement above, and it is what makes the running total mean something to
the person reading it.

**The cash line is not theirs.** A share subscription debits cash and credits
share capital, both tagged with the same member id — the id is on the cash
line so the movement can be traced, not because the cash belongs to them.
Counting it would net every entry to zero. Only the non-cash side is the
member's own position.

**Totals follow the lines, the label follows the row.** An instalment is one
row labelled *Repayment*, because that is what the member paid. But its
principal and its interest go to different totals, because a statement that
folded interest into "principal repaid" would overstate what the loan cost and
understate what the circle earned.

Alongside the movements sits the member's live position: shares held and what
the stake is worth, principal still outstanding, and cover **still locked** as
a sponsor — not what they originally pledged, since repayments release cover
as they arrive (section 6). Quoting the promise would overstate what they are
carrying.

Every member can read every other member's statement, for the same reason
every member can read the ledger: a circle where you can only see your own
account is a circle where you have to take it on trust that everyone else's
adds up.

---

## 12. The approval gate

**Implemented in** `packages/core/src/approval.ts` · **proved in**
`test/approval.test.ts` and `apps/api/test/approval.test.ts`

Section 6 establishes that a loan approves itself once the members have
covered it. That rule stands. Asking a committee to re-take a decision the
members have already taken with their own capital is bureaucracy, not control.

But **full cover is not sufficient**, and treating it as sufficient is the
opposite mistake. Cover can be complete while:

- the circle has no cash to pay with;
- the borrower is three contributions behind, or already in arrears;
- a sponsor's shares, genuinely free when they pledged in March, have since
  been committed to somebody else;
- the loan would put more than a quarter of the book in one pair of hands.

None of those are decisions. They are facts, and a machine checks facts better
and faster than a meeting does.

### Eight gates

| Gate | Passes when | Exceptionable |
|---|---|---|
| `cover` | Accepted pledges plus self-cover meet the required ratio | No |
| `cover_live` | Each sponsor's shares are *still* free, pledge by pledge | No |
| `borrower_standing` | Member active, and the eligibility engine has nothing blocking | No |
| `subscription` | The platform subscription permits borrowing | No |
| `arrears` | No existing loan behind | No |
| `within_ceiling` | Principal within what policy allows this member | **Yes** |
| `concentration` | Borrower's share of the book *after* this loan is within the limit | **Yes** |
| `spendable_cash` | Cash, less the reserve and less loans already approved, covers it | No |

`cover_live` is the one that could not be done on paper. A pledge records what
somebody promised; it says nothing about whether they can still honour it. The
gate re-derives each sponsor's remaining capacity excluding this pledge and
takes the lesser of what they promised and what is genuinely free — so a
sponsor who pledged 5,000,000 and has since backed two other members counts for
what they actually have, and the borrower is told which sponsors to go back to.

`concentration` is measured on the book **as it would be** after the loan, not
as it is. That is the book the circle would actually be carrying.

`spendable_cash` subtracts two things people forget: a configurable reserve the
circle will not lend below, and principal already promised to approved loans
waiting to be paid. Approving a loan against money already spoken for makes the
approval a promise rather than a decision.

### What follows from a failure

| Outcome | When | Where it goes |
|---|---|---|
| `approved` | Every gate passes | Straight to the cashier |
| `awaiting_sponsors` | Cover incomplete | Still with the members |
| `awaiting_capital` | Everything but the money | The funding queue |
| `needs_authorisation` | Only a policy number is in the way | One named authoriser |
| `refused` | A gate no exception can clear | Back to the borrower, with the reason |

Cash failure is a queue, not a refusal: "we will, when we can" is the true
answer and it keeps the request alive. Order matters — cover first, because
until the members have decided nothing else is worth saying.

### Exceptions, not approvals

Two gates, and only two, may be authorised past. Both are the same shape: the
rule is a figure the members chose, and the request in front of you is outside
it. A member asking for 80,000,000 against a 50,000,000 ceiling is not
ineligible; they are exceptional, and exceptional cases are what people are
for.

So an over-ceiling request is **accepted at application**, told plainly that it
will need authorisation, and allowed to gather sponsors like any other. Only
when it is fully covered does it go to one person — not a committee, and not
every loan. Refusing it at the door would have meant there was no exception to
handle.

One ceiling is never exceptional: the capital the circle actually has. That is
the same fact as `spendable_cash`, and nobody may authorise money into
existence. It is tested against the capital directly rather than against which
ceiling happens to bind lowest.

An authorisation:

- is granted against a named gate, never "the loan";
- carries a reason of at least ten characters, and the granter's name;
- expires after `approval.authorisationValidDays`, so it cannot quietly become
  a standing permission;
- cannot be granted by the borrower for their own loan;
- **re-runs the whole gate afterwards** — clearing one rule is not approving a
  loan, and if something else has failed meanwhile it still does not go through;
- is announced to the circle. An exception nobody knows about is not an
  exception, it is a private arrangement.

### Every decision explains itself

The full gate list, the figures measured, and the policy version in force are
written to `loan_decisions` on every assessment — approved or refused. A
borrower can read exactly which line stopped them and what the number would
have to be. A member auditing the books in a year can see which rules were in
force when a loan was approved, rather than re-deriving it against today's.

This is the part that makes automation defensible. "The system said no" is a
worse answer than a committee's, because at least a committee can be asked why.

### Where the cashier fits

Nowhere, as an approver. The cashier does not decide anything: by the time a
loan reaches them the rules and the members have settled it, and their job is
to hand over the money and record that they did. Making them a second gate
would recreate the bottleneck the design removes.
