import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';

const funded = (amount = '250.00') => {
  const l = new Ledger({ 'ACC-001': 'AED', 'ACC-002': 'BHD' });
  l.apply({ id: 'F', day: 1, type: 'CREDIT', account: 'ACC-001', amount, valueDay: 1 });
  return l;
};
const auth = (id: string, authId: string, amount: string) =>
  ({ id, day: 1, type: 'AUTHORIZATION', account: 'ACC-001', authId, amount, valueDay: 1 }) as const;
const settle = (id: string, authId: string, amount: string) =>
  ({ id, day: 1, type: 'SETTLEMENT', account: 'ACC-001', authId, amount, valueDay: 1 }) as const;

test('approval: available may land exactly on zero, not below', () => {
  const l = funded('200.00');
  assert.equal(l.apply(auth('A1', 'X', '200.00')).status, 'APPROVED');
  assert.equal(l.apply(auth('A2', 'Y', '0.01')).status, 'DECLINED');
});

test('a hold reduces available but not ledger', () => {
  const l = funded();
  l.apply(auth('A1', 'Auth-A', '200.00'));
  assert.equal(l.balance('ACC-001'), 25000n);
  assert.equal(l.available('ACC-001'), 5000n);
});

test('the approval records the inputs it was decided on', () => {
  const l = funded();
  assert.equal(l.apply(auth('A1', 'Auth-A', '200.00')).reason, 'ledger 250.00 - holds 0.00 - hold 200.00 = 50.00');
});

test('under-settlement posts the settled amount and releases the rest of the hold', () => {
  const l = funded();
  l.apply(auth('A1', 'Auth-A', '200.00'));
  const o = l.apply(settle('S1', 'Auth-A', '185.00'));
  assert.equal(o.status, 'ACCEPTED');
  assert.equal(l.balance('ACC-001'), 6500n);
  assert.equal(l.holds('ACC-001'), 0n);
  const a = l.authorizations().get('Auth-A')!;
  assert.deepEqual([a.status, a.settled, a.released], ['SETTLED', 18500n, 1500n]);
});

test('settlements without a live authorization are rejected and move no money', () => {
  const l = funded();
  l.apply(auth('A1', 'Auth-A', '100.00'));
  l.apply(auth('A2', 'Auth-B', '900.00')); // declined
  const before = l.entries.length;
  assert.match(l.apply(settle('S1', 'Auth-Z', '180.00')).reason!, /no authorization Auth-Z/);
  assert.match(l.apply(settle('S2', 'Auth-B', '10.00')).reason!, /DECLINED/);
  assert.match(l.apply(settle('S3', 'Auth-A', '100.01')).reason!, /above hold/);
  l.apply(settle('S4', 'Auth-A', '100.00'));
  assert.match(l.apply(settle('S5', 'Auth-A', '1.00')).reason!, /SETTLED/, 'no double settlement');
  assert.equal(l.entries.length, before + 1, 'only S4 booked');
});

test('auth history is transitions, so past state is recoverable', () => {
  const l = funded();
  l.apply(auth('A1', 'Auth-A', '200.00'));
  l.closeDay();
  l.apply({ ...settle('S1', 'Auth-A', '185.00'), day: 2 });
  assert.equal(l.authorizations(1).get('Auth-A')!.status, 'ACTIVE');
  assert.equal(l.authorizations(2).get('Auth-A')!.status, 'SETTLED');
  assert.equal(l.holds('ACC-001', 1), 20000n);
});
