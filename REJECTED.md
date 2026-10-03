# REJECTED

## Part 1 — Acceptance criteria refused

Four of the eight criteria are wrong. Each one has a test in `test/acceptance.test.ts` that asserts what actually happens, so the suite would fail if the code drifted toward the wrong criterion.

### #2 "E7 causes exactly one overdraft fee to be assessed, on Day 2." — REJECTED
E7 causes **three** fees: value Days 2, 4 and 5, all booked at the Day 5 close.

| Value day | Restated close before that day's fee | Fee? |
|---|---|---|
| 2 | 1200.00 − 950.00 − 620.00 = **−370.00** | yes |
| 3 | −370.00 − 25.00 + 400.00 = **5.00** | no |
| 4 | 5.00 − 185.00 = **−180.00** | yes |
| 5 | −180.00 − 25.00 = **−205.00** | yes |

The criterion only looks at E7's own value date. A backdated debit shifts every later close too. Day 3 escapes only because E4's credit happens to land on Day 3 (with a 25.00 margin to spare). Days 4 and 5 don't. Whoever wrote the criterion stopped at the first day.
*Test:* `#2 REJECTED: E7 causes three fees (D2, D4, D5), not exactly one`.

### #6 "After E9, all balances and fees return to their pre-E7 values." — REJECTED
This is wrong on four counts. The fourth is the important one.
1. **"After E9" isn't when it happens.** E9 is a mirror image of E7 and nothing more. Right after E9 posts, the three fees are still on the ledger (balance 390.00, not 465.00). They're only refunded at the next close, by a separate rule (AMBIGUITIES A9, A12).
2. **Fees don't "return".** In an append-only ledger nothing goes back to an earlier value. The three `FEE` rows are permanent, and three new `FEE_REVERSAL` rows offset them. The net is zero. The history is not what it was before E7.
3. **Accrual history doesn't return either.** There are six extra accrual rows (three negative at the Day 5 close, three positive at the Day 6 close).
4. **Auth-B's decline is permanent.** Auth-B was declined *because of* E7. Without E7 it would have been approved, leaving a 90.00 hold and available of 376.03 instead of 466.03. A decline sent to a merchant can't be recalled. E9 restores money, not outcomes.

The part of the criterion that *is* true (restated ledger balances end where they would have without E7) is only true because this design deliberately refunds fees that are no longer owed (AMBIGUITIES A9). Under the equally defensible "fees stand" policy, the balances wouldn't return either (AED 390.93 instead of 466.03). A criterion that's only true under one unstated policy is not a valid criterion.
*Tests:* `#6 REJECTED ...`, plus the failing test in `test/known-gap.ts`, which turns point 4 into a design gap.

### #7 "The three BHD instalments in E10 must each be BHD 3.334." — REJECTED
3 × 3.334 = **10.002**. That credits 0.002 BHD (2 fils) that nobody paid. The ledger would no longer match the source transaction, and reconciliation against the payer's side would break on every such split.
The correct split is 3.334 + 3.333 + 3.333 = 10.000 (largest remainder, extra fils first; see NUMBERS.md).
*Test:* `#7 REJECTED: three instalments of 3.334 would credit 10.002, not 10.000`.

### #8 "If the rounded daily interest accruals do not sum to the capitalized total, the remainder is discarded." — REJECTED
1. It contradicts a non-negotiable rule: rounded daily accruals **must** sum exactly to the capitalized total. A criterion can't permit what a rule forbids.
2. It hides a defect. If the two ever differ, either the accrual engine or the capitalization is computing something different. Discarding the difference makes the reconciliation pass while the bug survives, and money quietly goes missing (in an Islamic bank, it may also be profit owed to the customer).
3. In this design there's never a remainder: capitalization is defined as the sum of the accrual rows. If they diverged, that would be a failed invariant, and the reconciliation line in `npm run replay` would print `!=`.
*Test:* `#8 REJECTED: there is no remainder to discard; capitalized == sum of rounded accruals`.

