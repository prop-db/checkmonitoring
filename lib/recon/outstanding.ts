import type { CheckStatus, ClearingStatus } from '@/lib/domain/check-status'
import { manilaDay } from '@/lib/forecast/buckets'

/**
 * OUTSTANDING AS OF A DAY — the OC column of Finance's Cash Balance sheet.
 *
 * A cheque is outstanding as of a Manila calendar day when it had been issued
 * by that day and the bank had not paid it by that day. Pure: dates in,
 * verdict out; the page and the extract both call this over the same rows.
 *
 * ISSUED. `releasedAt` when the app recorded the release. The 9,594 cheques
 * released before it did (measured 2026-09-11) carry none, so the cheque's
 * own date stands in — the day from which it could be presented — and every
 * line says which basis it used. Neither date at all: issued "always".
 *
 * CLEARED. Only `CLEARED` clears; DEPOSITED and ENCASHED mean the bank has not
 * paid. A `clearedDate` after the day means it was still outstanding on the
 * day. `CLEARED` with no date is cleared on EVERY day: nobody recorded when,
 * and counting it outstanding would overstate the figure for ever.
 *
 * AMOUNT. No recorded amount, no figure — the standing rule since 2026-09-06.
 */
export type OutstandingInput = {
  status: CheckStatus
  releasedAt: Date | null
  checkDate: Date | null
  clearingStatus: ClearingStatus
  clearedDate: Date | null
  amount: string | null
}

export type IssueBasis = 'RELEASED AT' | 'CHEQUE DATE'

export function issuedOn(
  input: Pick<OutstandingInput, 'releasedAt' | 'checkDate'>,
): { day: string; basis: IssueBasis } | null {
  if (input.releasedAt) return { day: manilaDay(input.releasedAt), basis: 'RELEASED AT' }
  if (input.checkDate) return { day: manilaDay(input.checkDate), basis: 'CHEQUE DATE' }
  return null
}

/** The cleared day; `'UNKNOWN'` for CLEARED with no date; null when not cleared. */
export function clearedOn(input: Pick<OutstandingInput, 'clearingStatus' | 'clearedDate'>): string | 'UNKNOWN' | null {
  if (input.clearingStatus !== 'CLEARED') return null
  return input.clearedDate ? manilaDay(input.clearedDate) : 'UNKNOWN'
}

export function isOutstandingAsOf(input: OutstandingInput, asOfDay: string): boolean {
  if (input.status !== 'RELEASED') return false
  if (input.amount === null) return false
  const issued = issuedOn(input)
  if (issued && issued.day > asOfDay) return false
  const cleared = clearedOn(input)
  if (cleared === 'UNKNOWN') return false
  if (cleared !== null && cleared <= asOfDay) return false
  return true
}
