import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { sniff } from './field-sniffer'
import { canonicalCheckNumber, cleanCell, excelSerialToDate, isBareCheckNumber } from './normalise'
import { readAmount } from './parse'
import type { RawRow } from './workbook'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Bill detail from `APPROVAL FOR RELEASE 9.4.2026.xlsx`, which is NOT the
 * cheque register.
 *
 * Two things about it govern everything below.
 *
 * **Its grain is one row per bill**, where the register's is one row per cheque.
 * The register puts every APV a cheque settles on that cheque's single row and
 * publishes no per-bill amount; this workbook publishes the amount, due date,
 * terms, GL account and creator of each bill separately. That is why the two
 * feed different tables — `Check.apvNumbers` is a reference list, `CheckBill` is
 * a ledger — and why this parser produces neither a `ParsedRow` nor a
 * `NormalisedRow`. Do not route it through `upsertCheck`: it has no cheque to
 * create, only detail to hang on one that already exists.
 *
 * **It is a current snapshot, not history** — the approval-for-release working
 * list as of 4 September 2026. It says nothing whatsoever about cheques outside
 * it, so nothing here deletes or deactivates a cheque or a bill this file does
 * not mention. An absence in this file is not evidence.
 */

// Measured on the real workbook: two sheets, `LIST` with 85 data rows and
// `PIVOT` with a pivot table over it. PIVOT's rows are derived subtotals, not
// bills — importing one would double-count a bill — so only LIST is read.
// Nothing is lost by skipping PIVOT: every figure on it is computed from LIST.
export const BILL_SHEET = 'LIST'

// The LIST sheet's columns, 0-indexed exactly as `readWorkbook` yields a row's
// cells. Positional, unlike the register's parser, and legitimately so: this is
// one machine-generated Acumatica export with one header row, not fifteen
// hand-maintained sheets whose columns drift. The header row measured
// 2026-09-04 reads, in order: Date, Post Period, Reference Nbr., Vendor Ref.,
// Vendor Name, Balance Amount, Description, Due Date, Type, Detail Total, Terms
// Code, Created By, NO. OF DAYS, four ageing buckets, OVER 90 DAYS, GL Account,
// FINANCE REMARKS, Payment Ref. #, check No., bank.
//
// Re-measure these before pointing the parser at a differently generated
// export. They are not sniffed, so a shifted column would be read as the wrong
// field silently.
const COL = {
  REFERENCE_NBR: 2,   // -> CheckBill.apvNumber
  VENDOR_REF: 3,      // -> CheckBill.poNumber
  DESCRIPTION: 6,     // -> CheckBill.description
  DUE_DATE: 7,        // -> CheckBill.dueDate
  DETAIL_TOTAL: 9,    // -> CheckBill.amount
  TERMS_CODE: 10,     // -> CheckBill.termsCode
  CREATED_BY: 11,     // -> CheckBill.createdByName
  GL_ACCOUNT: 17,     // -> CheckBill.glAccount
  FINANCE_REMARKS: 18,
  CHECK_NO: 20,       // links to Check.checkNumber
  BANK: 21,           // a cash-account label, not a bank name
} as const

