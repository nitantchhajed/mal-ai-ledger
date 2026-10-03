# mal-ai-ledger

An in-memory account ledger core in TypeScript. It's append-only and tracks two dates per entry: value date and booking date.
No web layer, no persistence, no UI, **no runtime dependencies**. About 500 lines of source.

## Run it

Requires **Node.js ≥ 24**. Node runs the `.ts` files directly (native type stripping), so there's no build step.

```bash
npm install
```
```bash
npm test
```
```bash
npm run replay
```
```bash
npm run typecheck
```
```bash
npm run test:known-gap
```

| Script | What it does | Expected |
|---|---|---|
| `npm test` | 43 tests: money, ledger, authorizations, end-of-day, one test per acceptance criterion, invariants | all pass |
| `npm run replay` | Replays the six-day stream and prints the per-day report | see below |
| `npm run typecheck` | `tsc` in strict mode, no emit | no output |
| `npm run bench` | Ingest and end-of-day timings at 600 / 6k / 60k synthetic events (feeds ARCHITECTURE.md §1) | timings |
| `npm run test:known-gap` | The **one deliberately failing test**, annotated inline (`test/known-gap.ts`) | **fails**, on purpose |

`npm test` only picks up `*.test.ts`, so the known-gap test doesn't turn the main suite red.

## Reading the replay output

Each business day prints six blocks:

```
=== Day 5 ====
Events                         every inbound event and its outcome: ACCEPTED / REJECTED / APPROVED / DECLINED
Fee assessments                fees (or refunds) booked at this close, with the pre-fee close that justified each
Interest                       accrual rows booked at this close; "(earlier day)" = a correction to a past day
Closing ledger balance         the close AS KNOWN at the end of this day, then holds and available;
                                 indented "restated Day N close: a -> b" lines show past days this day's events changed
Authorizations                 state of every auth as of this day; approve/decline lines show the arithmetic used
Errors                         rejected events and close-time problems
```

After Day 6:
- **Restated view:** every day's close, net fee and accrual, re-read with all events known. This is the "true" history. The per-day blocks above it show what the bank believed at the time.
- **Reconciliation:** the sum of accrual rows equals the capitalized interest for each account, and every journal record is frozen.

Day 5 is where E7 (received Day 5, value Day 2) arrives, so it shows the most:

```
Fee assessments (booked at this close)
  ACC-001 overdraft fee     -25.00  value D2  (Day 2 close before fee: -370.00)
  ACC-001 overdraft fee     -25.00  value D4  (Day 4 close before fee: -180.00)
  ACC-001 overdraft fee     -25.00  value D5  (Day 5 close before fee: -205.00)
...
Closing ledger balance (as known at end of Day 5)
  ACC-001 AED   -230.00   holds    0.00   available   -230.00
      restated Day 2 close: 250.00 -> -395.00
      restated Day 3 close: 650.00 -> 5.00
      restated Day 4 close: 465.00 -> -205.00
Authorizations
  Auth-A  SETTLED  settled 185.00, released 15.00
  Auth-B  DECLINED requested 90.00  [ledger -155.00 - holds 0.00 - hold 90.00 = -245.00]
```

## Results

| | ACC-001 (AED) | ACC-002 (BHD) |
|---|---|---|
| Closes as known each day, D1→D6 | 250.00, 250.00, 650.00, 465.00, **−230.00**, 466.03 | 0, 0, 0, 0, 0, 10.008 |
| Restated closes, D1→D6 | 250.00, 250.00, 650.00, 465.00, 465.00, 466.03 | 0, 0, 0, 0, 10.000, 10.008 |
| Fees | 3 booked at the Day 5 close (value D2, D4, D5), 3 refunded at the Day 6 close | none |
| Daily accruals (final) | 0.10, 0.10, 0.26, 0.19, 0.19, 0.19 → **1.03** | D5 0.004, D6 0.004 → **0.008** |
| Authorizations | Auth-A approved → settled 185.00 (15.00 released); Auth-B **declined**; Auth-Z settlement rejected | — |
| **Final balance** | **AED 466.03** | **BHD 10.008** |

## Design in five lines

1. **Money is `bigint` minor units.** Parsing rejects excess precision. Rounding is half-to-even and happens in one place. Splits use largest-remainder allocation and always sum exactly.
2. **Two dates per entry.** Every entry has a `valueDay` (when it counts) and a `bookedDay` (when the bank learned of it). `balance(account, valueDay, knownAt)` answers both "what is Day 2's close?" and "what did we think Day 2's close was on Day 2?".
3. **Append-only everything.** Entries, event outcomes (rejections included), authorization state changes and interest accruals are all frozen rows. Corrections are new rows: `REVERSAL`, `FEE_REVERSAL`, negative accrual deltas.
4. **Every end of day re-reads every value day.** It books or refunds fees so each day carries exactly the fee it owes. It appends accrual deltas so capitalization is the sum of the accrual rows, by construction.
5. **Decisions record their inputs.** Each approve or decline stores the arithmetic it was based on, so it can be audited later, whether a person or a model made it.

## Layout

```
src/money.ts        currencies, parse/format, half-even rounding, exact allocation
src/ledger.ts       the ledger: journal, authorizations, end-of-day fees/interest/capitalization
src/scenario.ts     accounts, the event stream, the replay driver
src/replay.ts       the per-day report (npm run replay)
bench/scale.ts      scale benchmark (npm run bench)
test/*.test.ts      the suite
test/known-gap.ts   the deliberately failing test
```

## Documents

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Part 2: append-only at scale, value dating in a UAE bank, authorization lifecycle, what was cut |
| [REJECTED.md](REJECTED.md) | Criteria #2, #6, #7, #8 refused with arithmetic; approaches abandoned mid-build |
| [AMBIGUITIES.md](AMBIGUITIES.md) | 36 ambiguities, how each was resolved, and the test that pins it |
| [NUMBERS.md](NUMBERS.md) | Every constant, why that value, and what breaks at half of it |
| [WORKLOG.md](WORKLOG.md) | Timestamped log of the build |

## How this was built

- **My work, with light AI help:** the research on Mal and its UAE setting, working the event stream through by hand before any code (the −370.00 close, fees on Days 2, 4 and 5, Auth-B declined, 3 × 3.334 = 10.002, the 466.03 final), working out which criteria are wrong and why, and the design decisions: two dates per entry, fees judged before the day's own fee, refunding fees that a reversal makes unowed, no invented BHD fee, E10 treated as a late arrival.
- **Built with Claude Code:** the implementation, the tests and first drafts of these documents were produced with Claude Code against those decisions. That's why the build commits are minutes apart. The replay output was checked against the hand calculation.
- **Review:** a later AI-assisted code review found six edge cases, for example a reversal dated before its original, and future value dates. Each fix is its own commit with a test, and the scenario output didn't change.
