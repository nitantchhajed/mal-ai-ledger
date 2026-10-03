# AMBIGUITIES

Every point where the brief can be read more than one way, how I resolved it, and why. Where a test pins the resolution, it's named.
They're grouped by area. The ones that change a number in the output are marked **(changes output)**.

---

## Time and ordering

**A1. What "Day N" on an event means.**
An event has a stated day and a `value_date`. I read the stated day as when the bank *receives* the event (booking or transaction time). `value_date` is when it counts economically. Every entry stores both (`bookedDay`, `valueDay`), and every balance query can be asked "as known at day K".
*Why:* without two time axes, E7 (received Day 5, value Day 2) can't be explained, and you can't answer "what did the Day 2 statement say?"

**A2. E10 is dated Day 5 but listed after E9 (Day 6).** **(changes output: the booking day)**
Options: (a) sort by date first; (b) process in listed order and treat E10 as a late arrival.
*Resolved:* (b). The brief says the stream is replayed **in this order**. Once Day 5 has closed it can't be reopened, so E10 is booked on Day 6 with value Day 5, and the Day 6 close restates Day 5 for ACC-002. The balances come out the same either way: BHD 10.008.
*Test:* `acceptance.test.ts`, "E10 dated Day 5 ... is booked Day 6".

**A3. When end-of-day processing runs.**
*Resolved:* the business day closes when the stream first shows an event dated after it, and every remaining day closes at the end of the window. Closing is explicit (`closeDay()`), never a side effect of `apply`.

**A4. Business days vs calendar days.**
There are no weekends or holidays. All six days close and accrue. (The UAE weekend is Saturday–Sunday. A real calendar would decide whether a weekend accrues, and most banks do accrue every calendar day.)

## Overdraft fees

**A5. "Assessed when that day's closing ledger balance is negative": assessed when?** **(changes output)**
Real-time on every posting, or at end of day?
*Resolved:* at end of day. Criterion #1 ("evaluated at end of Day 5 and before any fee is assessed") assumes the same thing. Assessing on every posting would also mean an intraday dip that recovers before close gets charged, and the rule talks about *closing* balance.

**A6. Does the day's own fee count when deciding whether that day is negative?**
If it does, the rule is circular: once a fee is booked the day stays negative, so the fee justifies itself even after a credit cures the day.
*Resolved:* a day owes a fee iff its close **excluding that day's own fee** is negative. Earlier days' fees *do* count, because they're real debits that carry forward.
*Effect here:* on Day 4 the pre-fee close is −180.00, which includes the Day 2 fee. Without it, it would be −155.00. Negative either way, so the count doesn't change.
*Test:* `eod.test.ts`, "a fee is judged on the close before its own fee".

**A7. Do backdated entries trigger fees on days that have already closed?** **(changes output)**
At the Day 2 close, Day 2 was +250.00. E7 makes it −370.00 three days later.
*Resolved:* yes. The rule defines the close as "all entries with value_date ≤ that day", which takes in late-arriving entries. Every close re-reads every value day. This is why E7 produces fees for **Days 2, 4 and 5**, all booked at the Day 5 close.

**A8. "Booked with value_date equal to the day assessed": which day is that?** **(changes output)**
For the Day 2 fee found at the Day 5 close, the "day assessed" could be Day 5 (when the assessment ran) or Day 2 (the day under assessment).
*Resolved:* value Day 2, booked Day 5. Value-dating it to Day 5 would leave Day 2's restated close at −370.00 with no fee on it while Days 3–4 carried a debit that belongs to Day 2. The fee would no longer line up with the day that owed it.

