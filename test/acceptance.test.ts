// One test per acceptance criterion in the brief. Accepted criteria are asserted as written.
// Rejected criteria are asserted as what actually happens, so the test proves the criterion
// wrong (reasoning in REJECTED.md). Then whole-scenario invariants.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, OVERDRAFT_FEE } from '../src/ledger.ts';
import { allocate } from '../src/money.ts';
import { ACCOUNTS, EVENTS, WINDOW_END, replay } from '../src/scenario.ts';

/** Replay up to and including `id`, without running the close that follows it. */
function upTo(id: string): Ledger {
  const l = new Ledger(ACCOUNTS, WINDOW_END);
  for (const e of EVENTS) {
    while (l.today < e.day) l.closeDay();
    l.apply(e);
    if (e.id === id) return l;
  }
  throw new Error(`no event ${id}`);
}
const outcome = (l: Ledger, id: string) => l.outcomes.find(o => o.event.id === id)!;
const isFee = (k: string) => k === 'FEE' || k === 'FEE_REVERSAL';
const final = replay();

describe('acceptance criteria', () => {
  test('#1 ACCEPTED: Day 2 close, at end of Day 5 before fees, is AED -370.00', () => {
    const l = upTo('E8'); // every Day-5 event in, Day-5 close not yet run
    assert.equal(l.balance('ACC-001', 2), -37000n);
    assert.equal(l.entries.filter(e => isFee(e.kind)).length, 0, 'no fee booked yet');
  });

  test('#2 REJECTED: E7 causes three fees (D2, D4, D5), not exactly one', () => {
    const eod5 = final.closes.find(c => c.day === 5)!;
    const fees = eod5.entries.filter(e => e.kind === 'FEE');
    assert.deepEqual(fees.map(f => f.valueDay), [2, 4, 5]);
    // D3 escapes only because E4 lands on Day 3: -395.00 + 400.00 = 5.00.
    assert.equal(final.balance('ACC-001', 3, 5), 500n);
  });

  test('#3 ACCEPTED: Auth-A settlement on Day 4 is accepted', () => {
    assert.equal(outcome(final, 'E5').status, 'ACCEPTED');
    assert.equal(final.authorizations().get('Auth-A')!.released, 1500n);
  });

  test('#4 ACCEPTED: settlement for unknown Auth-Z is rejected and no funds leave', () => {
    const before = upTo('E5');
    const after = upTo('E6');
    assert.equal(outcome(after, 'E6').status, 'REJECTED');
    assert.equal(after.balance('ACC-001'), before.balance('ACC-001'));
    assert.equal(final.entries.some(e => e.source === 'E6'), false);
  });

  test('#5 ACCEPTED, premise false: Auth-B is declined in this stream', () => {
    assert.equal(outcome(final, 'E8').status, 'DECLINED');
    assert.equal(final.holds('ACC-001'), 0n);
    // The rule itself holds whenever the premise does: without E7, Auth-B is approved and
    // its hold moves available, not ledger.
    const noE7 = replay(EVENTS.filter(e => e.id !== 'E7' && e.id !== 'E9'));
    assert.equal(outcome(noE7, 'E8').status, 'APPROVED');
    assert.equal(noE7.holds('ACC-001'), 9000n);
    assert.equal(noE7.available('ACC-001'), noE7.balance('ACC-001', WINDOW_END) - 9000n);
  });

  test('#6 REJECTED: E9 does not return balances and fees to pre-E7 values', () => {
    // Right after E9, before the next close, the three fees are still on the ledger.
    const l = upTo('E9');
    assert.equal(l.balance('ACC-001'), 46500n - 3n * 2500n);
    // At the close they are refunded, but by new rows; the fees are never erased.
    assert.deepEqual(final.entries.filter(e => isFee(e.kind)).map(e => e.kind),
      ['FEE', 'FEE', 'FEE', 'FEE_REVERSAL', 'FEE_REVERSAL', 'FEE_REVERSAL']);
    // Auth-B's decline is permanent: the stream without E7 ends with a live 90.00 hold.
    const noE7 = replay(EVENTS.filter(e => e.id !== 'E7' && e.id !== 'E9'));
    assert.notEqual(final.available('ACC-001'), noE7.available('ACC-001'));
    assert.equal(final.authorizations().get('Auth-B')!.status, 'DECLINED');
  });

  test('#7 REJECTED: three instalments of 3.334 would credit 10.002, not 10.000', () => {
    assert.equal(3n * 3334n, 10002n);
    assert.deepEqual(allocate(10000n, 3), [3334n, 3333n, 3333n]);
    assert.deepEqual(final.entries.filter(e => e.source.startsWith('E10')).map(e => e.amount), [3334n, 3333n, 3333n]);
  });

  test('#8 REJECTED: there is no remainder to discard; capitalized == sum of rounded accruals', () => {
    for (const a of final.accounts) {
      const cap = final.entries.filter(e => e.account === a && e.kind === 'INTEREST').reduce((s, e) => s + e.amount, 0n);
      assert.equal(cap, final.accrued(a));
    }
  });
});

