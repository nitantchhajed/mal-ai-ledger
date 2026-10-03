# Worklog

Timestamps are local (IST), taken from `date` at the time of writing.

| When | What |
|---|---|
| 2026-10-03 13:18 IST | Read the brief. Researched Mal (AI-native Islamic digital bank, Abu Dhabi, CBUAE in-principle licence) to frame trade-offs. |
| 2026-10-03 13:30 IST | Hand-replayed the stream on paper before writing code: E7 cascades into three fees (D2, D4, D5), Auth-B is declined, 3 × 3.334 ≠ 10.000. Drafted phase plan. |
| 2026-10-03 14:28 IST | Bootstrap: Node 24 native TS, node:test, zero runtime deps; TypeScript only for `tsc` type-checking. |
| 2026-10-03 14:29 IST | Money: bigint minor units, strict parse (rejects excess precision), half-even rounding, largest-remainder allocate. BHD 10.000/3 → 3.334/3.333/3.333 proven by test. |
| 2026-10-03 14:31 IST | Ledger core: frozen entries with valueDay + bookedDay (bitemporal), reversal as compensating entry, every event gets a recorded outcome (rejected ones too), duplicate event ids rejected (idempotent replay). |
| 2026-10-03 14:32 IST | Authorizations: approve iff ledger(value ≤ today) − holds − hold ≥ 0; approval stores its inputs as the reason (audit trail). Auth lifecycle stored as frozen transitions, not a mutable status field, so Day-N auth state is queryable. Over-settlement, unknown/declined/settled auths rejected. |
| 2026-10-03 14:33 IST | End-of-day: every close re-evaluates all value days ≤ today. Fee owed iff the close before that day's own fee is negative (avoids a fee causing itself); mismatch → FEE or FEE_REVERSAL. Interest as an off-balance accrual journal with delta rows on restatement; capitalization = Σ accruals by construction. No BHD fee given → error, not an invented FX conversion. |
| 2026-10-03 14:33 IST | Scenario + replay driver. First full run matches the paper replay exactly: fees D2/D4/D5 booked at EOD5, all reversed at EOD6; Auth-B declined at −245.00; ACC-001 AED 466.03, ACC-002 BHD 10.008. E10 (dated Day 5, listed after Day 6) is booked on Day 6 with value Day 5. |
| 2026-10-03 14:34 IST | Bug found while adding outcome reasons: a REVERSAL of an instalment credit matched no entries (instalments are sourced E10#1..#3, lookup compared to E10). Fixed by matching on the event id prefix; test added. |
| 2026-10-03 14:34 IST | Per-day report: events + outcomes, fees booked at each close with the pre-fee close that justified them, accrual deltas, balances as known that day plus restated earlier days, auth states with decision inputs, errors. Ends with full restated view and reconciliation (Σ accruals == capitalized). |
| 2026-10-03 14:35 IST | Acceptance suite: one test per brief criterion (accepted asserted as written, rejected asserted as what really happens), scenario numbers, and invariants (final ledger satisfies the fee rule on every day, one outcome per event, deterministic replay, history is prefix-stable). For #5/#6 I replay a counterfactual stream without E7/E9 to show the rule holds when its premise does. 40/40 green. |
