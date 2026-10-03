import { type Currency, allocate, divRoundHalfEven, format, parse } from './money.ts';

/** Overdraft fee per currency, minor units. No BHD figure was given, so none is invented (see AMBIGUITIES.md). */
export const OVERDRAFT_FEE: Partial<Record<Currency, bigint>> = { AED: 2500n };
/** 0.04% per day = 4 / 10_000. Kept as an exact fraction; never a float. */
export const DAILY_RATE = { num: 4n, den: 10_000n } as const;

export type Day = number;
export type AccountId = string;

/** Inbound events. Amounts arrive as decimal strings and are parsed at the boundary. */
export type Event =
  | { id: string; day: Day; type: 'CREDIT'; account: AccountId; amount: string; valueDay: Day; instalments?: number }
  | { id: string; day: Day; type: 'DEBIT'; account: AccountId; amount: string; valueDay: Day }
  | { id: string; day: Day; type: 'REVERSAL'; account: AccountId; reverses: string; valueDay: Day }
  | { id: string; day: Day; type: 'AUTHORIZATION'; account: AccountId; authId: string; amount: string; valueDay: Day }
  | { id: string; day: Day; type: 'SETTLEMENT'; account: AccountId; authId: string; amount: string; valueDay: Day };

export type EntryKind = 'CREDIT' | 'DEBIT' | 'REVERSAL' | 'SETTLEMENT' | 'FEE' | 'FEE_REVERSAL' | 'INTEREST';

/**
 * One line in the journal. Signed amount: credit > 0, debit < 0.
 * Bitemporal: valueDay is when it counts economically, bookedDay is when the bank learned of it.
 */
export interface Entry {
  readonly seq: number;
  readonly account: AccountId;
  readonly kind: EntryKind;
  readonly amount: bigint;
  readonly valueDay: Day;
  readonly bookedDay: Day;
  readonly source: string; // event id that produced it
  readonly ref?: string; // what it points at (reversed event id, settled auth id)
}

export type Status = 'ACCEPTED' | 'REJECTED' | 'APPROVED' | 'DECLINED';

/** Every inbound event gets exactly one outcome, rejected ones included: the audit trail is the event log. */
export interface Outcome {
  readonly event: Event;
  readonly bookedDay: Day;
  readonly status: Status;
  readonly reason?: string; // why rejected/declined, or the inputs an approval was based on
}

/**
 * Interest accrued for one value day, booked at some end-of-day. Off-balance until capitalized.
 * When a backdated entry restates a day, a *delta* accrual is appended; earlier accruals stay.
 */
export interface Accrual {
  readonly account: AccountId;
  readonly forDay: Day;
  readonly amount: bigint;
  readonly bookedDay: Day;
}

/** What one end-of-day run did. */
export interface DayClose {
  readonly day: Day;
  readonly entries: readonly Entry[]; // fees, fee reversals, capitalization booked by this run
  readonly accruals: readonly Accrual[];
  readonly errors: readonly string[];
}

export type AuthStatus = 'ACTIVE' | 'DECLINED' | 'SETTLED';

/**
 * One state transition of an authorization. Transitions are appended, never edited:
 * an auth's current state is its latest transition, and its state on any past day is recoverable.
 */
export interface AuthTransition {
  readonly authId: string;
  readonly account: AccountId;
  readonly status: AuthStatus;
  readonly hold: bigint; // amount held while ACTIVE; 0 otherwise
  readonly requested: bigint;
  readonly settled?: bigint;
  readonly released?: bigint; // hold minus settled amount, returned to available
  readonly day: Day;
  readonly source: string;
}

export class Ledger {
  #today: Day = 1;
  readonly #currency: ReadonlyMap<AccountId, Currency>;
  readonly #entries: Entry[] = [];
  readonly #outcomes: Outcome[] = [];
  readonly #auths: AuthTransition[] = [];
  readonly #accruals: Accrual[] = [];
  readonly #closes: DayClose[] = [];
  readonly #windowEnd: Day;

  /** windowEnd: the business day whose close capitalizes accrued interest. */
  constructor(accounts: Record<AccountId, Currency>, windowEnd: Day = Infinity) {
    this.#currency = new Map(Object.entries(accounts));
    this.#windowEnd = windowEnd;
  }