## Accepted, with notes

| # | Criterion | Note |
|---|---|---|
| 1 | Day 2 close at end of Day 5, before fees, is −370.00 | Correct: 1200.00 − 950.00 − 620.00. Holds aren't ledger entries. |
| 3 | Day 4 settlement of Auth-A accepted | Correct: settles 185.00 against a 200.00 hold and releases 15.00. Judged when it arrives (Day 4, before E7 is known). |
| 4 | Unknown-auth settlement rejected, no funds move | Correct in this model. In real card processing these "force posts" usually have to be honoured, so production would route them to an exception queue (AMBIGUITIES A26). |
| 5 | If Auth-B approved, hold hits available not ledger | The rule is correct, but **the premise is false**: Auth-B is declined (available −245.00). The test checks both the decline and the rule, using a stream without E7. |

## Part 2 — Approaches abandoned mid-build

All of these really happened; the times are in WORKLOG.md.

**R1. "Fees stand once booked" (end result AED 390.93).**
This was in the original plan as the alternative policy. I dropped it before writing the fee code: a final ledger with fees on days whose restated close is positive breaks the rule the fees come from. Kept as the documented alternative in AMBIGUITIES A9.

**R2. Fee re-evaluation triggered when a backdated entry arrives.**
I considered booking fees inside `apply` the moment E7 arrived. I dropped it because (a) it assesses on an intraday balance, while the rule talks about *closing* balances; (b) criterion #1 describes a state "at end of Day 5, before any fee is assessed", which only exists if assessment happens at the close. All re-evaluation now happens in `closeDay`.

**R3. Authorizations as a mutable `Map<authId, {status}>`.**
This was the first sketch for P3: update the status field in place when an auth settles. I dropped it before committing because it's an in-place edit of a record, which is the exact thing the brief forbids, and it loses "what was Auth-A's state on Day 3?". Replaced with append-only `AuthTransition` rows, where the current state is the latest row for that auth.

**R4. History getters returning the internal array, protected only by a `readonly` type.**
The first version of `get entries()` returned `this.#entries` typed as `readonly Entry[]`. TypeScript's `readonly` disappears at runtime, so any caller could `.push()` or `.splice()` history. Replaced with frozen copies, and there's a test that tries to `pop()`. (Commit `feat(ledger)`.)

**R5. Ledger closes days by itself when it sees a later-dated event.**
Dropped in favour of an explicit `closeDay()` called by the replay driver. If `apply` closed days as a side effect, a single out-of-order event (E10) could close or skip days, and the ledger would depend on what order its caller fed it.

**R6. Matching a reversal to its original by exact event ID.**
This was a real bug, not a design choice. Instalments are sourced `E10#1..#3`, so reversing `E10` matched nothing. A test I was writing for outcome reasons caught it. Fixed by matching the event-ID prefix (commit `fix(ledger)`). That fix was itself replaced later; see R9.

**R7. A failing test that Auth-A was approved against restated −570.00.**
This was my first candidate for the deliberately failing test. I dropped it because the gap only shows between Day 5 and Day 6: after E9 the restated Day 2 is positive again, so a test on the final state passes and hides the problem. Replaced with the decision-neutrality test (Auth-B), which fails on the final state. The Auth-A exposure is now explained in that test's annotation.

**R8. A golden-file snapshot of the whole report.**
Considered for P6. I dropped it because a snapshot fails on any formatting change and says nothing about *which* number is wrong. The acceptance suite asserts the numbers directly (final balances, per-day as-known closes, per-day accruals, fee value days).

**R9. Encoding the instalment number in the source ID (`E10#1`) and matching reversals by prefix.**
This was the R6 fix. A review pass found it breaks for any upstream event ID that contains `#`: `P#1` couldn't be reversed, and reversing `P` would also have matched an unrelated event called `P#1`. Replaced with a separate `part` field on the entry, so `source` is always the exact event ID.
