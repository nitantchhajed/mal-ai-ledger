// THE ONE FAILING TEST, written against this design on purpose.
// Run with `npm run test:known-gap`. It is outside the `*.test.ts` glob so `npm test` stays green.
//
// Property: an entry that is later reversed in full, at the same value date, should leave no trace
// on anything the customer experiences. Replaying the stream with and without the E7/E9 pair
// should give the same outcomes.
//
// For *balances* the design meets this. Fee refunds and accrual deltas bring every restated
// close back to the no-E7 path (see the "restated view" in `npm run replay`).
//
// For *decisions* it does not. Auth-B was judged on Day 5 against a balance that included E7,
// and was declined (-245.00). E9 later showed E7 should never have counted, but by then the
// decline had already gone back to the merchant. The ledger refunds the money, never the decline.
//
// What this reveals:
//   1. Every decision the ledger makes (approve, decline) is taken in transaction time, on what was known
//      then. Balances are restated in value time. Nothing joins the two, so a reversal undoes the money
//      but not the harm it caused.
//   2. The same gap runs the other way. At the end of Day 5, the books showed Auth-A (approved Day 2
//      against 50.00 available) had been approved against -570.00. That is unflagged credit exposure
//      created by backdating (-370.00 restated close minus the 200.00 hold).
//   3. Re-adjudicating is not the fix. A decline can't be recalled from a merchant, and retroactively
//      voiding an approval breaks the scheme's guarantee. The fix is detection: when a reversal lands,
//      list the decisions taken while the reversed entry was live, and queue them for remediation
//      (notify the customer, waive any consequential fee, flag the case for the complaints team).
//      ARCHITECTURE.md covers this under "Authorization lifecycle".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, replay } from '../src/scenario.ts';

test('KNOWN GAP: a fully reversed debit should not change any authorization decision', () => {
  const withPair = replay();
  const withoutPair = replay(EVENTS.filter(e => e.id !== 'E7' && e.id !== 'E9'));
  const decisions = (l: ReturnType<typeof replay>) =>
    l.outcomes.filter(o => o.event.type === 'AUTHORIZATION').map(o => `${o.event.id}:${o.status}`);

  // Balances agree: this part of the property holds.
  assert.equal(withPair.balance('ACC-001', 5), withoutPair.balance('ACC-001', 5));

  // Decisions don't. Fails with: [ 'E3:APPROVED', 'E8:DECLINED' ] !== [ 'E3:APPROVED', 'E8:APPROVED' ]
  assert.deepEqual(decisions(withPair), decisions(withoutPair));
});