export type ParsedBill = {
  // Provenance, so a reconciliation report can point a human at the cell.
  sheet: string
  row: number

  /**
   * Canonical, through `canonicalCheckNumber` — the single place that rule
   * lives. Non-nullable by construction: a bill whose `check No.` is not a
   * cheque number cannot be matched to one and goes to review instead, so it
   * never reaches `bills`.
   */
  checkNumber: string
  /** What the cell actually held, verbatim, for the review report to show. */
  statedCheckRef: string

  // `CheckBill.apvNumber` and `.amount` are both NOT NULL, so both are
  // non-nullable here for the same reason `checkNumber` is: a bill missing
  // either cannot be written without inventing it.
  apvNumber: string
  /** A decimal string, never a JS number. `Decimal(18,2)`; a float round-trip
   * is how centavos go missing. */
  amount: string

  poNumber: string | null
  description: string | null
  glAccount: string | null
  dueDate: Date | null
  termsCode: string | null
  createdByName: string | null

  /**
   * The `bank` column, which holds a cash-account label (`MBTC P&P`, `BPI STK`)
   * rather than a bank name. All 85 rows carry one, and it is a company signal
   * the register lacks for some cheques.
   *
   * Carried, deliberately NOT used. Feeding it to `resolveCompany` to promote a
   * `NO_COMPANY` staged row is the sync's job and out of this task's scope; it
   * is here so that work has the signal without re-reading the workbook.
   */
  cashAccountLabel: string | null

  /**
   * `FINANCE REMARKS`, which is `AVAILABLE` on all 85 rows.
   *
   * It corroborates READY_FOR_RELEASE and it is NOT an instruction. Import
   * never changes release status (decision D4, enforced by
   * `IMMUTABLE_ON_UPDATE`): Acumatica does not know whether Finance has signed
   * a cheque, and this workbook does not either. The remark is evidence for a
   * human. Nothing in this module may turn it into a status.
   */
  financeRemark: string | null
}

export type BillReviewReason = 'NO_CHECK_NUMBER' | 'NO_APV' | 'NO_AMOUNT'

export type BillReviewItem = {
  sheet: string
  row: number
  reason: BillReviewReason
  cells: unknown[]
}

// The due date is a real date cell on all 85 rows, but ExcelJS yields a bare
// serial when a date cell carries no date format, so both are read. Same
// Invalid-Date guard the register's parser needs: ExcelJS produces one for a
// malformed cell, it passes `instanceof Date`, and Prisma throws on write.
function readDate(cell: unknown): Date | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell
  if (typeof cell === 'number' && sniff(cell) === 'DATE_SERIAL') return excelSerialToDate(cell)
  return null
}

/**
 * Pure: a grid in, bills and a review queue out. No database, no clock.
 *
 * Nothing is dropped. For rows on `BILL_SHEET`,
 * `bills.length + review.length === rows.length`; rows on any other sheet are
 * not bills at all and are skipped without a review item.
 */
