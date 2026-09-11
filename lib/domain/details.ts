import { DomainError } from './errors'

/**
 * THE FOUR THINGS FINANCE TYPED INTO THE REGISTER — AND ONE IT NEVER COULD.
 *
 * Remarks, the point person, who is holding the cheque, and its category
 * (2026-09-11); and, since 2026-09-12, the day Finance expects the money to
 * leave the bank, which the forecast buckets on when it is set.
 *
 * Pure. No status is involved: a note can go on a cancelled cheque. An empty
 * box is stored as null, not as "", so "nothing recorded" stays one value.
 * The category is folded to upper case because the import folds it. The date
 * is held here as an ISO day string — the shape a form sends and an audit row
 * reads — and `updateDetails` converts it to the column's UTC-midnight instant
 * at the write. A string that is not a day is refused, never coerced.
 */

export const DETAIL_FIELDS = ['remarks', 'pointPerson', 'checksPossession', 'category', 'expectedOutflowDate'] as const
export type DetailField = (typeof DETAIL_FIELDS)[number]
export type DetailValues = Record<DetailField, string | null>
/** `undefined` means the form did not send the field; it is left as it is. */
export type DetailInput = Partial<Record<DetailField, string | null | undefined>>
export type DetailChange = { from: string | null; to: string | null }

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for `YYYY-MM-DD` naming a real calendar day (not 2026-02-30). */
export function isIsoDay(s: string): boolean {
  const m = ISO_DAY.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** A day as the UTC-midnight instant every date column stores. Caller has checked `isIsoDay`. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** The UTC calendar day of a stored date column, or null. */
export function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}

function clean(value: string | null): string | null {
  const s = (value ?? '').trim()
  return s === '' ? null : s
}

export function normaliseDetails(input: DetailInput, current: DetailValues): DetailValues {
  const out: DetailValues = { ...current }
  for (const field of DETAIL_FIELDS) {
    const v = input[field]
    if (v === undefined) continue
    const cleaned = clean(v)
    if (field === 'expectedOutflowDate' && cleaned !== null && !isIsoDay(cleaned)) {
      throw new DomainError('INVALID_DATE', 'EXPECTED OUT must be a date, YYYY-MM-DD.')
    }
    out[field] = field === 'category' && cleaned !== null ? cleaned.toUpperCase() : cleaned
  }
  return out
}

export function diffDetails(
  before: DetailValues, after: DetailValues,
): Partial<Record<DetailField, DetailChange>> {
  const changes: Partial<Record<DetailField, DetailChange>> = {}
  for (const field of DETAIL_FIELDS) {
    if (before[field] !== after[field]) changes[field] = { from: before[field], to: after[field] }
  }
  return changes
}
