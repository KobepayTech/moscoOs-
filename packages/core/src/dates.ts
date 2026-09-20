/**
 * Calendar helpers.
 *
 * Dates are ISO `YYYY-MM-DD` strings held in UTC. A circle's schedule is a
 * calendar object, not an instant: "due on 15 March" means the same thing to a
 * member in Dar es Salaam and to the cashier's laptop, so nothing here carries
 * a time or a zone.
 */

export type ISODate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && toISODate(parsed) === value;
}

export function assertISODate(value: unknown, label = 'date'): ISODate {
  if (!isISODate(value)) throw new DateError(`${label} must be an ISO date (YYYY-MM-DD), got ${String(value)}`);
  return value;
}

export function toISODate(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

export function parseISODate(value: ISODate): Date {
  assertISODate(value);
  return new Date(`${value}T00:00:00.000Z`);
}

export function today(clock: () => Date = () => new Date()): ISODate {
  return toISODate(clock());
}

export function addDays(date: ISODate, days: number): ISODate {
  if (!Number.isInteger(days)) throw new DateError(`Day offset must be an integer, got ${days}`);
  return toISODate(new Date(parseISODate(date).getTime() + days * MS_PER_DAY));
}

/**
 * Add whole months, clamping to the end of the target month.
 *
 * 31 January + 1 month is 28 (or 29) February, not 3 March. Loans taken on the
 * 31st must not silently drift their due dates forward.
 */
export function addMonths(date: ISODate, months: number): ISODate {
  if (!Number.isInteger(months)) throw new DateError(`Month offset must be an integer, got ${months}`);
  const start = parseISODate(date);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();

  const targetMonthStart = new Date(Date.UTC(year, month + months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();

  return toISODate(
    new Date(
      Date.UTC(
        targetMonthStart.getUTCFullYear(),
        targetMonthStart.getUTCMonth(),
        Math.min(day, daysInTargetMonth),
      ),
    ),
  );
}

/** Signed whole days from `from` to `to`. */
export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / MS_PER_DAY);
}

export function compareDates(a: ISODate, b: ISODate): number {
  assertISODate(a, 'a');
  assertISODate(b, 'b');
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(a: ISODate, b: ISODate): boolean {
  return compareDates(a, b) < 0;
}

export function isAfter(a: ISODate, b: ISODate): boolean {
  return compareDates(a, b) > 0;
}

export function isOnOrBefore(a: ISODate, b: ISODate): boolean {
  return compareDates(a, b) <= 0;
}

export function isOnOrAfter(a: ISODate, b: ISODate): boolean {
  return compareDates(a, b) >= 0;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return isBefore(a, b) ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return isAfter(a, b) ? a : b;
}

/** First day of the month containing `date`. */
export function startOfMonth(date: ISODate): ISODate {
  return `${date.slice(0, 7)}-01`;
}

/** Last day of the month containing `date`. */
export function endOfMonth(date: ISODate): ISODate {
  const start = parseISODate(date);
  return toISODate(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)));
}

/** `YYYY-MM` bucket key, used for monthly contribution periods. */
export function monthKey(date: ISODate): string {
  assertISODate(date);
  return date.slice(0, 7);
}

/** Inclusive list of month keys from `from` to `to`. */
export function monthKeysBetween(from: ISODate, to: ISODate): string[] {
  const keys: string[] = [];
  let cursor = startOfMonth(from);
  const last = startOfMonth(to);
  while (isOnOrBefore(cursor, last)) {
    keys.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
  }
  return keys;
}
