import { type Event, Ledger } from './ledger.ts';
import type { Currency } from './money.ts';

export const ACCOUNTS: Record<string, Currency> = { 'ACC-001': 'AED', 'ACC-002': 'BHD' };
export const WINDOW_END = 6;

/** The brief's stream, in the brief's order. E10 is dated Day 5 but arrives after E9 (Day 6). */
export const EVENTS: readonly Event[] = [
  { id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', amount: '1200.00', valueDay: 1 },
  { id: 'E2', day: 1, type: 'DEBIT', account: 'ACC-001', amount: '950.00', valueDay: 1 },
  { id: 'E3', day: 2, type: 'AUTHORIZATION', account: 'ACC-001', authId: 'Auth-A', amount: '200.00', valueDay: 2 },
  { id: 'E4', day: 3, type: 'CREDIT', account: 'ACC-001', amount: '400.00', valueDay: 3 },
  { id: 'E5', day: 4, type: 'SETTLEMENT', account: 'ACC-001', authId: 'Auth-A', amount: '185.00', valueDay: 4 },
  { id: 'E6', day: 4, type: 'SETTLEMENT', account: 'ACC-001', authId: 'Auth-Z', amount: '180.00', valueDay: 4 },
  { id: 'E7', day: 5, type: 'DEBIT', account: 'ACC-001', amount: '620.00', valueDay: 2 },
  { id: 'E8', day: 5, type: 'AUTHORIZATION', account: 'ACC-001', authId: 'Auth-B', amount: '90.00', valueDay: 5 },
  { id: 'E9', day: 6, type: 'REVERSAL', account: 'ACC-001', reverses: 'E7', valueDay: 2 },
  { id: 'E10', day: 5, type: 'CREDIT', account: 'ACC-002', amount: '10.000', valueDay: 5, instalments: 3 },
];

/**
 * Feed events in order. Business days close as the stream moves forward; an event dated
 * before the current business day (E10) cannot reopen a closed day, so it is booked today
 * with its own value date and the next close restates the affected days.
 */
export function replay(events: readonly Event[] = EVENTS, windowEnd = WINDOW_END): Ledger {
  const ledger = new Ledger(ACCOUNTS, windowEnd);
  for (const e of events) {
    while (ledger.today < e.day) ledger.closeDay();
    ledger.apply(e);
  }
  while (ledger.today <= windowEnd) ledger.closeDay();
  return ledger;
}
