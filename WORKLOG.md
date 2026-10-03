# Worklog

Timestamps are local (IST), taken from `date` at the time of writing.

| When | What |
|---|---|
| 2026-10-03 13:18 IST | Read the brief. Researched Mal (AI-native Islamic digital bank, Abu Dhabi, CBUAE in-principle licence) to frame trade-offs. |
| 2026-10-03 13:30 IST | Hand-replayed the stream on paper before writing code: E7 cascades into three fees (D2, D4, D5), Auth-B is declined, 3 × 3.334 ≠ 10.000. Drafted phase plan. |
| 2026-10-03 14:28 IST | Bootstrap: Node 24 native TS, node:test, zero runtime deps; TypeScript only for `tsc` type-checking. |
| 2026-10-03 14:29 IST | Money: bigint minor units, strict parse (rejects excess precision), half-even rounding, largest-remainder allocate. BHD 10.000/3 → 3.334/3.333/3.333 proven by test. |
| 2026-10-03 14:31 IST | Ledger core: frozen entries with valueDay + bookedDay (bitemporal), reversal as compensating entry, every event gets a recorded outcome (rejected ones too), duplicate event ids rejected (idempotent replay). |
