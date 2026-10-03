import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';

const fresh = () => new Ledger({ 'ACC-001': 'AED', 'ACC-002': 'BHD' });

test('credits and debits book signed minor units', () => {
  const l = fresh();
  l.apply({ id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1200.00', valueDay: 1 });
  l.apply({ id: 'E2', day: 1, type: 'DEBIT', account: 'ACC-001', amount: '950.00', valueDay: 1 });
  assert.equal(l.balance('ACC-001'), 25000n);
});

test('backdated entry: as-known view differs from restated view', () => {
  const l = fresh();
  l.apply({ id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1200.00', valueDay: 1 });
  l.closeDay(); // -> day 2
  l.closeDay(); // -> day 3
  l.apply({ id: 'E7', day: 3, type: 'DEBIT', account: 'ACC-001', amount: '620.00', valueDay: 2 });
  assert.equal(l.balance('ACC-001', 2, 2), 120000n, 'what the bank knew at end of Day 2');
  assert.equal(l.balance('ACC-001', 2), 58000n, 'Day 2 restated');
  assert.equal(l.balance('ACC-001', 1), 120000n, 'Day 1 untouched');
});

test('reversal is a compensating entry; the original stays', () => {
  const l = fresh();
  l.apply({ id: 'E7', day: 1, type: 'DEBIT', account: 'ACC-001', amount: '620.00', valueDay: 1 });
  l.apply({ id: 'E9', day: 1, type: 'REVERSAL', account: 'ACC-001', reverses: 'E7', valueDay: 1 });
  assert.equal(l.balance('ACC-001'), 0n);
  assert.deepEqual(l.entries.map(e => [e.kind, e.amount]), [['DEBIT', -62000n], ['REVERSAL', 62000n]]);
  assert.equal(l.apply({ id: 'E9b', day: 1, type: 'REVERSAL', account: 'ACC-001', reverses: 'E7', valueDay: 1 }).status, 'REJECTED');
  assert.equal(l.apply({ id: 'E9c', day: 1, type: 'REVERSAL', account: 'ACC-001', reverses: 'E9', valueDay: 1 }).status, 'REJECTED', 'reversals are not reversible');
});

test('instalments book separately and sum exactly', () => {
  const l = fresh();
  l.apply({ id: 'E10', day: 5, type: 'CREDIT', account: 'ACC-002', amount: '10.000', valueDay: 5, instalments: 3 });
  assert.deepEqual(l.entries.map(e => e.amount), [3334n, 3333n, 3333n]);
  assert.equal(l.balance('ACC-002'), 10000n);
});

test('boundary validation rejects and records, never throws', () => {
  const l = fresh();
  assert.equal(l.apply({ id: 'X1', day: 1, type: 'DEBIT', account: 'ACC-001', amount: '1.005', valueDay: 1 }).status, 'REJECTED');
  assert.equal(l.apply({ id: 'X2', day: 1, type: 'DEBIT', account: 'ACC-404', amount: '1.00', valueDay: 1 }).status, 'REJECTED');
  assert.equal(l.apply({ id: 'X3', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '0.00', valueDay: 1 }).status, 'REJECTED');
  assert.equal(l.apply({ id: 'X4', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1.00', valueDay: 1, instalments: 0 }).status, 'REJECTED');
  l.apply({ id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1.00', valueDay: 1 });
  assert.equal(l.apply({ id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1.00', valueDay: 1 }).status, 'REJECTED', 'replayed event id is not double-booked');
  assert.equal(l.balance('ACC-001'), 100n);
  assert.equal(l.outcomes.length, 6, 'every event, rejected or not, is in the log');
});

test('append-only: entries and outcomes are frozen', () => {
  const l = fresh();
  l.apply({ id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1.00', valueDay: 1 });
  assert.throws(() => { (l.entries[0] as { amount: bigint }).amount = 0n; }, TypeError);
  assert.throws(() => { (l.outcomes[0] as { status: string }).status = 'REJECTED'; }, TypeError);
});

test('append-only: history arrays cannot be spliced by callers', () => {
  const l = fresh();
  l.apply({ id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1.00', valueDay: 1 });
  assert.throws(() => { (l.entries as unknown[]).pop(); }, TypeError);
  assert.equal(l.entries.length, 1);
});

test('reversing an instalment credit reverses every instalment', () => {
  const l = fresh();
  l.apply({ id: 'E10', day: 5, type: 'CREDIT', account: 'ACC-002', amount: '10.000', valueDay: 5, instalments: 3 });
  assert.equal(l.apply({ id: 'R', day: 5, type: 'REVERSAL', account: 'ACC-002', reverses: 'E10', valueDay: 5 }).reason, '-10.000 value D5');
  assert.equal(l.balance('ACC-002'), 0n);
});
