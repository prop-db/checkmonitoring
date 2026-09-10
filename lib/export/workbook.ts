import ExcelJS from 'exceljs'
import type { CheckTableRow } from '../queries'
import { formatMoney } from '../money'
import {
  bankLabel, currencyNumberFormat, describeScope, fitColumnWidth,
  statusWords, totalsByCurrency,
} from './report'
import {
  HEADER_FILL, BAND_FILL, GRID, DATE_FORMAT, COUNT_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell,
} from './sheet-style'

/**
 * The Excel export, as a workbook.
 *
 * "DON'T JUST EXTRACT IT, EXTRACTION SHOULD LOOK PROFESSIONAL AND CAN BE
 * PRESENTED TO MANAGEMENT" — the client. The formatting below is therefore the
 * requirement, not decoration: a title block that says what the reader is
 * looking at and what was excluded, a frozen header, columns fitted to their
 * own content, amounts that Excel can sum, and totals that never add two
 * currencies together.
 *
 * No database, no session, no request. Everything it needs is passed in, which
 * is what lets the whole file be generated into a buffer and read back cell by
 * cell in `tests/export/workbook.test.ts`.
 */

export const REGISTER_SHEET = 'CHECK REGISTER'
export const SUMMARY_SHEET = 'SUMMARY'

export const REGISTER_HEADERS = [
  'CHECK NUMBER', 'APV NUMBER', 'SUPPLIER NAME', 'COMPANY', 'BANK',
  'CHECK DATE', 'AMOUNT', 'STATUS', 'AVAILABLE DATE', 'PICKUP SCHEDULE',
] as const

/**
 * Four lines of title block, one blank row, then the header on row 6 and the
 * first cheque on row 7. Fixed — never conditional — so a reader opening two
 * exports side by side finds the table in the same place in both, and so the
 * tests address cells by name rather than by arithmetic over optional rows.
 */
export const TITLE_ROWS = 4
export const HEADER_ROW = TITLE_ROWS + 2
export const FIRST_DATA_ROW = HEADER_ROW + 1

const AMOUNT_COLUMN = 7

/**
 * The figures `getSummary` returns, structurally.
 *
 * Written out rather than imported as `Awaited<ReturnType<typeof getSummary>>`
 * so this module needs nothing from Prisma, and so a test can hand it a literal.
 */
export type ExportSummary = {
  total: number
  pendingSignature: number
  signed: number
  readyForRelease: number
  scheduled: number
  released: number
  incomplete: number
  totalsByCurrency: readonly { currency: string; total: string | null; count: number }[]
}

export type ExportMeta = {
  /** The view's short name — "READY FOR RELEASE", "ALL CHEQUES". */
  viewLabel: string
  /** The narrowing filters in words, or "No filters applied". */
  filterDescription: string
  generatedAt: Date
  generatedBy: string
  /** How many cheques the filters match in total, before the row cap. */
  totalMatching: number
}

export type ExportInput = {
  rows: readonly CheckTableRow[]
  summary: ExportSummary
  meta: ExportMeta
}

/**
 * A cheque's amount as an Excel number.
 *
 * THE ONE PLACE in this system where a JS number is an acceptable carrier for
 * money, and the exemption is narrow. Rule 8 exists because a float round-trip
 * loses centavos in arithmetic and in storage; this value does neither. It is
 * written straight into a cell as a presentational figure, never added to
 * anything here (`totalsByCurrency` does the adding in `bigint` centavos and
 * hands back a decimal string), and never read back into the database. A
 * `Decimal(18,2)` peso amount is at most 16 digits before the point — inside
 * IEEE-754's 15-to-17 significant digits, and orders of magnitude inside it for
 * any cheque this company has ever written.
 *
 * The alternative is a text cell, and a text cell is the whole reason this
 * function exists: management has to be able to sum and sort the column.
 */
function amountAsNumber(amount: string): number {
  return Number(amount)
}

/**
 * The four lines above the table.
 *
 * NOT merged, deliberately. A merged cell CLIPS text that is wider than the
 * merge; an unmerged one spills across the empty cells to its right, which is
 * what every spreadsheet does with a report title and is the only behaviour
 * that cannot silently cut the filter line — the longest and the most important
 * of the four — in half.
 */
function titleBlock(
  ws: ExcelJS.Worksheet,
  lines: readonly [string, string, string, string],
) {
  lines.forEach((text, i) => {
    ws.getCell(i + 1, 1).value = text
  })

  const title = ws.getCell(1, 1)
  title.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } }
  ws.getRow(1).height = 24

  ws.getCell(2, 1).font = { bold: true, size: 12, color: { argb: 'FF0F172A' } }
  ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF475569' } }
  ws.getCell(4, 1).font = { size: 10, color: { argb: 'FF475569' } }
}