describe('scenario results', () => {
  test('final balances: ACC-001 AED 466.03, ACC-002 BHD 10.008', () => {
    assert.equal(final.balance('ACC-001'), 46603n);
    assert.equal(final.balance('ACC-002'), 10008n);
  });

  test('per-day closes as known at the time', () => {
    const known = [1, 2, 3, 4, 5, 6].map(d => final.balance('ACC-001', d, d));
    assert.deepEqual(known, [25000n, 25000n, 65000n, 46500n, -23000n, 46603n]);
  });

  test('daily accruals in the final view: 0.10, 0.10, 0.26, 0.19, 0.19, 0.19', () => {
    const daily = [1, 2, 3, 4, 5, 6].map(d => final.accrued('ACC-001', d) - final.accrued('ACC-001', d - 1));
    assert.deepEqual(daily, [10n, 10n, 26n, 19n, 19n, 19n]);
  });

  test('E10 dated Day 5 but arriving after Day 6 events is booked Day 6, value Day 5', () => {
    const e10 = final.entries.filter(e => e.source.startsWith('E10'));
    assert.ok(e10.every(e => e.bookedDay === 6 && e.valueDay === 5));
  });
});

describe('invariants', () => {
  test('the final ledger obeys the fee rule on every day: net fee is one fee iff pre-fee close < 0', () => {
    for (const a of final.accounts) {
      const fee = OVERDRAFT_FEE[final.currency(a)];
      if (fee === undefined) continue;
      for (let d = 1; d <= WINDOW_END; d++) {
        const rows = final.entries.filter(e => e.account === a && e.valueDay <= d && e.kind !== 'INTEREST');
        const net = rows.filter(e => isFee(e.kind) && e.valueDay === d).reduce((s, e) => s - e.amount, 0n);
        const preFee = rows.filter(e => !(isFee(e.kind) && e.valueDay === d)).reduce((s, e) => s + e.amount, 0n);
        assert.equal(net, preFee < 0n ? fee : 0n, `${a} Day ${d}`);
      }
    }
  });

  test('every inbound event has exactly one outcome', () => {
    assert.deepEqual(final.outcomes.map(o => o.event.id), EVENTS.map(e => e.id));
  });

  test('replay is deterministic', () => {
    assert.deepEqual(replay().entries, final.entries);
    assert.deepEqual(replay().accruals, final.accruals);
  });

  test('nothing written is ever mutated: an earlier snapshot is a prefix of the final history', () => {
    const mid = upTo('E8');
    assert.deepEqual(final.entries.slice(0, mid.entries.length), mid.entries);
    assert.deepEqual(final.accruals.slice(0, mid.accruals.length), mid.accruals);
    assert.ok(final.entries.every(Object.isFrozen) && final.accruals.every(Object.isFrozen));
  });
});