**A9. A fee is booked, then a later entry cures the day. Refund it?** **(changes output: AED 466.03 vs 390.93)**
The brief says when a fee is owed, not what happens when it stops being owed. E9 cures Days 2, 4 and 5.
*Options:* (a) fees stand once booked: AED 390.93. (b) refund with a compensating entry: AED 466.03.
*Resolved:* (b). The rule ties a fee to a fact about a day ("close is negative"). After E9 that fact is false for all three days. Keeping the fees would leave a final ledger that breaks the rule it was built to enforce. The refund is a new `FEE_REVERSAL` row with the fee's value date, so nothing is erased. In a UAE bank there's also a consumer-protection reason: fees caused by an entry the bank later reverses as erroneous should go back to the customer.
*Test:* `acceptance.test.ts` invariant "the final ledger obeys the fee rule on every day".

**A10. "Once per day per account" after a refund.**
If a day is charged, refunded, and then goes negative again, has the account been charged twice?
*Resolved:* "once" means **net**. The fee rows for any (account, day) always sum to 0 or exactly one fee.

**A11. The fee for a BHD account.**
The fee is priced in AED only, and there's no FX rule.
*Resolved:* no fee is invented. A negative BHD close records an **error** on that day's close. See NUMBERS.md for why a peg conversion (≈ BHD 2.560) wasn't used.
*Test:* `eod.test.ts`, "no fee schedule for BHD".

**A12. Does a reversal itself undo the fees its original caused?**
*Resolved:* no. A reversal is exactly the mirror of the entry it reverses. Fees are a separate fact, reconciled at the next close. Between E9 (Day 6, intraday) and the Day 6 close, the fees are still on the books. That's one of the reasons criterion #6 is rejected.

## Interest

**A13. Which balance earns interest: ledger or available?**
*Resolved:* ledger, as the rule says ("closing ledger balance"). Holds don't reduce interest. Auth-A's 200.00 hold on Days 2–3 had no effect on accruals.

**A14. Interest on restated days.** **(changes output)**
At the Day 4 close the bank had accrued 0.10 / 0.10 / 0.26 / 0.19. After E7, Days 2–4 deserved 0.00 / 0.00 / 0.00. After E9 they deserved the originals again.
*Resolved:* accruals are an append-only journal. Each close computes what every day *should* have accrued and appends the **difference** (`-0.10`, `-0.26`, `-0.19` at Day 5; `+0.10`, `+0.26`, `+0.19` at Day 6). Earlier rows are never edited. The capitalized total is the sum of all rows, so it reflects the final value-dated history.

**A15. Rounding granularity.**
Round each day's accrual, or accumulate unrounded and round once at capitalization?
*Resolved:* round **per account per day**. The rule says "the rounded daily accruals must sum exactly to the capitalized total", which only makes sense if each daily accrual is rounded. Capitalization is then the plain sum, with nothing left over to round.

**A16. Rounding mode.**
Not specified. *Resolved:* half-to-even. No tie occurs in this stream. See NUMBERS.md.

**A17. Interest on the Day 6 capitalization, and fee checks after it.**
Does the capitalized credit (value Day 6) earn Day 6 interest, or count toward Day 6's fee check?
*Resolved:* no to both. The Day 6 close checks fees and accrues first, then capitalizes. Otherwise interest would compound on itself, and a negative Day 6 could escape its fee because of interest capitalized at the same close.

**A18. Debit interest on negative balances.**
*Resolved:* none. The rule covers positive balances only, and the overdraft fee is the only charge for being negative.

**A19. Interest before E10 arrives (ACC-002).**
ACC-002 accrues nothing at the Day 5 close because E10 hasn't arrived yet. The Day 6 close restates Day 5 and books both days: 0.004 + 0.004 = 0.008.

## Authorizations and settlements

**A20. Which ledger balance the approval check uses.**
*Resolved:* every entry known so far with value date ≤ today, minus active holds. Future-value-dated entries are left out (none exist here), so a credit dated tomorrow can't fund a spend today.

**A21. Whether approvals are re-checked when backdating changes the past.** **(changes interpretation)**
Under the restated Day 2 balance, Auth-A's approval would have failed: 250 − 620 − 200 = −570.
*Resolved:* no. An approval is a decision sent to a merchant in real time, and it's judged on what was known at that moment. Re-judging it later can't un-send it. This is the design's known gap, captured in the one failing test (`test/known-gap.ts`).

