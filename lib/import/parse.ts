import { sniff } from './field-sniffer'
import { canonicalCheckBook, cleanCell, excelSerialToDate } from './normalise'
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
  // Only set when the register states it inline, as "USD 300000". A bare
  // number leaves this null; choosing a default is the upsert's decision, made
  // once and visibly, rather than invented here.
  currency: string | null
  payee: string | null
  unclassified: string[]
}

/**
 * A row as far as it parsed, with no cheque number. `checkNumber` is `null` by
 * construction rather than optional: this is the shape of a row that failed the
 * one narrowing test in `parseRows`, not a half-built one.
 */
export type UnkeyedRow = Omit<ParsedRow, 'checkNumber'> & { checkNumber: null }

export type ReviewItem = {
  sheet: string
  row: number
  reason: 'NO_CHECK_NUMBER'
  cells: unknown[]
  /**
   * Everything the row DID say — payee, amount, date, category, APVs.
   *
   * Carried so the 66 register rows that cannot be keyed reach `StagedCheck`
   * as legible cheques rather than as a sheet name and a row number. They are
   * staged, not discarded (see `StagedReason.NO_CHECK_NUMBER`), and a staged
   * row a human cannot recognise is only nominally better than a dropped one.
   *
   * Re-deriving these from `cells` at the staging site would mean a second copy
   * of the payee and amount column rules, which is how the two ends of this
   * importer drift apart.
   */
  unkeyed: UnkeyedRow
}

// The amount is column J on every sheet, headed "CHECK AMOUNT" or "AMOUNT".
// Measured over the register's 12,227 data rows: 11,827 numbers, 260 empty,
// 135 the word "CANCELLED", 2 dates on shifted rows, 2 with a currency prefix,
// 1 a stray newline. As with the payee in column E, this is read positionally
// because it is knowable — letting any amount-shaped cell in the row win a
// `??=` race is what produced the wrong-payee classes this parser already
// documents, and REMARKS on STK P&P RELEASED holds six figures that are not
// the cheque amount.
const AMOUNT_COLUMN = 9

/**
 * A money value the source actually states, or nothing. Never a guess.
 *
 * Exported because `lib/import/bills.ts` reads the approval-for-release
 * workbook's `Detail Total` with it. A second money reader is a second place
 * for centavos to go missing, so there is one — the two workbooks disagree
 * about almost everything else, but not about what a number means.
 */
export function readAmount(cell: unknown): { amount: string; currency: string | null } | null {
  if (typeof cell === 'number') {
    const s = String(cell)
    // Rejects exponent forms (>=1e21, <1e-6). Nothing in that range is a
    // cheque amount, and expanding one risks inventing digits. Verified: no
    // row in the register renders in exponent form, and none carries more than
    // two decimal places, so nothing here is silently reshaped.
    return Number.isFinite(cell) && /^-?\d+(\.\d+)?$/.test(s) ? { amount: s, currency: null } : null
  }
  if (typeof cell !== 'string') return null   // Date on a shifted row, or nothing

  const s = cell.trim().replace(/\s+/g, ' ').toUpperCase()
  if (s === '') return null

  // "USD 300000" — FT & MC records two cheques this way. Read as a bare number
  // they would import as pesos and understate the cheque by the exchange rate.
  const withCurrency = /^([A-Z]{3}) (-?[\d,]+(?:\.\d+)?)$/.exec(s)
  if (withCurrency) return { amount: withCurrency[2].replace(/,/g, ''), currency: withCurrency[1] }

  const bare = s.replace(/,/g, '')
  if (/^-?\d+(\.\d+)?$/.test(bare)) return { amount: bare, currency: null }

  return null   // "CANCELLED", "\n", anything else the column happens to hold
}

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
      checkDate: null, amount: null, currency: null, payee: null, unclassified: [],
    }

    const money = readAmount(raw.cells[AMOUNT_COLUMN])
    r.amount = money?.amount ?? null
    r.currency = money?.currency ?? null

    for (let idx = 0; idx < raw.cells.length; idx++) {
      // The amount cell has already been read. Skipping it keeps 11,827 figures
      // out of the free-text pool — but only when it *was* an amount, so the
      // two shifted rows whose column J holds a date still offer it to the
      // date rule below rather than losing it.
      if (idx === AMOUNT_COLUMN && money) continue
      const cell = raw.cells[idx]
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
        // canonicalCheckBook corrects MBT-S-9048, which Finance confirmed is a
        // mis-keying of MBT-A-9048 and is deliberately not in the reference data.
        // Correcting here rather than at lookup means the typo never reaches the
        // database at all.
        case 'CHECKBOOK': r.checkBook ??= canonicalCheckBook(text); break
        case 'CHECK_NUMBER': r.checkNumber ??= text; break
        case 'DATE_SERIAL': r.checkDate ??= excelSerialToDate(Number(cell)); break
        case 'CATEGORY': r.category ??= text?.toUpperCase() ?? null; break
        case 'CLEARING_REF': r.clearingRef ??= text?.toUpperCase() ?? null; break
        // Classified so it cannot compete to be free text or a payee, but not
        // assigned: the amount comes from column J and nowhere else.
        case 'AMOUNT': break
        // A status word is neither a field nor free text; dropping it keeps it
        // out of the payee candidates.
        case 'CASH_ACCOUNT': r.cashAccountLabel ??= text?.toUpperCase() ?? null; break
        case 'STATUS_WORD': break
        default: if (text) r.unclassified.push(text)
      }
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

    // The cheque-number test comes AFTER the payee and PO recovery above, not
    // before it. Both are pure functions of the cells and of nothing else, so
    // moving them ahead of the test changes no parsed row — and it means a row
    // that cannot be keyed still carries its payee, amount and PO into the
    // review queue, and from there onto the `StagedCheck` row a human has to
    // recognise. Do not "tidy" the guard back above them.
    const checkNumber = r.checkNumber
    if (!checkNumber) {
      review.push({
        sheet: raw.sheet, row: raw.row, reason: 'NO_CHECK_NUMBER', cells: raw.cells,
        unkeyed: { ...r, checkNumber: null },
      })
      continue
    }

    // The one narrowing point: past the guard above, the cheque number is known
    // to exist, so the row satisfies ParsedRow rather than Draft.
    parsed.push({ ...r, checkNumber })
  }

  return { parsed, review }
}
