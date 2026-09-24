/**
 * AUTO-SIGN, THE RULE. Client, 2026-09-24: "all checks generated from acumatica,
 * it will automatically transfer to signed checks 3 days from the creation date".
 *
 * The clock is `createdAt` — when the sync first wrote the cheque — because
 * Acumatica publishes no creation timestamp and its one date, PaymentDate, is
 * post-dated on some cheques. Calendar days, as elapsed time: first read at
 * 18:00 Monday, due at 18:00 Thursday. The number of days is the
 * `autoSign.afterDays` setting; 0 or less switches the rule off.
 *
 * Pure. No database, no clock: the caller passes `now`.
 */

export const AUTO_SIGNED_ACTION = 'auto_signed'
export const AUTO_SIGN_RUN_ACTION = 'auto_sign_run'

const DAY_MS = 86_400_000

export type AutoSignFacts = {
  status: string
  acumaticaPaymentId: string | null
  isCheque: boolean
  acumaticaStatus: string | null
  createdAt: Date
}

/** A cheque that reached the app at or before this instant has waited `days`. */
export function dueBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
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
  return c.createdAt.getTime() <= dueBefore(now, days).getTime()
}
