/**
 * AUTO-SIGN, THE RULE. Client, 2026-09-24: "all checks generated from acumatica,
 * it will automatically transfer to signed checks 3 days from the creation date".
 *
 * The clock is `createdAt` — when the sync first wrote the cheque — because
 * Acumatica publishes no creation timestamp and its one date, PaymentDate, is
 * post-dated on some cheques.
 *
 * Manila CALENDAR days, not elapsed time: a cheque is due when its Manila
 * calendar day is `days` days at or before today's Manila calendar day. A
 * cheque inserted a few minutes into Monday's 18:00 run is not yet 72 hours
 * old at Thursday's run — Vercel fires anywhere within the hour — so counting
 * elapsed hours would slip it to Friday. "Generated Monday, SIGNED Thursday"
 * is a statement about calendar days, and that is what this counts. The
 * number of days is the `autoSign.afterDays` setting; 0 or less switches the
 * rule off.
 *
 * The Philippines is UTC+8 with no daylight saving, so a fixed offset is
 * exact, not an approximation.
 *
 * Pure. No database, no clock: the caller passes `now`.
 */

export const AUTO_SIGNED_ACTION = 'auto_signed'
export const AUTO_SIGN_RUN_ACTION = 'auto_sign_run'

const DAY_MS = 86_400_000
const MANILA_OFFSET_MS = 8 * 3_600_000

export type AutoSignFacts = {
  status: string
  acumaticaPaymentId: string | null
  isCheque: boolean
  acumaticaStatus: string | null
  createdAt: Date
}

/** The Manila calendar day index (days since the epoch, in UTC+8) an instant falls on. */
function dayIndex(t: number): number {
  return Math.floor((t + MANILA_OFFSET_MS) / DAY_MS)
}

/**
 * The first instant (UTC) of the Manila day AFTER the one `days` days before
 * today — so a cheque is due when `createdAt` falls strictly before it, i.e.
 * its Manila day is today minus `days` or earlier. (On 25 Sep with 3 days:
 * 23 Sep 00:00 Manila, so 22 Sep and earlier are due.)
 */
export function dueBefore(now: Date, days: number): Date {
  return new Date((dayIndex(now.getTime()) - days + 1) * DAY_MS - MANILA_OFFSET_MS)
}

export function isDueForAutoSign(c: AutoSignFacts, now: Date, days: number): boolean {
  if (days <= 0) return false
  if (c.status !== 'SIGNATURE_PENDING') return false
  // Only what Acumatica generated. A register-only cheque waits for a person.
  if (c.acumaticaPaymentId === null) return false
  // DEBIT ADV and CASH are never signed by anyone.
  if (!c.isCheque) return false
  // A voided payment is the sync's or a person's to settle, not the clock's.
  if (c.acumaticaStatus === 'Voided') return false
  return c.createdAt.getTime() < dueBefore(now, days).getTime()
}
