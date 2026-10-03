# Architecture & Trade-offs

The design is one append-only journal. Every entry has a value day and a booked day, every decision stores the inputs it used, and corrections are always new rows. *Measured* figures come from `npm run bench`.

## 1. Append-only at scale

**What breaks first (measured).** At 100× volume (60k events, 100 accounts), ingest took **4.5 s** instead of 5 ms. It grew quadratically because the duplicate-event check scanned every past outcome; a `Set` fixed it (32 ms). End-of-day is next. Each close rescans the journal for every value day since Day 1, O(accounts × days × entries), so a close slows as the ledger ages even at flat volume: **18 ms on Day 6, 458 ms on Day 30, 2.0 s on Day 60** (*measured*, 1k events/day). At 100× that volume, the Day-60 close takes over three minutes.

**Where state grows without limit.**
- **Restatement horizon.** Every close treats all of history as open. This is the root cause.
- **Accrual and fee rows** grow with corrections, not activity. One entry backdated *k* days can add *k* accrual deltas, plus a fee and a refund for each day.
- **Event outcomes** (rejections included), **dedupe IDs** and **auth transitions** are kept forever.

**Cheapest structural change.** A running total per account per value day, updated on every append. That's about 30 lines and changes no behaviour, and a close drops from O(entries) to O(days). They're rebuildable from the journal, so append-only holds, and a dirty-account set lets a close skip untouched accounts. Next, cap the horizon with closed periods: backdating beyond *H* days goes through the §2 control instead of automatic restatement. Every operation is single-account, so the account is also the shard key.

## 2. Value-dated entries in production

- **Disclosure.** Balances the customer has already seen become wrong. Here, that was a negative balance and three fees, all later refunded. CBUAE consumer-protection rules expect accurate fees, so corrections need a customer notice, and a fee for a past day was one the customer couldn't avoid.
- **Islamic profit pools.** Mudarabah/Wakala profit is shared by daily balances, so a backdated entry after profit is declared shifts every depositor's share. Re-running versus correcting next period needs Sharia-committee approval.
- **Charity and reporting.** Sharia-compliant late-payment charges usually go to charity, so reversing one unwinds a charity payable, not revenue. Backdating across a month-end changes CBUAE returns already filed: a prior-period adjustment needing sign-off.
- **Financial crime and exposure.** Backdating can earn profit or avoid fees, so monitoring must read both dates and every backdated posting needs a named actor and a reason. Approvals made on balances that are later restated create unmeasured credit risk (the known-gap test). Scheme settlement files key on different dates, so mismatched date rules surface as reconciliation breaks.

**The one control: a value-date window with four-eyes override.** Reject any entry dated more than *N* business days before booking, or into a closed period, unless it carries an approved adjustment (maker, checker, reason code). Report approved backdates daily to Finance and Compliance. Set *N* equal to *H* from §1, so the governance limit and the performance limit are one number.

## 3. Authorization lifecycle

An authorization is `ACTIVE`, `DECLINED` or `SETTLED`. Every way it can end other than a matching settlement:

1. **Declined at request.** *Real world:* insufficient funds. *Mandate:* return ISO 8583 code 51 with stored inputs (done). If the decline was caused by an entry that is later reversed, open a remediation case; today nothing links them (the failing test).
2. **Rejected before it exists** (duplicate ID, unknown account, bad amount or date). *Real world:* the card network resends a request after a timeout. *Mandate:* a duplicate is a retry, so return the original response; today's `REJECTED` reads as a decline.
3. **Settled below the hold, remainder released.** *Real world:* a fuel pre-authorization or hotel deposit. *Mandate:* release only on the final settlement; releasing on the first breaks split shipments.
4. **Never settled: stays `ACTIVE` forever.** *Real world:* the merchant never sends a settlement. *Mandate:* expire it after the card scheme's period for that merchant type and release the hold; a late settlement goes to case 6.
5. **Settlement rejected, auth stays `ACTIVE`** (amount above the hold, or wrong account). *Real world:* a tip or a currency-conversion difference. *Mandate:* allow a per-merchant-type tolerance; beyond it, post and flag for chargeback, since an issuer usually can't refuse one.
6. **Settlement with no authorization.** *Real world:* the card network approved while the bank was offline, an offline in-flight purchase, or fraud. *Mandate:* never reject silently. Book it to a holding account, match it to the network's records, then post it or raise a chargeback.

Not modelled: merchant voids, incremental authorizations, partial approvals, holds on blocked or closed cards, and refunds or chargebacks after settlement. Each would be a new row, never an edit.

## 4. What I cut and why

- **Double-entry.** **Highest risk:** nothing proves money is conserved, and fees and interest have no income or payable side to reconcile against the general ledger.
- **Persistence and concurrency.** A crash loses all state, and two simultaneous authorizations could both pass the balance check; each account needs serialized operations.
- **Real time.** Integer days: no time zones, cut-offs or holidays, so close boundaries and day counts will be wrong. Future-dated entries need an upstream scheduler.
- **Closed periods and a full auth lifecycle.** Without them, close cost keeps growing (§1), reported periods get silently restated (§2), and holds pile up (§3).
- **Interest.** A fixed daily rate; a Sharia-compliant bank pays declared profit. The accrual-and-delta pattern fits, but the rate source and pool allocation are missing.
- **Fees and corrections.** There is one AED fee (a negative BHD account only logs an error) and only full reversals. Without refunds or partial reversals, ops will patch balances another way, which is how append-only gets broken.
- **Controls and provenance.** No account states, limits, KYC tiers or sanctions screening. Decisions store their arithmetic but not the actor (person, service or model) or policy version, which an AI-native bank needs.
- **Performance.** Linear scans, full-history closes and copy-on-read getters; see §1.
- **Decisions vs restatements.** Decisions aren't reviewed when their balances change, risking customer harm and unmeasured exposure. The fix is detection and remediation, not re-deciding.