/** `Generated 06 Sep 2026 at 2:30 PM by Paolo Parcon`. */
function generatedLine(meta: ExportMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

function buildRegisterSheet(wb: ExcelJS.Workbook, { rows, meta }: ExportInput) {
  const ws = wb.addWorksheet(REGISTER_SHEET, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      // The header repeats at the top of every printed page. A management pack
      // whose second page is ten unlabelled columns is not a report.
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
    },
  })

  titleBlock(ws, [
    'CHECK RELEASE MONITORING',
    describeScope(meta.viewLabel, rows.length, meta.totalMatching),
    meta.filterDescription,
    generatedLine(meta),
  ])

  const header = ws.getRow(HEADER_ROW)
  REGISTER_HEADERS.forEach((label, i) => {
    styleHeaderCell(header.getCell(i + 1), label, i + 1 === AMOUNT_COLUMN ? 'right' : 'left')
  })
  header.height = 20

  // The text each column will actually show, gathered as the rows are written
  // so the widths are fitted to real content rather than to a guess. The AMOUNT
  // column is measured on the FORMATTED figure ("₱1,234,567,890.12"), not on
  // the raw decimal string, because the formatted one is what has to fit.
  const widthSamples: string[][] = REGISTER_HEADERS.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(FIRST_DATA_ROW + i)
    const apv = r.apvNumbers.length ? r.apvNumbers.join(', ') : null
    const bank = bankLabel(r.cashAccountCode, r.bankCode)
    const status = statusWords(r.status)

    excelRow.getCell(1).value = r.checkNumber
    excelRow.getCell(2).value = apv
    excelRow.getCell(3).value = r.payeeName
    excelRow.getCell(4).value = r.companyCode
    excelRow.getCell(5).value = bank
    excelRow.getCell(6).value = r.checkDate
    /**
     * BLANK, never 0, when the register recorded no amount.
     *
     * 129 production cheques are in this state. A zero here would be read as a
     * cheque genuinely drawn for nothing, and once the file is on somebody's
     * laptop there is no way left to tell the two apart. The dashboard renders
     * the same fact as an em dash; a spreadsheet cell has a better answer,
     * which is nothing at all — it also keeps the cheque out of any SUM the
     * reader writes themselves.
     */
    excelRow.getCell(7).value = r.amount === null ? null : amountAsNumber(r.amount)
    excelRow.getCell(8).value = status
    excelRow.getCell(9).value = r.availablePickupDate
    excelRow.getCell(10).value = r.scheduledPickupDate

    for (let c = 1; c <= REGISTER_HEADERS.length; c++) {
      const cell = excelRow.getCell(c)
      cell.border = {
        bottom: { style: 'thin', color: { argb: GRID } },
        left: { style: 'thin', color: { argb: GRID } },
        right: { style: 'thin', color: { argb: GRID } },
      }
      // Banded, so a wide row can be followed across ten columns on paper.
      if (i % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } }
      }
    }

    excelRow.getCell(6).numFmt = DATE_FORMAT
    excelRow.getCell(9).numFmt = DATE_FORMAT
    excelRow.getCell(10).numFmt = DATE_FORMAT
    excelRow.getCell(7).numFmt = currencyNumberFormat(r.currency)
    excelRow.getCell(7).alignment = { horizontal: 'right' }

    widthSamples[0].push(r.checkNumber)
    widthSamples[1].push(apv ?? '')
    widthSamples[2].push(r.payeeName ?? '')
    widthSamples[3].push(r.companyCode)
    widthSamples[4].push(bank ?? '')
    widthSamples[5].push(r.checkDate ? DATE_WIDTH_SAMPLE : '')
    widthSamples[6].push(r.amount === null ? '' : formatMoney(r.amount, r.currency))
    widthSamples[7].push(status)
    widthSamples[8].push(r.availablePickupDate ? DATE_WIDTH_SAMPLE : '')
    widthSamples[9].push(r.scheduledPickupDate ? DATE_WIDTH_SAMPLE : '')
  })

  REGISTER_HEADERS.forEach((label, i) => {
    ws.getColumn(i + 1).width = fitColumnWidth(label, widthSamples[i])
  })

  // Over the header and the data only. Extending it across the totals would let
  // a filter hide or strand them.
  ws.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW + rows.length, column: REGISTER_HEADERS.length },
  }

  writeTotals(ws, rows)
  return ws
}

