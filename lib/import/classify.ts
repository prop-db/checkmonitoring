import type { StagedReason } from '@prisma/client'
import type { NormalisedRow } from '@/lib/normalised-row'

/**
 * Whether a row can be written as a `Check`, or must be kept whole in
 * `StagedCheck` instead — and if so, why.
 *
 * Pure, and extracted from `upsertCheck` so that the import **preview** and the
 * import itself cannot reach different verdicts about the same row. A preview
 * that promised 9,461 imports and then delivered 9,200 would be worse than no
 * preview: the whole point of Task 10 is that Finance can see, before anything
 * lands, exactly which 2,766 rows will not be there afterwards. One rule, one
 * place. Do not re-derive this anywhere else.
 */
export type ImportOutcome =
  // Both identity halves are returned rather than left on the caller to
  // re-narrow: `checkNumber` and `companyCode` are non-null exactly when this
  // branch is taken, and returning them is what lets `upsertCheck` proceed
  // without a non-null assertion that a later edit could quietly invalidate.
  | { write: true; checkNumber: string; companyCode: string }
  | { write: false; reason: StagedReason; conflictingCompanies: string[] }

/**
 * `companies` is every company code the cheque NUMBER resolves to across the
 * whole import, not this row's own — see `groupByCheckNumber`. Undefined means
 * the caller is looking at one row in isolation (the Acumatica sync), and the
 * honest answer there is the row's own company.
 *
 * The order of the three staging tests is load-bearing and is the order in
 * which a defect makes a row unwritable:
 *
 *  1. **No cheque number.** The row cannot be keyed at all, so it is not in any
 *     cheque-number group and cannot be part of an ambiguity.
 *  2. **More than one company.** Every row of a contested number is staged —
 *     Finance ruling of 2026-09-03 — *including* a row that resolves no company
 *     of its own. One of the real register's 61 such rows is exactly that, and
 *     filing it under NO_COMPANY instead would split one cheque's evidence
 *     across two buckets, which is precisely what the human settling it must
 *     not have to notice.
 *  3. **No company.** 2,639 register rows record neither a checkbook nor a cash
 *     account, and `Check.companyId` is required.
 */
export function classifyImportOutcome(
  row: Pick<NormalisedRow, 'checkNumber' | 'companyCode'>,
  companies?: readonly string[],
): ImportOutcome {
  // Two signals naming the same company is agreement, not a conflict: 897
  // register rows resolve their company from the checkbook and the cash account
  // both. Deduping before counting is what keeps those out of the ambiguity
  // bucket.
  const distinct = [...new Set(companies ?? (row.companyCode ? [row.companyCode] : []))]

  const checkNumber = row.checkNumber
  if (checkNumber === null) return { write: false, reason: 'NO_CHECK_NUMBER', conflictingCompanies: [] }
  if (distinct.length > 1) {
    return { write: false, reason: 'AMBIGUOUS_COMPANY', conflictingCompanies: distinct }
  }
  if (row.companyCode === null) return { write: false, reason: 'NO_COMPANY', conflictingCompanies: [] }

  return { write: true, checkNumber, companyCode: row.companyCode }
}
