import { type Currency, allocate, parse } from './money.ts';

export type Day = number;
export type AccountId = string;

/** Inbound events. Amounts arrive as decimal strings and are parsed at the boundary. */
export type Event =
  | { id: string; day: Day; type: 'CREDIT'; account: AccountId; amount: string; valueDay: Day; instalments?: number }
  | { id: string; day: Day; type: 'DEBIT'; account: AccountId; amount: string; valueDay: Day }
  | { id: string; day: Day; type: 'REVERSAL'; account: AccountId; reverses: string; valueDay: Day };

export type EntryKind = 'CREDIT' | 'DEBIT' | 'REVERSAL';

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
  readonly ref?: string; // what it points at (reversed event id)
}

export type Status = 'ACCEPTED' | 'REJECTED';

/** Every inbound event gets exactly one outcome, rejected ones included: the audit trail is the event log. */
export interface Outcome {
  readonly event: Event;
  readonly bookedDay: Day;
  readonly status: Status;
  readonly reason?: string;
}

export class Ledger {
  #today: Day = 1;
  readonly #currency: ReadonlyMap<AccountId, Currency>;
  readonly #entries: Entry[] = [];
  readonly #outcomes: Outcome[] = [];

  constructor(accounts: Record<AccountId, Currency>) {
    this.#currency = new Map(Object.entries(accounts));
  }

  get today(): Day { return this.#today; }
  // Frozen copies: callers can read history but cannot push into or splice it.
  get entries(): readonly Entry[] { return Object.freeze([...this.#entries]); }
  get outcomes(): readonly Outcome[] { return Object.freeze([...this.#outcomes]); }
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

  apply(event: Event): Outcome {
    const err = this.#validate(event);
    if (err) return this.#record(event, 'REJECTED', err);
    switch (event.type) {
      case 'CREDIT': {
        const total = parse(this.currency(event.account), event.amount);
        const parts = allocate(total, event.instalments ?? 1);
        parts.forEach((amt, i) =>
          this.#book(event.account, 'CREDIT', amt, event.valueDay, parts.length > 1 ? `${event.id}#${i + 1}` : event.id));
        return this.#record(event, 'ACCEPTED');
      }
      case 'DEBIT':
        this.#book(event.account, 'DEBIT', -parse(this.currency(event.account), event.amount), event.valueDay, event.id);
        return this.#record(event, 'ACCEPTED');
      case 'REVERSAL': {
        const original = this.#entries.filter(e => e.source === event.reverses && (e.kind === 'CREDIT' || e.kind === 'DEBIT'));
        if (original.length === 0) return this.#record(event, 'REJECTED', `no credit/debit from ${event.reverses} to reverse`);
        if (original.some(e => e.account !== event.account)) return this.#record(event, 'REJECTED', `${event.reverses} belongs to another account`);
        if (this.#entries.some(e => e.kind === 'REVERSAL' && e.ref === event.reverses))
          return this.#record(event, 'REJECTED', `${event.reverses} already reversed`);
        for (const o of original) this.#book(event.account, 'REVERSAL', -o.amount, event.valueDay, event.id, event.reverses);
        return this.#record(event, 'ACCEPTED');
      }
    }
  }

  /** Advance the business date. End-of-day processing hooks in here. */
  closeDay(): void {
    this.#today++;
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

  #record(event: Event, status: Status, reason?: string): Outcome {
    const o: Outcome = Object.freeze({ event: Object.freeze({ ...event }), bookedDay: this.#today, status, ...(reason ? { reason } : {}) });
    this.#outcomes.push(o);
    return o;
  }
}