/**
 * The totals block: the count, then ONE LINE PER CURRENCY.
 *
 * There is no grand total and there is no code path that could produce one —
 * the same rule `getSummary` and `getTodaysRelease` are built on. Adding a PHP
 * figure to a CNY figure yields a number with no meaning, and a spreadsheet is
 * exactly where somebody would otherwise be tempted to.
 *
 * These are the totals OF THE ROWS IN THIS SHEET, including any CANCELLED ones
 * the chosen view admits. That is what a totals row under a table means, and
 * what a reader gets if they select the column in Excel. The SUMMARY sheet's
 * value figures answer a different question and say so on their own line.
 */
function writeTotals(ws: ExcelJS.Worksheet, rows: readonly CheckTableRow[]) {
  const totals = totalsByCurrency(rows)
  let r = FIRST_DATA_ROW + rows.length + 1 // one blank row below the table

  const countCell = ws.getCell(r, 1)
  countCell.value = `TOTAL — ${rows.length.toLocaleString('en-PH')} CHEQUES EXPORTED`
  countCell.font = { bold: true, size: 11 }
  ws.mergeCells(r, 1, r, AMOUNT_COLUMN - 1)
  r += 1

  for (const t of totals) {
    const label = ws.getCell(r, 1)
    label.value = `TOTAL VALUE — ${t.currency} (${t.count.toLocaleString('en-PH')} CHEQUE${t.count === 1 ? '' : 'S'})`
    label.font = { bold: true }
    label.alignment = { horizontal: 'right' }
    ws.mergeCells(r, 1, r, AMOUNT_COLUMN - 1)

    const value = ws.getCell(r, AMOUNT_COLUMN)
    // null, not 0. Where no amount in the currency is known there is nothing to
    // total, and a ₱0.00 on a totals row is a figure a reader cannot challenge.
    value.value = t.total === null ? null : amountAsNumber(t.total)
    value.numFmt = currencyNumberFormat(t.currency)
    value.font = { bold: true }
    value.alignment = { horizontal: 'right' }
    value.border = { top: { style: 'double', color: { argb: HEADER_FILL } } }
    r += 1
  }

  // Named only when there is one, and never subtracted from anything above: the
  // count includes these cheques and the totals do not, and a reader who is not
  // told that has a count and a total that silently disagree.
  const missing = rows.filter((row) => row.amount === null).length
  if (missing > 0) {
    const note = ws.getCell(r, 1)
    note.value = missing === 1
      ? '1 OF THESE CHEQUES HAS NO RECORDED AMOUNT AND IS ABSENT FROM THE TOTALS ABOVE. IT IS NOT WORTH ZERO — THE AMOUNT WAS NEVER RECORDED.'
      : `${missing.toLocaleString('en-PH')} OF THESE CHEQUES HAVE NO RECORDED AMOUNT AND ARE ABSENT FROM THE TOTALS ABOVE. THEY ARE NOT WORTH ZERO — THE AMOUNTS WERE NEVER RECORDED.`
    note.font = { italic: true, size: 9, color: { argb: 'FF92400E' } }
    // Not merged: a merged cell clips, and this note must never be half-read.
  }
}

const SUMMARY_COLUMNS = 3

function sectionHeader(ws: ExcelJS.Worksheet, row: number, labels: readonly string[]) {
  labels.forEach((label, i) => {
    const cell = ws.getCell(row, i + 1)
    cell.value = label
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
  })
  for (let i = labels.length; i < SUMMARY_COLUMNS; i++) {
    ws.getCell(row, i + 1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL },
    }
  }
}

/**
 * The SUMMARY sheet.
 *
 * These figures come from `getSummary`, which takes NO filters — they cover
 * every cheque in the system, exactly as the dashboard's summary cards do. Line
 * 3 says so outright rather than repeating the register's filter line, because
 * a total that quietly reported a filtered subset would read as the whole and a
 * manager would have no way to tell.
 */
