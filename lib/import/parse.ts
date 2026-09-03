import { sniff } from './field-sniffer'
import { cleanCell, excelSerialToDate } from './normalise'
import type { RawRow } from './workbook'

export type ParsedRow = {
  sheet: string
  row: number
  checkNumber: string | null
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  checkBook: string | null
  category: string | null
  clearingRef: string | null
  checkDate: Date | null
  amount: string | null
  payee: string | null
  unclassified: string[]
}

export type ReviewItem = { sheet: string; row: number; reason: 'NO_CHECK_NUMBER'; cells: unknown[] }

// A row with no cheque number cannot be keyed and is sent for review rather
// than dropped. Nothing is ever discarded silently: parsed.length +
// review.length always equals the input length.
export function parseRows(rows: RawRow[]): { parsed: ParsedRow[]; review: ReviewItem[] } {
  const parsed: ParsedRow[] = []
  const review: ReviewItem[] = []

  for (const raw of rows) {
    const r: ParsedRow = {
      sheet: raw.sheet, row: raw.row,
      checkNumber: null, cvNumber: null, apvNumbers: [], poNumbers: [],
      checkBook: null, category: null, clearingRef: null,
      checkDate: null, amount: null, payee: null, unclassified: [],
    }

    for (const cell of raw.cells) {
      if (cell instanceof Date) { r.checkDate ??= cell; continue }
      const kind = sniff(cell)
      const text = cleanCell(cell)
      switch (kind) {
        case 'APV': if (text) r.apvNumbers.push(text.toUpperCase()); break
        case 'CV': r.cvNumber ??= text?.toUpperCase() ?? null; break
        case 'PO': if (text) r.poNumbers.push(text.toUpperCase()); break
        case 'CHECKBOOK': r.checkBook ??= text?.toUpperCase() ?? null; break
        case 'CHECK_NUMBER': r.checkNumber ??= text; break
        case 'DATE_SERIAL': r.checkDate ??= excelSerialToDate(Number(cell)); break
        case 'CATEGORY': r.category ??= text?.toUpperCase() ?? null; break
        case 'CLEARING_REF': r.clearingRef ??= text?.toUpperCase() ?? null; break
        default: if (text) r.unclassified.push(text)
      }
    }

    if (!r.checkNumber) {
      review.push({ sheet: raw.sheet, row: raw.row, reason: 'NO_CHECK_NUMBER', cells: raw.cells })
      continue
    }

    // 1,508 distinct cells in the register hold a PO number followed by its
    // description in one cell:
    //   "PO-ST-027363 WEEKLY DIRECT (DISNEY) D2, D5, D7 ... (11 PAX)"
    // `sniff` correctly returns UNKNOWN for these — the cell is not *just* a PO —
    // so the parser recovers both halves rather than losing the PO number.
    // Verified count: running `sniff` over the register's 47,356 distinct strings
    // left exactly 1,508 document-shaped cells unclassified, all of this form.
    for (let i = r.unclassified.length - 1; i >= 0; i--) {
      const m = /^(P[OR]-[A-Z0-9]{1,4}-?\d+)\s+(.+)$/.exec(r.unclassified[i])
      if (!m) continue
      r.poNumbers.push(m[1].toUpperCase())
      r.unclassified[i] = m[2].trim()   // the description survives as free text
    }

    // Payee and description are both free text. The description is reliably the
    // longer of the two in this register, so the shorter one is the payee.
    const candidates = [...r.unclassified].sort((a, b) => a.length - b.length)
    r.payee = candidates[0] ?? null

    parsed.push(r)
  }

  return { parsed, review }
}
