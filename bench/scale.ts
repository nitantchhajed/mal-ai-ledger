// Measures where the design runs out of road. Not part of the suite: `npm run bench`.
// Synthetic stream: N events per day spread over 100 AED accounts, 6 days, 5 % of events
// backdated by up to 3 days. Prints ingest time and end-of-day time at 1x, 10x, 100x.
import { type Event, Ledger } from '../src/ledger.ts';

function stream(perDay: number): { accounts: Record<string, 'AED'>; events: Event[] } {
  const accounts: Record<string, 'AED'> = {};
  for (let i = 0; i < 100; i++) accounts[`A${i}`] = 'AED';
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const events: Event[] = [];
  for (let day = 1; day <= 6; day++)
    for (let i = 0; i < perDay; i++) {
      const account = `A${Math.floor(rnd() * 100)}`;
      const valueDay = rnd() < 0.05 ? Math.max(1, day - 1 - Math.floor(rnd() * 3)) : day;
      const amount = (1 + Math.floor(rnd() * 50000) / 100).toFixed(2);
      events.push({ id: `${day}-${i}`, day, type: rnd() < 0.5 ? 'CREDIT' : 'DEBIT', account, amount, valueDay });
    }
  return { accounts, events };
}

for (const perDay of [100, 1_000, 10_000]) {
  const { accounts, events } = stream(perDay);
  const l = new Ledger(accounts, 6);
  let ingest = 0, close = 0;
  for (const e of events) {
    let t = performance.now();
    while (l.today < e.day) { const c = performance.now(); l.closeDay(); close += performance.now() - c; }
    t = performance.now(); l.apply(e); ingest += performance.now() - t;
  }
  const c = performance.now(); while (l.today <= 6) l.closeDay(); close += performance.now() - c;
  console.log(`${String(perDay * 6).padStart(6)} events  ingest ${ingest.toFixed(0).padStart(7)} ms  end-of-day ${close.toFixed(0).padStart(7)} ms  entries ${l.entries.length}  accrual rows ${l.accruals.length}`);
}