function buildSummarySheet(wb: ExcelJS.Workbook, { summary, meta }: ExportInput) {
  const ws = wb.addWorksheet(SUMMARY_SHEET, {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })

  titleBlock(ws, [
    'CHECK RELEASE MONITORING',
    'SUMMARY — THE WHOLE SYSTEM, NOT THIS FILE’S FILTERS',
    'These figures are not narrowed by the filters on the CHECK REGISTER sheet. They cover every cheque the system holds EXCEPT those with no recorded amount, exactly as the dashboard cards do — those are counted on their own line below.',
    generatedLine(meta),
  ])

  const labelWidths: string[] = []
  const valueWidths: string[] = []
  const totalWidths: string[] = []

  let r = HEADER_ROW
  sectionHeader(ws, r, ['CHEQUES BY STATUS', 'COUNT'])
  labelWidths.push('CHEQUES BY STATUS')
  valueWidths.push('COUNT')
  r += 1

  const statusLines: readonly [string, number][] = [
    ['PENDING SIGNATURE', summary.pendingSignature],
    ['SIGNED', summary.signed],
    ['READY FOR RELEASE', summary.readyForRelease],
    ['SCHEDULED', summary.scheduled],
    ['RELEASED', summary.released],
    ['TOTAL CHEQUES', summary.total],
  ]
  for (const [label, value] of statusLines) {
    ws.getCell(r, 1).value = label
    const cell = ws.getCell(r, 2)
    cell.value = value
    cell.numFmt = COUNT_FORMAT
    cell.alignment = { horizontal: 'right' }
    if (label === 'TOTAL CHEQUES') {
      ws.getCell(r, 1).font = { bold: true }
      cell.font = { bold: true }
      cell.border = { top: { style: 'double', color: { argb: HEADER_FILL } } }
    }
    labelWidths.push(label)
    valueWidths.push(value.toLocaleString('en-PH'))
    r += 1
  }

  r += 1
  sectionHeader(ws, r, ['RECORDS WITH NO RECORDED AMOUNT', 'COUNT'])
  labelWidths.push('RECORDS WITH NO RECORDED AMOUNT')
  r += 1
  ws.getCell(r, 1).value = 'NO RECORDED AMOUNT'
  const incompleteCell = ws.getCell(r, 2)
  incompleteCell.value = summary.incomplete
  incompleteCell.numFmt = COUNT_FORMAT
  incompleteCell.alignment = { horizontal: 'right' }
  labelWidths.push('NO RECORDED AMOUNT')
  valueWidths.push(summary.incomplete.toLocaleString('en-PH'))
  r += 1
  const note = ws.getCell(r, 1)
  // Counted HERE and nowhere else above, since 2026-09-06: the client asked for
  // the cheques with no recorded amount to be left out of the dashboard's
  // figures, and this sheet reports the dashboard. Nothing was deleted, so the
  // number is stated rather than dropped — a register that shrinks by 129 with
  // no line explaining it is how a reader concludes money went missing.
  note.value = 'Real cheques whose amount the register never recorded. They are NOT counted in the figures above and are NOT in the values below — there is nothing of theirs to add, and they are not worth zero. They are still in the system: open the dashboard with the INCOMPLETE ONLY filter to list them. The CURRENCY counts below are the population each total was struck over and do include them.'
  note.font = { italic: true, size: 9, color: { argb: 'FF475569' } }
  // Not merged, for the same reason the title block is not: merges clip.
  r += 2

  sectionHeader(ws, r, ['CURRENCY', 'CHEQUES', 'TOTAL VALUE'])
  valueWidths.push('CHEQUES')
  totalWidths.push('TOTAL VALUE')
  r += 1

  // One line per currency, never one grand total. Same rule as the register's
  // totals block, and as getSummary itself.
  for (const t of summary.totalsByCurrency) {
    ws.getCell(r, 1).value = t.currency
    const countCell = ws.getCell(r, 2)
    countCell.value = t.count
    countCell.numFmt = COUNT_FORMAT
    countCell.alignment = { horizontal: 'right' }
    const totalCell = ws.getCell(r, 3)
    // null stays null. See getSummary: a group whose every amount is unknown
    // returns SUM() = NULL, and rendering that as ₱0.00 would be a lie the
    // reader has no way to detect.
    totalCell.value = t.total === null ? null : amountAsNumber(t.total)
    totalCell.numFmt = currencyNumberFormat(t.currency)
    totalCell.alignment = { horizontal: 'right' }
    labelWidths.push(t.currency)
    valueWidths.push(t.count.toLocaleString('en-PH'))
    totalWidths.push(t.total === null ? '' : formatMoney(t.total, t.currency))
    r += 1
  }

  const excluded = ws.getCell(r, 1)
  excluded.value = 'Values exclude CANCELLED cheques. Each currency is totalled on its own line — two currencies are never added together.'
  excluded.font = { italic: true, size: 9, color: { argb: 'FF475569' } }
  // Not merged, for the same reason the title block is not: merges clip.

  ws.getColumn(1).width = fitColumnWidth('CHEQUES BY STATUS', labelWidths)
  ws.getColumn(2).width = fitColumnWidth('COUNT', valueWidths)
  ws.getColumn(3).width = fitColumnWidth('TOTAL VALUE', totalWidths)

  return ws
}

/** The finished .xlsx, ready to be handed to a browser. */
export async function buildExportWorkbook(input: ExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = input.meta.generatedAt
  wb.modified = input.meta.generatedAt

  buildRegisterSheet(wb, input)
  buildSummarySheet(wb, input)

  return Buffer.from(await wb.xlsx.writeBuffer())
}