export function parseBillRows(rows: readonly RawRow[]): {
  bills: ParsedBill[]
  review: BillReviewItem[]
} {
  const bills: ParsedBill[] = []
  const review: BillReviewItem[] = []

  for (const raw of rows) {
    if (raw.sheet !== BILL_SHEET) continue

    const flag = (reason: BillReviewReason) =>
      review.push({ sheet: raw.sheet, row: raw.row, reason, cells: raw.cells })

    // Deliberately NOT filtered on `Type = Bill`. 84 of the 85 rows say Bill and
    // the 85th (row 41) has an empty Type cell along with an empty Created By,
    // while carrying a perfectly good APV, amount and cheque number. Filtering
    // on the column would silently drop a genuine bill to enforce a property of
    // the file rather than a fact about the row.

    // The cheque cell is a numeric cell on all 84 usable rows, so the number has
    // to survive the trip back to a string. `String(6000338925)` is exact —
    // these are integers well inside the safe range — and `cleanCell` handles
    // the text form. The 85th row (row 81) holds a *date* here; it is a bill
    // with no cheque number, not an error, and it goes to review.
    const checkCell = raw.cells[COL.CHECK_NO]
    const stated = checkCell instanceof Date ? null : cleanCell(checkCell)
    // The single cheque-number rule, shared with the register importer and the
    // Acumatica mapper. Acumatica prefixes 90.0% of its refs with a bank code
    // (`BPI 6000240287`) while the register writes them bare, so matching a bill
    // on a raw string would silently match nothing. Do not normalise here.
    const checkNumber = canonicalCheckNumber(stated)
    if (stated === null || checkNumber === null || !isBareCheckNumber(checkNumber)) {
      flag('NO_CHECK_NUMBER')
      continue
    }

    const apvNumber = cleanCell(raw.cells[COL.REFERENCE_NBR])?.toUpperCase() ?? null
    if (apvNumber === null) {
      flag('NO_APV')
      continue
    }

    // One money reader for both workbooks, including its refusal to expand an
    // exponent form. Measured on this file: all 85 Detail Totals are numeric
    // cells, none in exponent form, none with more than two decimal places, so
    // nothing here is silently reshaped.
    //
    // A total that states its own currency — the register's "USD 300000" form —
    // is sent to review rather than stored: `CheckBill` has no currency column,
    // because a bill's currency is its cheque's, and writing the bare number
    // would relabel it as whatever the cheque says. It does not occur in this
    // file; it is refused rather than guessed if it ever does.
    const money = readAmount(raw.cells[COL.DETAIL_TOTAL])
    if (money === null || money.currency !== null) {
      flag('NO_AMOUNT')
      continue
    }

    bills.push({
      sheet: raw.sheet,
      row: raw.row,
      checkNumber,
      statedCheckRef: stated,
      apvNumber,
      amount: money.amount,
      poNumber: cleanCell(raw.cells[COL.VENDOR_REF])?.toUpperCase() ?? null,
      description: cleanCell(raw.cells[COL.DESCRIPTION]),
      glAccount: cleanCell(raw.cells[COL.GL_ACCOUNT]),
      dueDate: readDate(raw.cells[COL.DUE_DATE]),
      termsCode: cleanCell(raw.cells[COL.TERMS_CODE]),
      createdByName: cleanCell(raw.cells[COL.CREATED_BY]),
      cashAccountLabel: cleanCell(raw.cells[COL.BANK])?.toUpperCase() ?? null,
      financeRemark: cleanCell(raw.cells[COL.FINANCE_REMARKS])?.toUpperCase() ?? null,
    })
  }

  return { bills, review }
}

export type UnmatchedBillReason = 'NO_MATCHING_CHECK' | 'AMBIGUOUS_CHECK'

export type UnmatchedBill = {
  sheet: string
  row: number
  checkNumber: string
  apvNumber: string
  reason: UnmatchedBillReason
  /** The company codes a contested cheque number resolves to, for the human
   * who has to settle it. Empty for NO_MATCHING_CHECK. */
  companies: string[]
}

export type BillImportSummary = {
  bills: number
  created: number
  updated: number
  unmatched: UnmatchedBill[]
}

/**
 * Which cheque each bill belongs to, or why it belongs to none. Reads; writes
 * nothing.
 *
 * Extracted so the import PREVIEW can tell an operator how many of the 85 bills
 * will find their cheque *before* anything is written, using the same matching
 * the write path uses. A preview with its own lookup would be a second place
 * for the "two matches is a review item, not a coin toss" rule to live.
 */
export async function matchBills(
  db: Db,
  bills: readonly ParsedBill[],
): Promise<{ matched: { bill: ParsedBill; checkId: string }[]; unmatched: UnmatchedBill[] }> {
  const matched: { bill: ParsedBill; checkId: string }[] = []
  const unmatched: UnmatchedBill[] = []

  for (const bill of bills) {
    // Looked up on the cheque number alone rather than on
    // `(companyId, checkNumber)`. The `bank` column would resolve a company for
    // all 85 rows, but using it to *choose* between two cheques that share a
    // number would be this module deciding which company a bill belongs to,
    // which is exactly the ambiguity a human is meant to settle. Two matches is
    // a review item, not a coin toss.
    const matches = await db.check.findMany({
      where: { checkNumber: bill.checkNumber },
      select: { id: true, company: { select: { code: true } } },
    })

    if (matches.length === 1) {
      matched.push({ bill, checkId: matches[0].id })
      continue
    }

    // Not an error. A bill whose cheque is missing is expected: the cheque may
    // be staged for want of a company, or simply absent from the register. The
    // bill is kept whole and put in front of somebody rather than dropped.
    unmatched.push({
      sheet: bill.sheet,
      row: bill.row,
      checkNumber: bill.checkNumber,
      apvNumber: bill.apvNumber,
      reason: matches.length === 0 ? 'NO_MATCHING_CHECK' : 'AMBIGUOUS_CHECK',
      companies: matches.map((m) => m.company.code),
    })
  }

  return { matched, unmatched }
}

