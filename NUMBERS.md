# NUMBERS

Every constant in the code. For each: what it is, where it lives, why this value, and what goes wrong at half of it.
Values the brief fixed are marked **given**. For those, the "half" column says what would break if someone tuned it.

| Constant | Value | Where |
|---|---|---|
| Overdraft fee, AED | 2500 minor units (25.00), **given** | `OVERDRAFT_FEE` in `src/ledger.ts` |
| Overdraft fee, BHD | *undefined on purpose* | same |
| Daily rate | `4 / 10_000` (0.04 %), **given** | `DAILY_RATE` in `src/ledger.ts` |
| AED minor units | 2, **given** | `DECIMALS` in `src/money.ts` |
| BHD minor units | 3, **given** | same |
| Rounding mode | half-to-even | `divRoundHalfEven` in `src/money.ts` |
| Instalment split | extra minor units go to the earliest instalments | `allocate` in `src/money.ts` |
| Approval threshold | available after hold ≥ 0 | `apply` / `AUTHORIZATION` |
| Over-settlement tolerance | 0 | `apply` / `SETTLEMENT` |
| Fees per account per day | at most 1 (net) | `#restateFee` |
| Restatement horizon | unbounded (every close re-reads from Day 1) | `closeDay` |
| Hold expiry | none inside the window | not modelled |
| Window end | Day 6, **given** | `WINDOW_END` in `src/scenario.ts` |
| First business day | 1 | `Ledger.#today` |
| Amount type | `bigint` minor units | everywhere |

## Overdraft fee: AED 25.00 → `2500n`
Given. It's stored as a whole number of fils, so the fee can never pick up a stray float fraction.
**At half (12.50):** nothing in the code would notice. That's a risk in itself, so the scenario test asserts the exact fee rows (`test/acceptance.test.ts` #2, #6) and any change to the fee fails it.

## Overdraft fee in BHD: not defined
The brief prices the fee only in AED. ACC-002 is BHD. Both currencies are pegged to USD (AED 3.6725, BHD 0.376), so the obvious conversion is 25 / 3.6725 × 0.376 = **BHD 2.560**. I didn't use it, for three reasons:
1. A fee schedule is a product and regulatory decision, not an FX calculation. Banks publish a fixed tariff per currency.
2. Converting at a live rate would make the fee move from day to day.
3. ACC-002 never goes negative in this stream, so inventing a number buys nothing.

If a BHD account does go negative, the close records an **error** instead of guessing (`test/eod.test.ts`).
**At half:** not applicable. The point is that there's no number to halve.

## Daily rate: 0.04 % → `{ num: 4n, den: 10_000n }`
Given. It's stored as an exact fraction and applied as `round(close × 4 / 10_000)`. That rounds **once**, on the exact product. If I stored the rate as the float `0.0004` and multiplied, the result would be computed in binary floating point first and rounded second.
**Why the fraction and not 0.04 as a percentage:** `close × 4 / 10_000` stays integer arithmetic until the single division.
**At half (0.02 %):** Day-4 accrual on AED 465.00 would be 0.093 → 0.09. Interest scales linearly, so halving the rate halves every accrual, give or take one rounding step.

## Minor units: AED 2, BHD 3
Given, and they match ISO 4217. `parse` **rejects** input with more decimals than the currency carries ("1.005" AED is refused, not rounded). Silent rounding at the boundary would create or destroy money before the ledger ever saw it.
**At half (AED 1, BHD 1–2):** amounts like 950.00 survive, but the 0.10 / 0.26 / 0.19 accruals and the 3.334 instalment don't. BHD at 2 dp can't represent 0.004 of daily interest at all, so ACC-002 would earn 0.00 instead of 0.008 over two days.

