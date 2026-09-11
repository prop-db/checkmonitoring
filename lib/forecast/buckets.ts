/**
 * THE BUCKETS. How long a cheque has been presentable, or how soon it will be.
 *
 * The axis is the cheque's own date — the day from which it can be presented,
 * which is how Finance's own Cash Balance sheet treats an outstanding cheque.
 * No pickup or release date has ever been recorded in this system (measured
 * 2026-09-11: null on every row), so this is the one date every cheque has,
 * and it is read as PRESENTABLE FROM, never as EXPECTED ON.
 *
 * Pure. No clock: `today` is passed in, computed once per request by the
 * caller, so a page and its export struck in the same request agree about
 * which day it is.
 */

export const BUCKETS = [
  'OVER 90 DAYS', '61–90 DAYS', '31–60 DAYS', '8–30 DAYS', '1–7 DAYS',
  'TODAY', 'THIS WEEK', 'NEXT WEEK', 'LATER', 'NO DATE',
] as const
export type Bucket = (typeof BUCKETS)[number]

/**
 * The Philippines has kept a single offset, UTC+8, with no daylight saving
 * since 1977. Vercel runs in UTC, so a "day" must be named explicitly or a
 * cheque dated the 11th reads as the 10th between midnight and 8 a.m.
 */
export const MANILA = 'Asia/Manila'

const DAY_MS = 24 * 60 * 60 * 1000

// `en-CA` is the locale whose default date format is ISO 8601 — YYYY-MM-DD —
// which is the only reason it is used here.
const manilaFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** The Manila calendar day of an instant, as `YYYY-MM-DD`. */
export function manilaDay(instant: Date): string {
  return manilaFormatter.format(instant)
}

/** A `YYYY-MM-DD` as a UTC-midnight instant, so two days can be subtracted. */
function dayInstant(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

/**
 * Whole calendar days from the cheque's date to today, in Manila. Positive
 * means the cheque is dated in the past — presentable for that many days.
 * Both instants are reduced to their Manila day first, so a cheque stored as
 * UTC midnight and one stored as Manila midnight land on the same day.
 */
export function daysPresentable(checkDate: Date, today: Date): number {
  return Math.round((dayInstant(manilaDay(today)) - dayInstant(manilaDay(checkDate))) / DAY_MS)
}

/** Days until this week's Sunday, from a Manila day. 0 on a Sunday. */
function daysUntilSunday(today: Date): number {
  const dow = new Date(dayInstant(manilaDay(today))).getUTCDay() // 0 = Sunday
  return (7 - dow) % 7
}

export function bucketFor(checkDate: Date | null, today: Date): Bucket {
  if (checkDate === null) return 'NO DATE'
  const d = daysPresentable(checkDate, today)
  // The past: the ageing buckets Finance already uses on AP Local, with the
  // first split at a week. Upper edges inclusive.
  if (d > 90) return 'OVER 90 DAYS'
  if (d >= 61) return '61–90 DAYS'
  if (d >= 31) return '31–60 DAYS'
  if (d >= 8) return '8–30 DAYS'
  if (d >= 1) return '1–7 DAYS'
  if (d === 0) return 'TODAY'
  // The future: to Sunday, the week after, then everything else. On a Sunday
  // "this week" has no days left and tomorrow is already next week.
  const ahead = -d
  const toSunday = daysUntilSunday(today)
  if (ahead <= toSunday) return 'THIS WEEK'
  if (ahead <= toSunday + 7) return 'NEXT WEEK'
  return 'LATER'
}
