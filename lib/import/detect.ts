import { BILL_SHEET } from './bills'
import type { RawRow } from './workbook'

/**
 * Which of the client's two workbooks a file is.
 *
 * They are different shapes with different grains — the register is one row per
 * cheque across fifteen hand-maintained sheets, the approval-for-release export
 * is one row per bill on a single machine-generated sheet — and they feed
 * different tables. Asking the operator to declare which one they just picked is
 * a question the file already answers, and the cost of getting the answer wrong
 * is not a friendly error: a bills file parsed as a register imports 85 rows of
 * nonsense, and a register parsed as bills silently imports nothing at all.
 *
 * Measured on both real files, 2026-09-04, and the basis of every rule below.
 */

/** The approval-for-release workbook's complete sheet list. `PIVOT` is a pivot
 * table over `LIST`; `lib/import/bills.ts` reads `LIST` only. */
export const BILL_WORKBOOK_SHEETS: readonly string[] = [BILL_SHEET, 'PIVOT']

/**
 * The register's fifteen sheets, as measured. Used only to RECOGNISE a
 * register, never to decide what to do with one — `parseRows` reads every sheet
 * a register file carries, including names that are not on this list, because
 * Finance adds sheets. Do not turn this into an allow-list.
 */
export const REGISTER_SHEETS: readonly string[] = [
  'BPI RELEASED', 'MBTC RELEASED', 'STK P&P RELEASED', 'MBTC P&P RELEASED',
  'BPI A1 RELEASED', 'BDO RELEASED', 'BPI STK AVAIL.', 'MBTC AVAIL.',
  'MBTC P&P', 'BPI PAPER AND PLASTIC', 'BPI A1 AVAIL.', 'BDO AVAIL.',
  'FT & MC', 'CANCELLED', 'CHECK FINDING',
]

export type WorkbookDetection =
  | { kind: 'REGISTER'; sheets: string[]; dataRows: number }
  | { kind: 'BILLS'; sheets: string[]; dataRows: number }
  | { kind: 'UNKNOWN'; sheets: string[]; dataRows: number; reason: string }

const norm = (s: string) => s.trim().toUpperCase()

/**
 * Pure: raw rows in (header rows already dropped by `readWorkbook`), a verdict
 * out. Never throws — an unrecognised file is a `UNKNOWN` carrying the sheet
 * names, which is what a human needs in order to say what they uploaded.
 *
 * **Refuses to guess.** A file carrying sheets of both shapes, or of neither,
 * is UNKNOWN rather than assigned to whichever rule fired first. Ingestion is
 * the one place in this system that writes twelve thousand rows without a human
 * looking at each one; a wrong guess here is not a wrong screen, it is a wrong
 * ledger.
 */
export function detectWorkbook(rows: readonly RawRow[]): WorkbookDetection {
  const sheets = [...new Set(rows.map((r) => r.sheet))]
  const dataRowsAll = rows.length

  const billSheets = new Set(BILL_WORKBOOK_SHEETS.map(norm))
  const registerSheets = new Set(REGISTER_SHEETS.map(norm))

  const looksLikeBills = sheets.some((s) => norm(s) === norm(BILL_SHEET))
  const looksLikeRegister = sheets.some((s) => registerSheets.has(norm(s)))

  if (looksLikeBills && looksLikeRegister) {
    return {
      kind: 'UNKNOWN', sheets, dataRows: dataRowsAll,
      reason: 'This file carries both a bill-detail sheet and cheque-register sheets. ' +
        'The two have different grains and cannot be imported together.',
    }
  }

  if (looksLikeBills) {
    const stray = sheets.filter((s) => !billSheets.has(norm(s)))
    if (stray.length > 0) {
      return {
        kind: 'UNKNOWN', sheets, dataRows: dataRowsAll,
        reason: `Bill detail was expected on ${BILL_WORKBOOK_SHEETS.join(' and ')} only, but ` +
          `this file also carries ${stray.join(', ')}.`,
      }
    }
    // Only LIST is counted. PIVOT's rows are derived subtotals; reporting them
    // as importable would promise bills that are not there.
    const dataRows = rows.filter((r) => norm(r.sheet) === norm(BILL_SHEET)).length
    if (dataRows === 0) {
      return {
        kind: 'UNKNOWN', sheets, dataRows: dataRowsAll,
        reason: `The ${BILL_SHEET} sheet has no data rows.`,
      }
    }
    return { kind: 'BILLS', sheets, dataRows }
  }

  if (looksLikeRegister) {
    if (dataRowsAll === 0) {
      return { kind: 'UNKNOWN', sheets, dataRows: 0, reason: 'The workbook has no data rows.' }
    }
    return { kind: 'REGISTER', sheets, dataRows: dataRowsAll }
  }

  return {
    kind: 'UNKNOWN', sheets, dataRows: dataRowsAll,
    reason: sheets.length === 0
      ? 'The workbook has no sheets with data rows.'
      : `None of these sheets belongs to either workbook: ${sheets.join(', ')}.`,
  }
}
