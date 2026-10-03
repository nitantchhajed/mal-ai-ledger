# Architecture & Trade-offs

This covers the decisions in this ledger core and what they mean for a production bank. It's written with Mal's setting in mind: a CBUAE-licensed, Sharia-compliant, AI-native digital bank.
Figures marked *measured* come from `npm run bench` and a 60-day variant of it, run on an Apple-silicon laptop with Node 24. Figures marked *extrapolated* are scaled linearly from those runs.

The core shape: a single append-only journal where every entry carries a **value day** and a **booked day**; every decision (approve, decline, reject) is recorded with its inputs; corrections are always new rows; and an end-of-day process re-reads value-dated history and books fee and accrual corrections as deltas.

---

## 1. Append-only at scale

### What breaks first: measured, not guessed

| Synthetic load (100 accounts, 6 days, 5 % backdated) | Ingest | All six closes |
|---|---|---|
| 600 events | 5 ms | 36 ms |
| 6,000 events (10×) | 98 ms | 59 ms |
| 60,000 events (100×) | **4,490 ms** | 545 ms |

**Ingest broke first, and it was quadratic.** The idempotency check ("have I seen this event ID?") scanned every past outcome, so each new event cost O(history). It was one line to fix (a `Set`), and after the fix 60k events ingest in 32 ms. The fix is commit `perf(ledger)`; the benchmark was committed just before it, so the history shows the measurement first.

**End-of-day breaks next, and it compounds over time.** Each close re-reads every value day since Day 1, and computes each day's balance by scanning the whole journal: O(accounts × days × entries). Both days and entries grow with time, so a single close gets slower *quadratically* as the ledger ages, even at constant daily volume:

| One close, 1,000 events/day, 100 accounts | Day 6 | Day 15 | Day 30 | Day 60 |
|---|---|---|---|---|
| *measured* | 18 ms | 116 ms | 458 ms | 2,001 ms |

At 100× that daily volume, the Day-30 close is ~45 s and the Day-60 close is over 3 minutes (*extrapolated*). With a real bank's account count it never finishes.

### Where state accumulates without bound

| State | Grows with | Why it matters |
|---|---|---|
| Journal entries | activity | Expected: this *is* the ledger. The problem is re-reading all of it, not storing it. |
| Event outcomes, rejections included | every inbound message | A buggy or hostile upstream can grow it without moving any money. |
| Dedupe ID set | every event, forever | Real duplicates arrive within minutes or hours, not years. |
| Auth transitions | every state change | `authorizations()` rebuilds the full map on every call. |
| Accrual and fee rows | **restatements, not activity** | One entry backdated *k* days can append up to *k* accrual deltas, plus a fee and its refund for each affected day, at every close that re-reads it. Backdating multiplies the row count. |
| Restatement horizon | time | Unbounded. This is the root cause: every close treats all of history as open. |

### The cheapest structural change

**A per-(account, value-day) running-total index, then a bounded horizon with closed periods.**

1. **Index (about 30 lines, no behaviour change).** When an entry is appended, also add its amount to `totals[account][valueDay]`; do the same for accruals and fees. A day's close becomes a prefix sum over days, O(days) per account instead of O(entries). The index is a projection: it can be rebuilt from the journal at any time, so append-only is untouched. Add a dirty-account set so a close only re-evaluates accounts that had activity or backdating since the last close.
2. **Closed periods (needs a product decision).** Value days older than *H* are closed: their closing balance becomes a checkpoint, and end-of-day never reads behind it. A backdated entry past *H* is not restated automatically; it goes through the control described in §2. Close cost becomes O(accounts touched × *H*), and the restated view never reopens months that have already been reported.

Every operation in this model involves a single account, so the account is also the natural **partition key**. Shards never coordinate, until inter-account transfers arrive; see §4, double-entry.

---

## 2. Value-dated entries in production

Value dating lets the ledger say "this happened on Tuesday" on Friday. It's needed for correct interest and fees. Every other process that already acted on Tuesday's figures now needs to hear about it.