## Rounding: half-to-even (banker's rounding)
Applied in exactly one place: daily accruals. Ties (x.5 minor units) go to the even neighbour.
**Why not half-up:** half-up pushes every tie the same way. Over millions of daily accruals that's a systematic overpayment of half a minor unit per tie. Half-even averages out to zero. Neither choice is visible in this stream: the actual accruals are 0.186 → 0.19, 0.002 → 0.00 and 0.004 → 0.004, and none is a tie. I picked the one that is correct at scale, and `test/money.test.ts` pins its tie behaviour.
**Caveat for production:** some Islamic profit-distribution and CBUAE disclosure conventions specify half-up. The product and Sharia teams decide this, not engineering, and it's a one-line change.

## Instalment split: extra units to the earliest instalments
10.000 / 3 → **3.334, 3.333, 3.333**. It's largest-remainder allocation in minor units, so the parts differ by at most 1 minor unit and always sum exactly to the total (property-tested over 0–199 units × 1–7 parts).
**Why first and not last:** either is correct. Putting the extra fils first means the customer gets it soonest, and that's the convention most payment schedulers use. With a single value date (all three are Day 5) the choice has no effect on interest.
**"Half" equivalent:** 3.333 × 3 = 9.999 would lose a fils. The brief's own criterion (3.334 × 3 = 10.002) invents two fils. Both are rejected; see REJECTED.md.

## Approval threshold: available after hold ≥ 0
Given as a rule. Exactly zero is approved (tested in `test/auth.test.ts`).
**Why no buffer:** a buffer is a risk-appetite decision, not a correctness one. In this stream, any buffer above 50.00 would decline Auth-A on Day 2.

## Over-settlement tolerance: 0
A settlement above its hold is rejected. Card schemes allow a tolerance for some merchant types (tips at restaurants, fuel). The brief says nothing about it, and allowing any excess means money leaves the account that the available-balance check never covered.
**At a typical scheme tolerance (15–20 %):** a 200.00 hold could settle at up to 230–240 without a second check. Auth-A settles below its hold, so this stream doesn't exercise it.

## Fees per account per day: at most one, net
Fees are judged on the close **before that day's own fee**, so a fee can't trigger itself. If a fee is booked and later refunded, the day nets to zero. If the day goes negative again, it nets back to one fee. A day never carries two.

## Restatement horizon: unbounded
Every close re-evaluates every value day from Day 1. E7 arrives **3 days** late (Day 5 → Day 2) and E10 **1 day** late.
**At half of what this stream needs (a 1.5-day horizon):** the Day 5 close would re-read only Days 4–5, and the Day 6 close only Days 5–6. The Day 2 fee is never booked. The Day 4 fee, booked at the Day 5 close, is never refunded at the Day 6 close, because Day 4 has dropped out of the horizon by then. The account ends at AED 440.82 instead of 466.03 (checked by running a copy of the ledger with that horizon), and no error is raised. A partial horizon fails silently, which is worse than having none. So the horizon has to be at least as long as the latest backdating the bank accepts. In production the two are configured together: a value-date limit (for example, no entry more than N days back without manual approval) and a matching restatement horizon. Inside a 6-day window, "unbounded" costs nothing. The `ponytail:` comment in `closeDay` marks this as the first thing to bound at scale.

## Hold expiry: none
Real holds expire, typically somewhere between a few days and a month depending on the scheme and merchant category. The brief only says Auth-B is never settled inside the window. Auth-B is declined anyway, so nothing here depends on expiry. ARCHITECTURE.md covers what expiry would do.

## Business days 1–6, first day = 1
Value days are positive integers, no later than the current business day. Anything else is rejected. There are no weekends or holidays: every day closes and accrues.

## Amounts as `bigint`
`Number` holds integers exactly only up to 2^53 ≈ 9.0 × 10^15 minor units, about AED 90 trillion. That would be enough for balances. The risk is intermediate products: `close × rate numerator` and summing over many entries can exceed it quietly. `bigint` turns that silent precision loss into an impossibility, at a performance cost that only matters well beyond this scale.
