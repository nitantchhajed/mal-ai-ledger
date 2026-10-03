import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';

const ledger = (windowEnd = 99) => new Ledger({ 'ACC-001': 'AED', 'ACC-002': 'BHD' }, windowEnd);
const debit = (id: string, day: number, amount: string, valueDay = day, account = 'ACC-001') =>
  ({ id, day, type: 'DEBIT', account, amount, valueDay }) as const;
const credit = (id: string, day: number, amount: string, valueDay = day, account = 'ACC-001') =>
  ({ id, day, type: 'CREDIT', account, amount, valueDay }) as const;
const fees = (l: Ledger) => l.entries.filter(e => e.kind === 'FEE' || e.kind === 'FEE_REVERSAL').map(e => [e.kind, e.valueDay, e.bookedDay]);

test('one fee per negative day, not re-charged by later closes', () => {
  const l = ledger();
  l.apply(debit('D', 1, '10.00'));
  l.closeDay(); l.closeDay(); l.closeDay();
  assert.deepEqual(fees(l), [['FEE', 1, 1], ['FEE', 2, 2], ['FEE', 3, 3]]);
  assert.equal(l.balance('ACC-001'), -1000n - 3n * 2500n);
});

test('a fee is judged on the close before its own fee, so it cannot cause itself', () => {
  const l = ledger();
  l.apply(credit('C', 1, '10.00'));
  l.closeDay(); // +10.00, no fee
  l.closeDay();
  assert.deepEqual(fees(l), []);
});

test('backdated credit that cures a day books a FEE_REVERSAL, never deletes the fee', () => {
  const l = ledger();
  l.apply(debit('D', 1, '10.00'));
  l.closeDay(); // Day 1 fee
  l.apply(credit('C', 2, '100.00', 1)); // value-dated Day 1
  l.closeDay();
  assert.deepEqual(fees(l), [['FEE', 1, 1], ['FEE_REVERSAL', 1, 2]]);
  assert.equal(l.balance('ACC-001'), 9000n);
});

test('accruals: positive closes only, half-even per day, capitalized total is their exact sum', () => {
  const l = ledger(3);
  l.apply(credit('C', 1, '465.00')); // 0.186/day -> 0.19
  l.closeDay(); l.closeDay();
  l.apply(debit('D', 3, '1000.00', 2)); // makes Day 2 negative after the fact
  l.closeDay();
  const byDay = (d: number) => l.accruals.filter(a => a.forDay === d).map(a => a.amount);
  assert.deepEqual(byDay(1), [19n]);
  assert.deepEqual(byDay(2), [19n, -19n], 'restated day gets a negative delta, original kept');
  assert.deepEqual(byDay(3), []);
  const cap = l.entries.filter(e => e.kind === 'INTEREST');
  assert.equal(cap.length, 1);
  assert.equal(cap[0]!.amount, l.accruals.reduce((s, a) => s + a.amount, 0n));
  assert.equal(cap[0]!.amount, 19n);
});

test('no fee schedule for BHD: overdraft is reported as an error, no fee is invented', () => {
  const l = ledger();
  l.apply(debit('D', 1, '1.000', 1, 'ACC-002'));
  const close = l.closeDay();
  assert.deepEqual(fees(l), []);
  assert.match(close.errors[0]!, /no overdraft fee is defined for BHD/);
});