**Operational and regulatory surface in a UAE-licensed bank:**

- **Statements and disclosure.** A statement or app balance the customer has already seen becomes wrong. In this run the customer would have seen −230.00 and three fees, all later refunded. Under the CBUAE consumer-protection framework, fees must be transparent and correct, so a restatement needs a customer-facing path (a corrected statement, a refund notification), not just a ledger delta.
- **Retroactive charges are a conduct question.** The design charges a Day-2 fee discovered on Day 5, for an overdraft the customer couldn't have seen or funded. Correct by the arithmetic, hard to defend in a complaint. The fee policy for retroactively discovered overdrafts (especially ones caused by the bank's own posting delay) needs a deliberate decision.
- **Profit distribution in Islamic deposits.** In a Mudarabah or Wakala deposit pool, profit is allocated across depositors by their daily balances over the period. A backdated entry that lands after a period's profit has been declared changes the weightings of the **whole pool**, not one account. The bank needs a policy, approved by its internal Sharia supervisory committee, for re-running the allocation versus correcting in the next period.
- **Charity, not income.** In Sharia-compliant products, late-payment charges are typically donated to charity rather than recognized as income (AAOIFI-aligned practice, which the CBUAE's Higher Sharia Authority framework follows). Reversing such a charge must unwind a charity payable, not revenue, so the fee entry needs a contra account that this design doesn't yet have.
- **Financial and regulatory reporting.** Backdating across a month-end changes balances already in the general ledger and in CBUAE regulatory returns. That's a prior-period adjustment with sign-off, not a silent restatement.
- **Financial crime.** Value dating is a manipulation vector. A credit backdated by an insider earns retroactive profit; a debit backdated by one day can dodge or create a fee. Transaction monitoring has to look at both dates, and every backdated posting needs an identity and a reason attached.
- **Credit exposure and reconciliation.** Approvals made against balances that are later restated (the known-gap test) create exposure nobody measured. Scheme and settlement files key on different dates (booking, value, settlement), so mismatched date rules show up as reconciliation breaks.

**The one control I'd add before go-live: a value-date window with four-eyes override.**
The posting engine rejects any entry whose value date is more than *N* business days before its booking date, or that falls in a closed accounting period, unless it carries an approved adjustment record: maker, checker, reason code, timestamps. Every approved backdated posting appears on a daily value-date exception report that Finance and Compliance review. Set *N* equal to the restatement horizon *H* from §1. Then the engine never needs to restate further back than the control allows, and the performance bound and the governance bound are the same number.

---

## 3. Authorization lifecycle

An authorization in this model has three states: `ACTIVE`, `DECLINED`, `SETTLED`. These are all the ways one can leave the happy path:

| # | Outcome in this model | Real-world scenario | Behaviour I would mandate |
|---|---|---|---|
| 1 | **Declined at request**: available after the hold would be negative | Card used with insufficient funds | Decline with ISO 8583 response code 51; store the inputs (done). If the decline was caused by an entry later reversed, open a remediation case: notify the customer, waive any knock-on fees. Today nothing joins a reversal to the decisions it influenced; that's the failing test. |
| 2 | **Rejected before it exists**: duplicate auth ID, unknown account, malformed amount | Network retransmits after a timeout; integration bugs | A duplicate is a *retry*, not a new request: it should return the **original** response, not a rejection. As written, a retried approval would look like a decline to the terminal. Malformed requests get format-error responses and alert the integration owner. |
| 3 | **Settled below the hold, remainder released** | Fuel pre-auth, hotel deposit, restaurant bill without a tip | Release the remainder only on *final* presentment. The model releases on the first settlement, which wrongly frees the hold when an e-commerce merchant clears a split shipment in two parts. Needs multi-clearing with a final-presentment flag. |
| 4 | **Never settled: stays `ACTIVE` forever** | Order cancelled, merchant never presents, car-rental hold abandoned | The model has no way out of this state. Mandate expiry by scheme rules and merchant category (days for retail, weeks for hotels and car rental), recorded as an `EXPIRED` transition that releases the hold. A presentment that arrives after expiry is still posted, via row 6. |
| 5 | **Settlement attempt rejected (above the hold, or wrong account); the auth stays `ACTIVE`** | Tip added, dynamic-currency-conversion difference, merchant error | The issuer generally can't refuse clearing. Allow a tolerance by merchant category; beyond it, post the settlement and flag it chargeback-eligible rather than bouncing it. |
| 6 | **Settlement with no authorization at all** (the inverse case) | Network stand-in approval while the issuer was down, offline transit or in-flight purchases, an auth expired and purged, or fraud | Never reject silently. Book to a card-settlement suspense account and match against the scheme's stand-in advices. If it's legitimate, post it to the customer with knock-on fees suppressed pending review. If not, raise a "no authorization" chargeback. |

Paths production needs that the model lacks entirely: **merchant void** (cancelled at the till: release immediately, matched to the original auth), **incremental authorization** (a hotel extends the stay: check available only on the increment), **partial approval**, **card or account blocked while holds are live** (keep the holds until expiry; scheme rules still oblige honouring their settlements), and **refunds and chargebacks after settlement** (new credit entries, never edits).

---

## 4. What I cut and why

| Cut | Why it was out of scope | Production risk it defers |
|---|---|---|
| **Double-entry.** Each entry hits one customer account, with no contra side. | The brief is account-level; one side was enough to prove the rules. | **The highest risk.** Nothing proves money is conserved across the bank. Fees have no income or charity-payable account, interest has no expense or profit-payable account, and there's no trial balance to reconcile against the general ledger. |
| Persistence, durability, concurrency | Explicitly excluded | State is lost on crash. Under concurrency, two authorizations can both pass the available-balance check (double spend), so per-account serialization or optimistic versioning is mandatory. |
| Real time: timestamps, time zones, cut-offs, business calendar | Integer days were enough for six days | Wrong close boundaries (UAE time is GMT+4, card networks run on UTC), the Saturday–Sunday weekend and public holidays, and miscounted interest days. |
| Restatement horizon and closed periods | Six days fit in memory | Quadratic close cost (§1) and silent restatement of periods already reported (§2). |
| Authorization lifecycle beyond approve, decline and single settlement | Not in the stream | Hold expiry, voids, incremental auths, multi-clearing, tolerances, force posts (§3). Holds pile up, and real clearing gets rejected. |
| Interest model: a fixed daily rate on the closing balance | Given | No tiers, rate changes, or day-count convention. More fundamentally, a Sharia-compliant bank pays declared profit, not interest. The accrual journal with delta true-ups fits that model (accrue expected profit, true up at declaration), but there's no rate source or pool allocation. |
| Fee model: one AED amount | Given | No per-currency tariff, caps, waivers or grace periods. Retroactive fees are charged without notice (§2). Late-payment charges should route to charity in Islamic products. |
| Corrections: full reversal of credits and debits only | Enough for the stream | No partial reversals, refunds or chargebacks. Operations will want to "just fix" balances any other way they can, which is exactly how append-only gets broken. |
| Account lifecycle and controls | Not in the brief | Frozen, dormant and closed accounts, limits, KYC tiers, sanctions screening. Today any well-formed posting is accepted. |
| Who decided | Only the source event ID is recorded | In an AI-native bank, agents make credit, fraud and compliance decisions. Every decision record needs the actor (human, service or model), the model or policy version, and a hash of its inputs, so a regulator can replay *why* as well as *what*. The approve and decline rows already store their arithmetic; actor and version are missing. |
| Linear scans, full-history closes, copy-on-read getters | Six days, ten events | See §1. The index is the first fix. |
| Decisions are not reconciled with restatements | Re-adjudicating a decision after the fact is wrong (§3, row 1) | Customer harm and unmeasured exposure, as pinned by `test/known-gap.ts`. The fix is detection and remediation, not rewriting the decision. |
