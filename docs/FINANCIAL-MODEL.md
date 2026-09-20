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
