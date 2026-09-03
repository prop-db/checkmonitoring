import { sniff } from './field-sniffer'
import { cleanCell, excelSerialToDate } from './normalise'
import type { RawRow } from './workbook'

export type ParsedRow = {
  sheet: string
  row: number
  // Non-nullable by construction: a row without a cheque number cannot be keyed
  // and goes to the review queue instead, so it never reaches `parsed`. Typing
  // this `string | null` would make every downstream consumer handle a case
  // that cannot occur — and `reconcile` cannot key a Map on a nullable value.
  checkNumber: string
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  checkBook: string | null
  cashAccountLabel: string | null
  category: string | null
  clearingRef: string | null
  checkDate: Date | null
  amount: string | null
  payee: string | null
  unclassified: string[]
}

export type ReviewItem = { sheet: string; row: number; reason: 'NO_CHECK_NUMBER'; cells: unknown[] }

// While a row is being assembled its cheque number may still be absent. The
// draft carries that possibility; `ParsedRow` does not, and the narrowing
// happens at the one point where the row is accepted.
type Draft = Omit<ParsedRow, 'checkNumber'> & { checkNumber: string | null }

// A row with no cheque number cannot be keyed and is sent for review rather
// than dropped. Nothing is ever discarded silently: parsed.length +
// review.length always equals the input length.
export function parseRows(rows: RawRow[]): { parsed: ParsedRow[]; review: ReviewItem[] } {
  const parsed: ParsedRow[] = []
  const review: ReviewItem[] = []

  for (const raw of rows) {
    const r: Draft = {
      sheet: raw.sheet, row: raw.row,
      checkNumber: null, cvNumber: null, apvNumbers: [], poNumbers: [],
      checkBook: null, cashAccountLabel: null, category: null, clearingRef: null,
      checkDate: null, amount: null, payee: null, unclassified: [],
    }

    for (const cell of raw.cells) {
      if (cell instanceof Date) {
        // ExcelJS yields an Invalid Date for a malformed date cell. It passes
        // `instanceof Date`, so without this guard it reaches Prisma, which
        // throws on write — the real register has three such cells, all on the
        // CANCELLED sheet. Treat it as no date rather than an invalid one; the
        // row still imports, it simply has no check date.
        if (!Number.isNaN(cell.getTime())) r.checkDate ??= cell
        continue
      }
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
        case 'AMOUNT': r.amount ??= text?.replace(/,/g, '') ?? null; break
        // A status word is neither a field nor free text; dropping it keeps it
        // out of the payee candidates.
        case 'CASH_ACCOUNT': r.cashAccountLabel ??= text?.toUpperCase() ?? null; break
        case 'STATUS_WORD': break
        default: if (text) r.unclassified.push(text)
      }
    }

    const checkNumber = r.checkNumber
    if (!checkNumber) {
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

    // The payee is column E on every sheet. Measured across all fifteen: 88-100%
    // of rows carry a company name there, and the samples are unambiguous
    // (STARKSON PACKAGING INC., Easytrip Services Corporation, RACNET
    // INFORMATION TECHNOLOGY). The columns that drift between sheets are the
    // APV, CV and PO — not this one.
    //
    // The earlier heuristic — shortest lettered unclassified string — was
    // guessing at something knowable, and produced four separate classes of
    // wrong payee against the real register: amounts (8,254 rows), cash-account
    // labels (1,264), and point-person names (~400). Reading the column is both
    // simpler and correct.
    //
    // When column E is empty the payee is null. There is deliberately **no
    // fallback**: guessing from the rest of the row is exactly what produced
    // those four classes of wrong payee, and a missing payee is better than an
    // invented one.
    //
    // It is also the safe direction. `classifyEligibility` treats a blank payee
    // as INTERNAL, so a cheque whose payee we do not know is never pushed to the
    // supplier portal — whereas a guessed payee could be classified SUPPLIER and
    // published. Rows without a payee still import; they simply have none, and
    // the reconciliation report surfaces them.
    const PAYEE_COLUMN = 4
    const atColumn = raw.cells[PAYEE_COLUMN]
    const fromColumn =
      atColumn instanceof Date || sniff(atColumn) !== 'UNKNOWN' ? null : cleanCell(atColumn)

    r.payee = fromColumn && /[A-Za-z]/.test(fromColumn) ? fromColumn : null

    // The one narrowing point: past the guard above, the cheque number is known
    // to exist, so the row satisfies ParsedRow rather than Draft.
    parsed.push({ ...r, checkNumber })
  }

  return { parsed, review }
}
