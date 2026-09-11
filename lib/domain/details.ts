/**
 * THE FOUR THINGS FINANCE TYPED INTO THE REGISTER.
 *
 * Remarks, the point person, who is holding the cheque, and its category. The
 * columns have existed since Plan 1 and were populated on 0, 0, 0 and 101 of
 * 11,950 cheques (measured 2026-09-11), because nothing on any screen could
 * write them. CLAUDE.md's premise since 2026-09-10 — "anything Finance used to
 * type into the register must be typeable here" — is what this module serves.
 *
 * Pure. No status is involved: a note can go on a cancelled cheque. An empty
 * box is stored as null, not as "", so "nothing recorded" stays one value.
 * The category is folded to upper case because the import folds it, and a
 * filter over `PAYROLL` and `Payroll` would be two categories for one thing.
 */

export const DETAIL_FIELDS = ['remarks', 'pointPerson', 'checksPossession', 'category'] as const
export type DetailField = (typeof DETAIL_FIELDS)[number]
export type DetailValues = Record<DetailField, string | null>
/** `undefined` means the form did not send the field; it is left as it is. */
export type DetailInput = Partial<Record<DetailField, string | null | undefined>>
export type DetailChange = { from: string | null; to: string | null }

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
