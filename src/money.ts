// Money is always an integer count of minor units (fils for AED, fils/1000 for BHD).
// Floats never touch an amount: 0.1 + 0.2 !== 0.3 is a ledger bug, not a rounding choice.

export type Currency = 'AED' | 'BHD';

export const DECIMALS: Record<Currency, number> = { AED: 2, BHD: 3 };

/** "1200.00" -> 120000n. Rejects more fractional digits than the currency carries. */
export function parse(currency: Currency, text: string): bigint {
  const d = DECIMALS[currency];
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`invalid ${currency} amount "${text}"`);
  const [, sign, whole, frac = ''] = m;
  if (frac.length > d) throw new Error(`${currency} has ${d} decimals, got "${text}"`);
  const minor = BigInt(whole! + frac.padEnd(d, '0'));
  return sign ? -minor : minor;
}

/** 120000n -> "1200.00" (AED), -370000n -> "-370.000" (BHD). */
export function format(currency: Currency, minor: bigint): string {
  const d = DECIMALS[currency];
  const abs = (minor < 0n ? -minor : minor).toString().padStart(d + 1, '0');
  return `${minor < 0n ? '-' : ''}${abs.slice(0, -d)}.${abs.slice(-d)}`;
}

/** Integer division n/d rounded half-to-even (banker's rounding). d > 0. */
export function divRoundHalfEven(n: bigint, d: bigint): bigint {
  const q = n / d; // truncates toward zero
  const r = n % d;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice < d) return q;
  const away = n < 0n ? q - 1n : q + 1n;
  if (twice > d) return away;
  return q % 2n === 0n ? q : away;
}

/**
 * Split total into `parts` amounts that differ by at most one minor unit and sum
 * exactly to total. Leftover units go to the earliest parts: 10.000/3 -> 3.334, 3.333, 3.333.
 */
export function allocate(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error(`cannot split into ${parts} parts`);
  if (total < 0n) throw new Error('allocate expects a non-negative total');
  const n = BigInt(parts);
  const base = total / n;
  const extra = total % n;
  return Array.from({ length: parts }, (_, i) => (BigInt(i) < extra ? base + 1n : base));
}