**A22. What an authorization's `value_date` means.**
A hold isn't a ledger entry, so it has no economic value date. *Resolved:* recorded, unused. The hold takes effect when it's approved.

**A23. A settlement for less than its hold (Auth-A, 185.00 vs 200.00).**
*Resolved:* accepted. 185.00 posts with the settlement's value date, the whole hold clears, and 15.00 is released back to available. Multi-clearing (one auth, several partial settlements) isn't modelled: the first settlement closes the auth.

**A24. A settlement for more than its hold.**
Not in the stream. *Resolved:* rejected. Any excess would be money leaving that the approval check never covered. See NUMBERS.md on scheme tolerances.

**A25. A settlement referencing an auth that exists but isn't active (declined, or already settled).**
Criterion #4 only covers auth IDs that are absent. *Resolved:* rejected too, with a reason naming the state. A declined auth is "present in the ledger" as a record, but it holds no funds.

**A26. A settlement with no auth at all (E6, Auth-Z).**
*Resolved:* rejected, no funds move (criterion #4). **Caveat:** card schemes allow "force posts": settlements for offline, stand-in or expired authorizations that the issuer is generally obliged to honour, with recourse through a chargeback. Inside this model, rejecting is correct. In production it should go to an exception queue, not a hard reject. ARCHITECTURE.md covers this.

**A27. Hold expiry.**
The brief says Auth-B is never settled in the window. *Resolved:* there's no expiry inside the window. Auth-B is declined anyway, so no hold is ever left hanging.

**A28. Criterion #5's premise.**
"If Auth-B is approved" invites the assumption that it is. It isn't: at E8, available is −155.00 and the hold would take it to −245.00. *Resolved:* accept the rule, report the premise as false, and test the rule against a stream without E7 where Auth-B *is* approved.

## Events, reversals, instalments

**A29. "Three equal instalments" of BHD 10.000.** **(changes output)**
10.000 / 3 = 3.333… can't be represented at 3 decimal places, so three exactly equal parts are impossible.
*Resolved:* as equal as possible: 3.334 + 3.333 + 3.333, with the extra fils on the first. All three are value Day 5. They're booked as three separate entries (sourced `E10#1..#3`), so the ledger shows instalments rather than one 10.000 credit.

**A30. Can a reversal be reversed? Can it be partial?**
*Resolved:* no and no. Reversing a reversal is rejected; the correct action is a new entry. A reversal of a multi-instalment credit reverses every instalment (this was a bug fixed during the build; see WORKLOG).

**A31. A reversal whose value date differs from the original's.**
E9 matches E7 (both value Day 2). *Resolved:* the reversal posts at its own value date, whatever it is. If it were later than the original, the days in between would correctly stay restated as debited.

**A32. Rejected events and append-only.**
Does "no event record is ever mutated or deleted" cover rejected events?
*Resolved:* yes. Every inbound event gets exactly one frozen outcome (`ACCEPTED`, `REJECTED`, `APPROVED`, `DECLINED`) with a reason. E6 is in the log as rejected, not dropped.

**A33. Duplicate delivery of the same event ID.**
Not in the stream, but certain in production. *Resolved:* the second copy is rejected as a duplicate, so replays are idempotent.

**A34. Opening balances of 0.00 / 0.000.**
*Resolved:* no opening entry is booked. A non-zero opening balance would be an entry valued before Day 1.

## Reporting

**A35. "Closing ledger balance per day": which one?**
Since Day 2's close changes twice after Day 2 ends, there are two honest answers.
*Resolved:* print both. Each day shows the close **as known at that day's end**, plus every earlier day that day's events restated (`restated Day 2 close: 250.00 -> -395.00`). A final **restated view** shows every day as the bank now understands it.

**A36. Do authorization declines count as "errors"?**
*Resolved:* no. A decline is a valid outcome and appears under authorization states with the arithmetic behind it. "Errors" lists rejected events (E6) and close-time problems (such as a negative BHD close with no fee schedule).
