import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, divRoundHalfEven, format, parse } from '../src/money.ts';

test('parse/format round-trip at each currency precision', () => {
  assert.equal(parse('AED', '1200.00'), 120000n);
  assert.equal(parse('BHD', '10.000'), 10000n);
  assert.equal(parse('BHD', '10'), 10000n);
  assert.equal(format('AED', -37000n), '-370.00');
  assert.equal(format('BHD', 3334n), '3.334');
  assert.equal(format('AED', 5n), '0.05');
  assert.equal(format('BHD', -4n), '-0.004');
});

test('parse refuses precision the currency does not have', () => {
  assert.throws(() => parse('AED', '1.005'), /2 decimals/);
  assert.throws(() => parse('BHD', '1.0005'), /3 decimals/);
  assert.throws(() => parse('AED', '1,200.00'), /invalid/);
});

test('half-even rounding: ties go to the even neighbour, both signs', () => {
  assert.equal(divRoundHalfEven(186n, 1000n), 0n); // 0.186 -> 0
  assert.equal(divRoundHalfEven(1860n, 10n), 186n);
  assert.equal(divRoundHalfEven(5n, 10n), 0n); // 0.5 -> 0
  assert.equal(divRoundHalfEven(15n, 10n), 2n); // 1.5 -> 2
  assert.equal(divRoundHalfEven(25n, 10n), 2n); // 2.5 -> 2
  assert.equal(divRoundHalfEven(26n, 10n), 3n);
  assert.equal(divRoundHalfEven(-25n, 10n), -2n);
  assert.equal(divRoundHalfEven(-26n, 10n), -3n);
});

test('BHD 10.000 in three instalments sums exactly: 3.334 + 3.333 + 3.333', () => {
  const parts = allocate(10000n, 3);
  assert.deepEqual(parts, [3334n, 3333n, 3333n]);
  assert.equal(parts.reduce((a, b) => a + b), 10000n);
});

test('allocate never loses or invents a minor unit', () => {
  for (let total = 0n; total < 200n; total++)
    for (let parts = 1; parts <= 7; parts++) {
      const xs = allocate(total, parts);
      assert.equal(xs.reduce((a, b) => a + b), total);
      assert.ok(xs[0]! - xs[xs.length - 1]! <= 1n);
    }
});