  get today(): Day { return this.#today; }
  // Frozen copies: callers can read history but cannot push into or splice it.
  get entries(): readonly Entry[] { return Object.freeze([...this.#entries]); }
  get outcomes(): readonly Outcome[] { return Object.freeze([...this.#outcomes]); }
  get authTransitions(): readonly AuthTransition[] { return Object.freeze([...this.#auths]); }
  get accruals(): readonly Accrual[] { return Object.freeze([...this.#accruals]); }
  get closes(): readonly DayClose[] { return Object.freeze([...this.#closes]); }
  get accounts(): AccountId[] { return [...this.#currency.keys()]; }

  accrued(account: AccountId, forDay: Day = Infinity): bigint {
    let sum = 0n;
    for (const a of this.#accruals) if (a.account === account && a.forDay <= forDay) sum += a.amount;
    return sum;
  }
  currency(account: AccountId): Currency {
    const c = this.#currency.get(account);
    if (!c) throw new Error(`unknown account ${account}`);
    return c;
  }

  /**
   * Ledger balance counting entries with valueDay <= valueDay that were booked by knownAt.
   * balance(a, 2)        -> Day 2 close as restated with everything known now
   * balance(a, 2, 2)     -> Day 2 close as the bank saw it at end of Day 2
   */
  balance(account: AccountId, valueDay: Day = Infinity, knownAt: Day = Infinity): bigint {
    let sum = 0n;
    for (const e of this.#entries)
      if (e.account === account && e.valueDay <= valueDay && e.bookedDay <= knownAt) sum += e.amount;
    return sum; // ponytail: O(entries) scan per query; per-account, per-day running totals once volume matters
  }

  /** Latest state of each authorization as known at end of `knownAt`. */
  authorizations(knownAt: Day = Infinity): Map<string, AuthTransition> {
    const latest = new Map<string, AuthTransition>();
    for (const t of this.#auths) if (t.day <= knownAt) latest.set(t.authId, t);
    return latest;
  }

  holds(account: AccountId, knownAt: Day = Infinity): bigint {
    let sum = 0n;
    for (const t of this.authorizations(knownAt).values()) if (t.account === account) sum += t.hold;
    return sum;
  }

  /** Ledger balance (value-dated up to today) minus active holds: the spendable figure. */
  available(account: AccountId): bigint {
    return this.balance(account, this.#today) - this.holds(account);
  }

  apply(event: Event): Outcome {
    const err = this.#validate(event);
    if (err) return this.#record(event, 'REJECTED', err);
    switch (event.type) {
      case 'CREDIT': {
        const total = parse(this.currency(event.account), event.amount);
        const parts = allocate(total, event.instalments ?? 1);
        parts.forEach((amt, i) =>
          this.#book(event.account, 'CREDIT', amt, event.valueDay, parts.length > 1 ? `${event.id}#${i + 1}` : event.id));
        const cur = this.currency(event.account);
        return this.#record(event, 'ACCEPTED', parts.length > 1 ? `booked ${parts.map(p => format(cur, p)).join(' + ')}` : undefined);
      }
      case 'DEBIT':
        this.#book(event.account, 'DEBIT', -parse(this.currency(event.account), event.amount), event.valueDay, event.id);
        return this.#record(event, 'ACCEPTED');
      case 'REVERSAL': {
        const original = this.#entries.filter(e => e.source.split('#')[0] === event.reverses && (e.kind === 'CREDIT' || e.kind === 'DEBIT'));
        if (original.length === 0) return this.#record(event, 'REJECTED', `no credit/debit from ${event.reverses} to reverse`);
        if (original.some(e => e.account !== event.account)) return this.#record(event, 'REJECTED', `${event.reverses} belongs to another account`);
        if (this.#entries.some(e => e.kind === 'REVERSAL' && e.ref === event.reverses))
          return this.#record(event, 'REJECTED', `${event.reverses} already reversed`);
        for (const o of original) this.#book(event.account, 'REVERSAL', -o.amount, event.valueDay, event.id, event.reverses);
        const back = -original.reduce((s, o) => s + o.amount, 0n);
        return this.#record(event, 'ACCEPTED', `${back > 0n ? '+' : ''}${format(this.currency(event.account), back)} value D${event.valueDay}`);
      }
      case 'AUTHORIZATION': {
        const cur = this.currency(event.account);
        if (this.authorizations().has(event.authId)) return this.#record(event, 'REJECTED', `${event.authId} already exists`);
        const amount = parse(cur, event.amount);
        const ledger = this.balance(event.account, this.#today);
        const holds = this.holds(event.account);
        const after = ledger - holds - amount;
        // Decisions carry their inputs: an auditor (or a model) can re-check why, not just what.
        const why = `ledger ${format(cur, ledger)} - holds ${format(cur, holds)} - hold ${format(cur, amount)} = ${format(cur, after)}`;
        const approved = after >= 0n;
        this.#transition({ authId: event.authId, account: event.account, status: approved ? 'ACTIVE' : 'DECLINED', hold: approved ? amount : 0n, requested: amount, source: event.id });
        return this.#record(event, approved ? 'APPROVED' : 'DECLINED', why);
      }
      case 'SETTLEMENT': {
        const cur = this.currency(event.account);
        const auth = this.authorizations().get(event.authId);
        if (!auth) return this.#record(event, 'REJECTED', `no authorization ${event.authId} on record`);
        if (auth.account !== event.account) return this.#record(event, 'REJECTED', `${event.authId} belongs to ${auth.account}`);
        if (auth.status !== 'ACTIVE') return this.#record(event, 'REJECTED', `${event.authId} is ${auth.status}, not ACTIVE`);
        const amount = parse(cur, event.amount);
        if (amount > auth.hold)
          return this.#record(event, 'REJECTED', `settles ${format(cur, amount)} above hold ${format(cur, auth.hold)}`);
        this.#book(event.account, 'SETTLEMENT', -amount, event.valueDay, event.id, event.authId);
        const released = auth.hold - amount;
        this.#transition({ ...auth, status: 'SETTLED', hold: 0n, settled: amount, released, source: event.id });
        return this.#record(event, 'ACCEPTED', `hold ${format(cur, auth.hold)} cleared, ${format(cur, released)} released`);
      }
    }
  }

  /**
   * End of day. Re-evaluates every value day up to today against everything now known,
   * so a backdated entry is picked up at the next close, then advances the business date.
   *
   * Fees: a day owes one fee iff its close *before that day's own fee* is negative. If it owes
   * one and none is booked, book it; if one is booked but no longer owed (a backdated credit or
   * reversal cured the day), book a FEE_REVERSAL. Net fee per (account, day) is always 0 or 1 fee.
   * Days run in order because a fee on day d is part of day d+1's balance.
   *
   * Interest: accrual for a day = round(close * rate) on positive closes. If that differs from
   * what is already accrued for the day, append the difference. Capitalization = sum of accruals,
   * by construction, so the two can never drift.
   */
  closeDay(): DayClose {
    const day = this.#today;
    const firstEntry = this.#entries.length;
    const firstAccrual = this.#accruals.length;
    const errors: string[] = [];
    // ponytail: rescans every day since Day 1 at each close, O(days x entries); bound it with a restatement horizon at scale
    for (const account of this.#currency.keys()) {
      for (let d = 1; d <= day; d++) {
        this.#restateFee(account, d, errors);
        this.#restateAccrual(account, d);
      }
      if (day === this.#windowEnd) {
        const total = this.accrued(account);
        if (total !== 0n) this.#book(account, 'INTEREST', total, day, `EOD${day}`);
      }
    }
    const close: DayClose = Object.freeze({
      day,
      entries: Object.freeze(this.#entries.slice(firstEntry)),
      accruals: Object.freeze(this.#accruals.slice(firstAccrual)),
      errors: Object.freeze(errors),
    });
    this.#closes.push(close);
    this.#today++;
    return close;
  }

  #restateFee(account: AccountId, d: Day, errors: string[]): void {
    let preFee = 0n;
    let booked = 0n; // net fee already on day d, as a positive number
    for (const e of this.#entries) {
      if (e.account !== account || e.valueDay > d) continue;
      const isFee = e.kind === 'FEE' || e.kind === 'FEE_REVERSAL';
      if (isFee && e.valueDay === d) booked -= e.amount;
      else preFee += e.amount;
    }
    const cur = this.currency(account);
    const fee = OVERDRAFT_FEE[cur];
    if (fee === undefined) {
      if (preFee < 0n) errors.push(`${account} Day ${d} closes ${format(cur, preFee)} but no overdraft fee is defined for ${cur}`);
      return;
    }
    const owed = preFee < 0n ? fee : 0n;
    if (owed > booked) this.#book(account, 'FEE', -(owed - booked), d, `EOD${this.#today}`);
    if (owed < booked) this.#book(account, 'FEE_REVERSAL', booked - owed, d, `EOD${this.#today}`);
  }

  #restateAccrual(account: AccountId, d: Day): void {
    const close = this.balance(account, d);
    const due = close > 0n ? divRoundHalfEven(close * DAILY_RATE.num, DAILY_RATE.den) : 0n;
    const have = this.accrued(account, d) - this.accrued(account, d - 1);
    if (due !== have)
      this.#accruals.push(Object.freeze({ account, forDay: d, amount: due - have, bookedDay: this.#today }));
  }

  #validate(e: Event): string | undefined {
    if (this.#outcomes.some(o => o.event.id === e.id)) return `duplicate event id ${e.id}`;
    if (!this.#currency.has(e.account)) return `unknown account ${e.account}`;
    if (!Number.isInteger(e.valueDay) || e.valueDay < 1) return `invalid value day ${e.valueDay}`;
    if ('amount' in e) {
      let amt: bigint;
      try { amt = parse(this.currency(e.account), e.amount); } catch (x) { return (x as Error).message; }
      if (amt <= 0n) return `amount must be positive, got ${e.amount}`;
    }
    return undefined;
  }

  #book(account: AccountId, kind: EntryKind, amount: bigint, valueDay: Day, source: string, ref?: string): Entry {
    const entry: Entry = Object.freeze({ seq: this.#entries.length + 1, account, kind, amount, valueDay, bookedDay: this.#today, source, ...(ref ? { ref } : {}) });
    this.#entries.push(entry);
    return entry;
  }

  #transition(t: Omit<AuthTransition, 'day'>): void {
    this.#auths.push(Object.freeze({ ...t, day: this.#today }));
  }

  #record(event: Event, status: Status, reason?: string): Outcome {
    const o: Outcome = Object.freeze({ event: Object.freeze({ ...event }), bookedDay: this.#today, status, ...(reason ? { reason } : {}) });
    this.#outcomes.push(o);
    return o;
  }
}
