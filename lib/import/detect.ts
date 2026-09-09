import { isBillSheet } from './bills'
import type { RawRow } from './workbook'

/**
 * Which of the client's two workbooks a file is.
 *
 * They are different shapes with different grains — the register is one row per
 * cheque across fifteen hand-maintained sheets, the approval-for-release export
 * is one row per bill on machine-generated sheets — and they feed different
 * tables. Asking the operator to declare which one they just picked is a
 * question the file already answers, and the cost of getting the answer wrong
 * is not a friendly error: a bills file parsed as a register imports rows of
 * nonsense, and a register parsed as bills silently imports nothing at all.
 *
 * Measured on both real files, 2026-09-04, re-measured on the 7 and 10
 * September approval workbooks, and the basis of every rule below.
 *
 * **The bills half of this recognises a HEADER, not a sheet name.** It used to
 * list the sheet names `LIST` and `PIVOT` and refuse anything else, which made
 * the 7 September workbook — `Sheet3`, `local supplier`, `BROKERAGE` — an
 * unrecognisable file. Sheet names in this workbook change between exports and
 * the Acumatica header does not.
 */

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

  const registerSheets = new Set(REGISTER_SHEETS.map(norm))

  // The bill sheets, by their header. A pivot sheet carries an empty row 1 and
  // is not one, whatever it is called this week.
  const billRows = rows.filter((r) => isBillSheet(r.header))
  const looksLikeBills = billRows.length > 0
  const looksLikeRegister = sheets.some((s) => registerSheets.has(norm(s)))

  if (looksLikeBills && looksLikeRegister) {
    return {
      kind: 'UNKNOWN', sheets, dataRows: dataRowsAll,
      reason: 'This file carries both a bill-detail sheet and cheque-register sheets. ' +
        'The two have different grains and cannot be imported together.',
    }
  }

  if (looksLikeBills) {
    // Only the rows on sheets that will actually be read are counted. A pivot
    // sheet's rows are derived subtotals; counting them here would promise
    // bills that are not there — and this number is what the operator compares
    // against the import's own accounting.
    //
    // A sheet without the header is NOT a reason to refuse the file. The
    // workbook has carried a pivot sheet in every export measured, and the
    // parser reports every sheet it skipped by name.
    return { kind: 'BILLS', sheets, dataRows: billRows.length }
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
      : `None of these sheets belongs to either workbook: ${sheets.join(', ')}. A cheque register ` +
        'is recognised by its sheet names and an approval-for-release export by the Acumatica ' +
        'header on row 1 of each sheet, which must name Reference Nbr., Detail Total, FINANCE ' +
        'REMARKS, check No. and bank where this parser expects them.',
  }
}
