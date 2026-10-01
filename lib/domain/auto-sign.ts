/**
 * AUTO-SIGN, THE RULE. Client, 2026-10-01, replacing the 2026-09-24 "3 days
 * after creation": "All checks prepared on Monday — automatically will be
 * transferred to signed by Tuesday. All checks on Tuesday to Friday will have
 * a 1 click button."
 *
 * "Prepared on Monday" is read as "first read by the sync on a Manila
 * Monday" — `createdAt` — because Acumatica publishes no creation timestamp
 * and its one date, PaymentDate, is post-dated on some cheques. A cheque
 * prepared Monday after the 18:00 read first arrives at Tuesday's 12:00 read,
 * carries a Tuesday `createdAt`, and waits for SIGN ALL. Accepted.
 *
 * Only on a Manila TUESDAY, and only the Monday immediately before it: the
 * 18:00 run retries what the 12:00 run left; anything left after 18:00 waits
 * for SIGN ALL, and no run ever reaches back to an earlier Monday.
 *
 * A cheque a person reverted (`signature_reverted`) is never signed by the
 * clock again: next Tuesday's run would otherwise quietly undo the revert.
 *
 * The Philippines is UTC+8 with no daylight saving, so a fixed offset is
 * exact. Pure. No database, no clock: the caller passes `now`.
 */

export const AUTO_SIGNED_ACTION = 'auto_signed'
export const AUTO_SIGN_RUN_ACTION = 'auto_sign_run'
/** A person undid a signature. A cheque carrying one is never auto-signed again. */
export const SIGNATURE_REVERTED_ACTION = 'signature_reverted'

const DAY_MS = 86_400_000
const MANILA_OFFSET_MS = 8 * 3_600_000
/** 1970-01-01 was a Thursday; with Sunday = 0 that is weekday 4. */
const EPOCH_WEEKDAY = 4
const TUESDAY = 2

export type AutoSignFacts = {
  status: string
  acumaticaPaymentId: string | null
  isCheque: boolean
  acumaticaStatus: string | null
  createdAt: Date
  /** Carries a `signature_reverted` audit row. */
  reverted: boolean
}

/** The Manila calendar day index (days since the epoch, in UTC+8) an instant falls on. */
function dayIndex(t: number): number {
  return Math.floor((t + MANILA_OFFSET_MS) / DAY_MS)
}

/** The UTC instant at which Manila day `index` begins. */
function dayStart(index: number): Date {
  return new Date(index * DAY_MS - MANILA_OFFSET_MS)
}

export function isManilaTuesday(now: Date): boolean {
  return (dayIndex(now.getTime()) + EPOCH_WEEKDAY) % 7 === TUESDAY
}

/** The Manila day before `now`'s: `from` inclusive, `to` exclusive. On a Tuesday, Monday. */
export function mondayWindow(now: Date): { from: Date; to: Date } {
  const today = dayIndex(now.getTime())
  return { from: dayStart(today - 1), to: dayStart(today) }
}

export function isDueForAutoSign(c: AutoSignFacts, now: Date, enabled: boolean): boolean {
  if (!enabled) return false
  if (!isManilaTuesday(now)) return false
  if (c.status !== 'SIGNATURE_PENDING') return false
  // Only what Acumatica generated. A register-only cheque waits for a person.
  if (c.acumaticaPaymentId === null) return false
  // DEBIT ADV and CASH are never signed by anyone.
  if (!c.isCheque) return false
  // A voided payment is the sync's or a person's to settle, not the clock's.
  if (c.acumaticaStatus === 'Voided') return false
  if (c.reverted) return false
  const { from, to } = mondayWindow(now)
  const t = c.createdAt.getTime()
  return t >= from.getTime() && t < to.getTime()
}