export type BillPreview = {
  /** Every row on the `LIST` sheet: `bills + review` accounts for all of them. */
  totalRows: number
  bills: number
  review: BillReviewItem[]
  willImport: number
  unmatched: UnmatchedBill[]
}

/**
 * What importing this file would do, without doing it. Same shape of honesty
 * the register preview owes: the rows that will NOT land are reported beside
 * the ones that will, not inferred from a shortfall.
 */
export async function previewBillImport(
  db: Db,
  args: { bills: readonly ParsedBill[]; review: readonly BillReviewItem[] },
): Promise<BillPreview> {
  const { matched, unmatched } = await matchBills(db, args.bills)
  return {
    totalRows: args.bills.length + args.review.length,
    bills: args.bills.length,
    review: [...args.review],
    willImport: matched.length,
    unmatched,
  }
}

/**
 * Hang parsed bill detail on the cheques that already exist. Writes `CheckBill`
 * rows and nothing else.
 *
 * Never touches `Check`. Not "does not currently" — there is no code path here
 * that could, which is the point: this workbook's `FINANCE REMARKS = AVAILABLE`
 * looks like a status and is not one.
 *
 * Idempotent on `(checkId, apvNumber)`, which is a unique index on the table.
 * Note what that key does NOT say: it does not forbid a cheque carrying several
 * bills. All 85 rows of the 4 September snapshot happen to name distinct
 * cheques, but that is a property of one day's working list, not of the domain —
 * the register carries cheques settling several bills and `CheckBill` is
 * correctly one-to-many. Do not turn this into a unique constraint on `checkId`.
 */
export async function importBills(
  db: Db,
  args: { bills: readonly ParsedBill[]; now: Date },
): Promise<BillImportSummary> {
  const { matched, unmatched } = await matchBills(db, args.bills)
  const summary: BillImportSummary = {
    bills: args.bills.length, created: 0, updated: 0, unmatched,
  }

  for (const { bill, checkId } of matched) {
    const data = {
      poNumber: bill.poNumber,
      description: bill.description,
      glAccount: bill.glAccount,
      dueDate: bill.dueDate,
      termsCode: bill.termsCode,
      // A decimal string all the way to Prisma. Never `Number(bill.amount)`.
      amount: bill.amount,
      createdByName: bill.createdByName,
    }

    const existing = await db.checkBill.findUnique({
      where: { checkId_apvNumber: { checkId, apvNumber: bill.apvNumber } },
      select: { id: true },
    })

    await db.checkBill.upsert({
      where: { checkId_apvNumber: { checkId, apvNumber: bill.apvNumber } },
      create: { checkId, apvNumber: bill.apvNumber, ...data },
      update: data,
    })

    if (existing) summary.updated++
    else summary.created++

    await writeAudit(db, {
      checkId,
      actorType: 'SYSTEM',
      action: existing ? 'bill_updated' : 'bill_imported',
      details: {
        source: 'WORKBOOK',
        apvNumber: bill.apvNumber,
        sourceSheet: bill.sheet,
        sourceRow: bill.row,
        // Recorded, not acted on. A human reading the trail should be able to
        // see that the workbook called this bill AVAILABLE and that the import
        // left the cheque's status exactly where it found it.
        financeRemark: bill.financeRemark,
        cashAccountLabel: bill.cashAccountLabel,
        at: args.now.toISOString(),
      },
      remarks:
        `Bill ${bill.apvNumber} ${existing ? 'updated' : 'imported'} from the approval-for-release ` +
        `workbook (${bill.sheet} row ${bill.row}). Release status unchanged.`,
    })
  }

  return summary
}
