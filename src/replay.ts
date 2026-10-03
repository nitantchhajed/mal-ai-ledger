// Prints the per-day report: events and outcomes, end-of-day bookings, closing balances
// (as the bank knew them that day, plus any earlier days that day's events restated),
// authorization states and errors. Ends with the fully restated view and reconciliation checks.
import type { Event, Ledger } from './ledger.ts';
import { format } from './money.ts';
import { WINDOW_END, replay } from './scenario.ts';

const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);

function describe(e: Event): string {
  const amt = lpad('amount' in e ? e.amount : '', 9);
  const what =
    e.type === 'REVERSAL' ? `reverses ${e.reverses}` :
    e.type === 'AUTHORIZATION' || e.type === 'SETTLEMENT' ? e.authId :
    e.type === 'CREDIT' && e.instalments ? `${e.instalments} instalments` : '';
  return `${pad(e.id, 4)} ${pad(e.type, 13)} ${e.account} ${amt}  value D${e.valueDay}  ${pad(what, 14)}`;
}

export function report(l: Ledger): string {
  const out: string[] = [];
  const say = (s = '') => out.push(s);
  const money = (account: string, v: bigint) => format(l.currency(account), v);

  for (const close of l.closes) {
    const day = close.day;
    say(`=== Day ${day} ${'='.repeat(70)}`);

    say('Events');
    const todays = l.outcomes.filter(o => o.bookedDay === day);
    if (todays.length === 0) say('  (none)');
    for (const o of todays) {
      const late = o.event.day < day ? `  [dated Day ${o.event.day}, arrived after Day ${o.event.day} closed]` : '';
      say(`  ${describe(o.event)} ${o.status}${o.status === 'ACCEPTED' && o.reason ? ` (${o.reason})` : ''}${late}`);
    }

    say('Fee assessments (booked at this close)');
    const fees = close.entries.filter(e => e.kind === 'FEE' || e.kind === 'FEE_REVERSAL');
    if (fees.length === 0) say('  (none)');
    for (const f of fees) {
      const preFee = l.entries.filter(e => e.account === f.account && e.valueDay <= f.valueDay && e.bookedDay <= day &&
        !((e.kind === 'FEE' || e.kind === 'FEE_REVERSAL') && e.valueDay === f.valueDay)).reduce((s, e) => s + e.amount, 0n);
      const label = f.kind === 'FEE' ? 'overdraft fee  ' : 'fee refunded   ';
      say(`  ${f.account} ${label} ${lpad(money(f.account, f.amount), 8)}  value D${f.valueDay}  (Day ${f.valueDay} close before fee: ${money(f.account, preFee)})`);
    }

    say('Interest');
    if (close.accruals.length === 0) say('  (no accrual change)');
    for (const a of close.accruals)
      say(`  ${a.account} accrual for D${a.forDay}: ${a.amount > 0n ? '+' : ''}${money(a.account, a.amount)}${a.forDay < day ? '  (earlier day)' : ''}`);
    for (const c of close.entries.filter(e => e.kind === 'INTEREST'))
      say(`  ${c.account} capitalized: +${money(c.account, c.amount)} value D${c.valueDay} (= sum of ${l.accruals.filter(a => a.account === c.account).length} accrual rows)`);

    say(`Closing ledger balance (as known at end of Day ${day})`);
    for (const a of l.accounts) {
      const cur = l.currency(a);
      const ledger = l.balance(a, day, day);
      const holds = l.holds(a, day);
      say(`  ${a} ${cur} ${lpad(money(a, ledger), 9)}   holds ${lpad(money(a, holds), 7)}   available ${lpad(money(a, ledger - holds), 9)}`);
      for (let d = 1; d < day; d++) {
        const before = l.balance(a, d, day - 1);
        const after = l.balance(a, d, day);
        if (before !== after) say(`      restated Day ${d} close: ${money(a, before)} -> ${money(a, after)}`);
      }
    }

    say('Authorizations');
    const auths = [...l.authorizations(day).values()];
    if (auths.length === 0) say('  (none)');
    for (const t of auths) {
      const detail =
        t.status === 'ACTIVE' ? `hold ${money(t.account, t.hold)}` :
        t.status === 'SETTLED' ? `settled ${money(t.account, t.settled!)}, released ${money(t.account, t.released!)}` :
        `requested ${money(t.account, t.requested)}`;
      const why = t.day === day ? l.outcomes.find(o => o.event.id === t.source)?.reason : undefined;
      say(`  ${pad(t.authId, 7)} ${pad(t.status, 8)} ${detail}${why && t.status !== 'SETTLED' ? `  [${why}]` : ''}`);
    }

    say('Errors');
    const errors = [
      ...todays.filter(o => o.status === 'REJECTED').map(o => `${o.event.id} rejected: ${o.reason}`),
      ...close.errors,
    ];
    if (errors.length === 0) say('  (none)');
    for (const e of errors) say(`  ${e}`);
    say();
  }

  say(`=== Restated view: every day re-read with all events known at end of Day ${WINDOW_END} ${'='.repeat(8)}`);
  for (const a of l.accounts) {
    say(`  ${a} (${l.currency(a)})   day      close   net fee    accrual`);
    for (let d = 1; d <= WINDOW_END; d++) {
      const netFee = l.entries.filter(e => e.account === a && e.valueDay === d && (e.kind === 'FEE' || e.kind === 'FEE_REVERSAL')).reduce((s, e) => s + e.amount, 0n);
      const accrual = l.accrued(a, d) - l.accrued(a, d - 1);
      say(`  ${' '.repeat(a.length + 8)}  D${d} ${lpad(money(a, l.balance(a, d)), 10)} ${lpad(money(a, netFee), 9)} ${lpad(money(a, accrual), 10)}`);
    }
  }
  say();
  say('=== Reconciliation');
  for (const a of l.accounts) {
    const accrued = l.accrued(a);
    const capitalized = l.entries.filter(e => e.account === a && e.kind === 'INTEREST').reduce((s, e) => s + e.amount, 0n);
    say(`  ${a}: sum of accruals ${money(a, accrued)} ${accrued === capitalized ? '==' : '!='} capitalized ${money(a, capitalized)}`);
  }
  say(`  journal: ${l.entries.length} entries, ${l.accruals.length} accrual rows, ${l.outcomes.length} event outcomes, all frozen: ${l.entries.every(Object.isFrozen) && l.outcomes.every(Object.isFrozen)}`);
  return out.join('\n');
}

console.log(report(replay()));
