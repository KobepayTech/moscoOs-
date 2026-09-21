# API

Base URL `http://localhost:4000`. JSON in, JSON out. All endpoints require a
bearer token except `POST /auth/login` and `GET /health`.

```
Authorization: Bearer <token>
```

Money is always a whole number of shillings. Dates are `YYYY-MM-DD`.

## Errors

```json
{ "error": { "code": "unprocessable", "message": "...", "detail": [ ... ] } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed input — wrong type, fractional amount, bad date |
| 401 | `unauthorized` | Missing, expired or invalid token |
| 403 | `forbidden` | Signed in, but this action needs another role |
| 404 | `not_found` | No such record |
| 409 | `conflict` | The record is in a state that does not allow this |
| 422 | `unprocessable` | A circle rule refuses it. `detail` carries the reasons |

A 422 from a domain rule carries the engine's own message, e.g.
`loan_error`, `share_error`, `sponsorship_error`, `governance_error`.

## Roles

| Role | May additionally |
|---|---|
| `member` | — (can read everything) |
| `cashier` | record money: disbursements, repayments, contributions, fees, facilities |
| `secretary` | enrol and amend members |
| `chair` | both of the above, and change the circle's configuration |

Every member can read every endpoint marked *(all)*. Voting is open to all.

---

## Auth

### `POST /auth/login` *(public)*
```json
{ "phone": "+255710000000", "password": "..." }
```
→ `{ "token": "...", "member": { ... } }`

Tokens are HMAC-signed and last 12 hours. Failures return the same message
whether the phone number exists or not.

### `POST /auth/change-password`
`{ "currentPassword": "...", "newPassword": "..." }`

### `GET /auth/me` *(all)*
The signed-in member's own position: shares held and what they are worth,
contribution standing, outstanding borrowing, and how much they have free to
pledge.

---

## The circle

### `GET /dashboard` *(all)*
Capital, the utilisation split, the lending book, performance to date, and a
one-line headline. `?asOf=YYYY-MM-DD` to read a past position.

### `GET /config` *(all)* · `PATCH /config` *(chair)*
The circle's rules. `PATCH` merges section by section and validates the result;
a rate at or below the cost of external capital is refused.

### `GET /rate-model` *(all)*
Where the lending rate comes from, recomputed against current capital:
components, break-even utilisation, a sensitivity table, and a twelve-month
equity projection.

### `POST /rate-model/adopt` *(chair)*
Re-derive and publish the rate. Existing loans keep their frozen schedules.

### `GET /health` *(public)*

---

## Members

### `GET /members` *(all)*
The register plus a summary: shares issued, unissued, largest holding.

### `GET /members/:id` *(all)*
One member, with their share history and contribution record.

### `POST /members` *(secretary)*
```json
{
  "fullName": "...", "phone": "+255...", "password": "...",
  "shares": 50, "feesPaid": 70000, "joinedOn": "2026-01-05",
  "role": "member"
}
```
Enrols the member and takes up their founding shares in one transaction:
share movement, journal entry and welcome notification.

### `POST /members/:id/shares` *(cashier)*
`{ "shares": 25, "paidOn": "..." }` — further subscription. Enforces the
authorised capital and the concentration ceiling.

### `POST /members/:id/contributions` *(cashier)*
`{ "period": "2026-03", "amount": 100000, "paidOn": "...", "reference": "..." }`

Must be exactly the agreed monthly amount, and once per member per month. Under
the default rules it buys one share at par.

### `GET /members/:id/statement` *(all)* — `?from=` `?to=`
One member's account with the circle: every movement between them and the
circle, signed from *their* point of view (money they paid in is positive),
with a `runningTotal` down the rows and `totals` broken out by kind —
`shares`, `savings`, `borrowed`, `repaid`, `interest`, `fees`, `sponsorCalled`,
`investor`.

`position.coverLocked` is what they still have at risk as a sponsor *now*, not
what they originally pledged; `coverReleased` is the difference repayments have
freed.

### `GET /members/:id/contributions` *(all)*
### `POST /members/:id/fees` *(cashier)*
`{ "kind": "annual" | "joining" | "penalty" | "other", "amount": ..., "paidOn": "..." }`

---

## Borrowing

### `POST /loans/quote` *(all)*
```json
{ "product": "term", "principal": 50000000, "termMonths": 3 }
```
The full schedule, the cover required, what the member's own shares provide,
and an eligibility assessment — **without applying for anything**. For
`"product": "short_term"`, pass `days` instead; the response includes
`annualisedRate`.

### `POST /loans` *(all)*
`{ "product": "term", "principal": ..., "purpose": "...", "termMonths": 3 }`

Refuses with 422 and a list of reasons if the member is not eligible. Opens the
loan as `awaiting_sponsors`.

### `GET /loans` *(all)*
`?status=` · `?memberId=` · `?asOf=`

### `GET /loans/:id` *(all)*
The loan with its pledges, schedule, servicing state and repayments.

### `GET /loans/:id/settlement` *(all)*
What it costs to clear the loan today, with the unearned-interest rebate.

### `POST /loans/:id/disburse` *(cashier)*
`{ "disbursedOn": "...", "reference": "MPESA-..." }`

Only from `approved`. Computes and **freezes** the schedule, posts to the
ledger, writes a book snapshot, and notifies the borrower and the circle.

### `POST /loans/:id/repayments` *(cashier)*
`{ "amount": 6125000, "paidOn": "...", "reference": "..." }`

Splits the payment the same way the servicing engine does — penalties, then
interest, then principal — and posts each part to its own account. Settles the
loan and releases its sponsors when nothing is left owing.

### `POST /loans/:id/default` *(cashier)*
`{ "occurredOn": "...", "reason": "..." }`

Runs the cascade: the borrower's shares, then the sponsors' pro rata, then
personal receivables, then the write-off. Returns exactly who lost what.

---

## Sponsorship

### `GET /loans/:id/sponsor-suggestions` *(borrower only)*
Members with the capacity to close the gap, ranked, with suggested amounts.

### `POST /loans/:id/sponsors` *(borrower only)*
```json
{ "sponsors": [ { "sponsorId": "mem_03", "amount": 5000000 } ] }
```
Each request is validated against the sponsor's real capacity before it is
sent, so nobody is asked to accept something the rules would refuse.

### `GET /sponsorships` *(all)*
The signed-in member's own inbox, with their remaining capacity.

### `GET /loans/:id/decision` *(all)*
Why the loan was decided as it was: every gate with its outcome and the figure
it measured, the policy version in force, and any authorisations granted.
Recorded whether the loan was approved or refused.

### `POST /loans/:id/authorise` *(chair)*
`{ "gate": "within_ceiling" | "concentration", "reason": "..." }`

The only place a person touches a loan the rules would otherwise have settled.
Refuses any gate outside `approval.exceptionableGates` — cover and cash cannot
be authorised past — a reason under 10 characters, and the authoriser's own
loan. Re-runs the whole gate afterwards: an authoriser clears one rule, they do
not approve the loan.

### `POST /sponsorships/:pledgeId/respond` *(the sponsor only)*
`{ "decision": "accept" | "decline", "note": "..." }`

Capacity is re-checked at acceptance. **If this pledge completes the cover, the
loan approves itself here** and the cashier is notified to pay it out.

### `POST /loans/:id/sponsors/:pledgeId/withdraw` *(borrower only)*
### `POST /loans/expire-pledges` *(all)*
Sweeps pledges whose 72-hour window has closed.

---

## External capital

### `GET /facilities` *(all)*
Every facility with its utilisation, what it has earned, what is owed, and a
plain-language explanation of why. `?from=` `?asOf=` bound the accrual period.

### `POST /facilities` *(cashier)*
```json
{ "investorMemberId": "mem_05", "principal": 200000000, "fundedOn": "...", "seniority": 0 }
```
Refused if the rate is at or above the circle's lending rate.

### `POST /facilities/accrue` *(cashier)*
`{ "from": "...", "to": "..." }` — books the return earned over the period
against each facility's actual utilisation, and tells each investor what their
money did.

### `POST /facilities/:id/payments` *(cashier)*
`{ "interest": ..., "principal": ..., "paidOn": "..." }` — return before
capital. Capital cannot be returned before the commitment date.

### `GET /facilities/repayment-queue` *(all)*
Order in which facilities would be repaid: junior first, so the senior lender
stays in longest.

---

## The ledger

### `GET /ledger` *(all)*
Every entry, the balance sheet and the trial balance. `?asOf=` `?memberId=`

### `GET /ledger/:entryId` *(all)*
### `GET /reports/income` *(all)* — `?from=` `?to=`
### `GET /reports/position` *(all)* — includes `booksBalance`

### `GET /reports/cash-flow` *(all)* — `?from=` `?to=`
Where the cash went, in three sections: `lending` (out to borrowers, principal
back), `earnings` (interest and fees received, less running costs and the
investor's return) and `capital` (subscriptions, savings, facilities).

Derived from the cash lines of entries already posted, never accumulated
separately, so `openingCash + netMovement === closingCash`. `reconciles` states
whether it does — surfaced rather than asserted, because a report that refuses
to render tells nobody anything. `from` is inclusive, so consecutive windows
must start the day after the previous one ended.

---

## Governance

### `GET /proposals` *(all)* · `GET /proposals/:id` *(all)*
Each carries a live tally and a plain-language headline.

### `POST /proposals` *(all)*
`{ "entityType": "announcement", "entityId": "...", "reason": "..." }`

The *kind* of proposal is decided by what is targeted, not by what is asked
for: point it at a ledger entry and you get `void_financial_record`, whatever
you intended. Record types the circle never agreed could be removed are
refused. Reasons under 10 characters are refused.

### `POST /proposals/:id/votes` *(all)*
`{ "choice": "for" | "against" | "abstain", "reason": "..." }`

Weight is frozen at the moment of casting. A member may change their mind while
the window is open. **If the vote settles the result, it is executed here** —
the response's `outcome` is `delete`, `void` or `none`.

### `POST /proposals/resolve-due` *(all)*
Closes out proposals whose window has passed.

### `GET /announcements` *(all)* · `POST /announcements` *(all)*

---

## Notifications

### `GET /notifications` *(all)* — `?unread=true`
### `POST /notifications/:id/read` *(all)*

Notifications are how the circle talks to itself: sponsor requests, answers,
approvals, disbursements, investor accruals, proposals opened and executed.
