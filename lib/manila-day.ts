/**
 * Manila calendar days as UTC instants. The Philippines is UTC+8 with no
 * daylight saving, so the offset is a constant rather than a timezone lookup.
 * Pure: the caller supplies the clock.
 */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

/** The Manila calendar day (YYYY-MM-DD) that contains `now`. */
export function manilaToday(now: Date): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10)
}

export function manilaDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+08:00`)
}

export function manilaDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999+08:00`)
}
