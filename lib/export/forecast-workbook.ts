import ExcelJS from 'exceljs'
import { currencyNumberFormat, fitColumnWidth, statusWords } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell } from './sheet-style'
import { NO_BANK, type Matrix, type BucketedRow } from '@/lib/forecast/matrix'

/**
 * The cash outflow forecast, as a workbook. Two sheets: SUMMARY holds the two
 * matrices under a title block; DETAIL holds one row per cheque.
 *
 * Unlike the voucher index, THE FILE IS THE VIEW: the filters in force are
 * written into the title block, because a filtered forecast that did not say
 * so would be read as the whole.
 *
 * Amounts are written as Excel NUMBERS in the cells — the one sanctioned use
 * of a JS number for money, as `workbook.ts` documents: a presentational value
 * the reader can sum and sort, never added to anything here and never read
 * back. The adding was done in centavos in `matrix.ts`.
 */

export const SUMMARY_SHEET = 'SUMMARY'
export const DETAIL_SHEET = 'DETAIL'

export const DETAIL_HEADERS = [
  'CHECK NUMBER', 'PAYEE', 'BANK', 'COMPANY', 'STAGE', 'CHECK DATE',
  'DAYS PRESENTABLE', 'BUCKET', 'CURRENCY', 'AMOUNT',
] as const

export type ForecastMeta = {
  generatedAt: Date
  generatedBy: string
  filterDescription: string
  /** Every cheque in the population before the DETAIL cap. */
  totalRows: number
  incompleteCount: number
}

export type ForecastWorkbookInput = {
  byBank: Matrix
  byStage: Matrix
  detail: readonly BucketedRow[]
  meta: ForecastMeta
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const count = (n: number) => n.toLocaleString('en-PH')

function generatedLine(meta: ForecastMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

/**
 * How many CHEQUES a currency line's count columns show, per bucket/column and
 * per currency, counted straight off `detail` rather than off `Matrix.Cell`.
 *
 * `Cell.count` (`lib/forecast/matrix.ts`) is ONE number per bucket/column,
 * summed across every currency landing there — correct for the matrix's own
 * purpose (an overall cheque count) but wrong for a currency-split CHEQUES
 * column: a bucket/column holding one PHP cheque and one USD cheque would
 * print `2` on BOTH the PHP line and the USD line. `Cell.totals` already
 * carries a currency-split AMOUNT (each entry sums only its own currency), but
 * carries no matching per-currency count, so the count has to be re-derived
 * here from the same rows the matrix was built from — the one list both are
 * struck over (`lib/forecast/matrix.ts`'s own description of `bucketed`).
 */
type Counts = {
  /** `${bucket}|${column}|${currency}` → cheques in that one cell, that currency only. */
  cell: Map<string, number>
  /** `${bucket}|${currency}` → cheques in that bucket, every column, that currency only. */
  rowTotal: Map<string, number>
  /** `${column}|${currency}` → cheques in that column, every bucket, that currency only. */
  colTotal: Map<string, number>
  /** `${currency}` → cheques altogether, that currency only. */
  grand: Map<string, number>
}

function buildCounts(detail: readonly BucketedRow[], columnOf: (r: BucketedRow) => string): Counts {
  const counts: Counts = { cell: new Map(), rowTotal: new Map(), colTotal: new Map(), grand: new Map() }
  const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1)
  for (const r of detail) {
    const col = columnOf(r)
    bump(counts.cell, `${r.bucket}|${col}|${r.currency}`)
    bump(counts.rowTotal, `${r.bucket}|${r.currency}`)
    bump(counts.colTotal, `${col}|${r.currency}`)
    bump(counts.grand, r.currency)
  }
  return counts
}

/** One matrix, written from `top` down. Returns the next free row. */
function writeMatrix(
  ws: ExcelJS.Worksheet, top: number, title: string, m: Matrix, counts: Counts,
): number {
  ws.getCell(top, 1).value = title
  ws.getCell(top, 1).font = { bold: true, size: 12, color: { argb: TITLE_INK } }

  const header = ws.getRow(top + 1)
  const labels = ['BUCKET', 'CURRENCY', ...m.columns.flatMap((c) => [`${c} CHEQUES`, `${c} AMOUNT`]), 'TOTAL CHEQUES', 'TOTAL AMOUNT']
  labels.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 2 ? 'right' : 'left'))

  let r = top + 2
  const writeLine = (
    bucket: string, currency: string, cells: Matrix['rows'][number]['cells'], total: Matrix['rows'][number]['total'],
    band: boolean, isTotalRow: boolean,
  ) => {
    const row = ws.getRow(r)
    row.getCell(1).value = bucket
    row.getCell(2).value = currency
    let col = 3
    for (const c of m.columns) {
      const cell = cells[c]
      const t = cell.totals.find((x) => x.currency === currency)
      const cellCount = isTotalRow ? counts.colTotal.get(`${c}|${currency}`) : counts.cell.get(`${bucket}|${c}|${currency}`)
      row.getCell(col).value = t ? (cellCount ?? 0) : null
      row.getCell(col).numFmt = COUNT_FORMAT
      row.getCell(col + 1).value = t ? Number(t.total) : null
      row.getCell(col + 1).numFmt = currencyNumberFormat(currency)
      col += 2
    }
    const tt = total.totals.find((x) => x.currency === currency)
    const totalCount = isTotalRow ? counts.grand.get(currency) : counts.rowTotal.get(`${bucket}|${currency}`)
    row.getCell(col).value = tt ? (totalCount ?? 0) : null
    row.getCell(col).numFmt = COUNT_FORMAT
    row.getCell(col + 1).value = tt ? Number(tt.total) : null
    row.getCell(col + 1).numFmt = currencyNumberFormat(currency)
    if (band) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
    r += 1
  }

  let band = false
  for (const line of m.rows) {
    // One line per currency present in the bucket; a bucket with nothing in it
    // is still written, with a dash, so the reader sees the whole ladder.
    const currencies = line.total.totals.map((t) => t.currency)
    if (currencies.length === 0) {
      ws.getRow(r).getCell(1).value = line.bucket
      ws.getRow(r).getCell(2).value = '—'
      r += 1
    } else {
      for (const currency of currencies) writeLine(line.bucket, currency, line.cells, line.total, band, false)
    }
    band = !band
  }
  for (const currency of m.total.total.totals.map((t) => t.currency)) {
    writeLine('TOTAL', currency, m.total.cells, m.total.total, false, true)
    ws.getRow(r - 1).font = { bold: true }
  }
  return r + 1
}

export async function buildForecastWorkbook(
  { byBank, byStage, detail, meta }: ForecastWorkbookInput,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const summary = wb.addWorksheet(SUMMARY_SHEET)
  summary.getCell('A1').value = 'CASH OUTFLOW BY CHEQUE DATE — CHECK RELEASE MONITORING'
  summary.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  summary.getRow(1).height = 24
  summary.getCell('A2').value = meta.filterDescription
  summary.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  const scope = detail.length < meta.totalRows
    ? `${generatedLine(meta)}  ·  DETAIL holds the FIRST ${count(detail.length)} OF ${count(meta.totalRows)} cheques`
    : `${generatedLine(meta)}  ·  ${count(meta.totalRows)} cheque${meta.totalRows === 1 ? '' : 's'}`
  summary.getCell('A3').value = scope
  summary.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  summary.getCell('A4').value =
    `Dates are the cheque's own date — the day from which it can be presented. Excludes ` +
    `${count(meta.incompleteCount)} cheque${meta.incompleteCount === 1 ? '' : 's'} with no recorded amount.`
  summary.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  // Counts per currency, computed straight off `detail` — see `buildCounts`
  // above for why `Cell.count` cannot answer this by itself. Each matrix keys
  // its columns its own way, so each gets its own count map, built the same
  // way `buildMatrices` grouped the rows in the first place.
  let next = writeMatrix(summary, 6, 'BY BANK', byBank, buildCounts(detail, (r) => r.bank ?? NO_BANK))
  writeMatrix(summary, next, 'BY STAGE', byStage, buildCounts(detail, (r) => statusWords(r.stage)))
  summary.getColumn(1).width = 16
  summary.getColumn(2).width = 10
  for (let c = 3; c <= summary.columnCount; c++) summary.getColumn(c).width = 18

  // ── DETAIL ───────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(DETAIL_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  const header = ws.getRow(1)
  DETAIL_HEADERS.forEach((label, i) => {
    styleHeaderCell(header.getCell(i + 1), label, label === 'AMOUNT' || label === 'DAYS PRESENTABLE' ? 'right' : 'left')
  })
  header.height = 20
  const samples: string[][] = DETAIL_HEADERS.map(() => [])

  detail.forEach((r, i) => {
    const row = ws.getRow(i + 2)
    const values: (string | number | Date | null)[] = [
      r.checkNumber, r.payee, r.bank, r.company, statusWords(r.stage), r.checkDate,
      r.days, r.bucket, r.currency, Number(r.amount),
    ]
    values.forEach((v, col) => {
      const cell = row.getCell(col + 1)
      cell.value = v
      if (v instanceof Date) cell.numFmt = DATE_FORMAT
      samples[col].push(v === null ? '' : v instanceof Date ? DATE_WIDTH_SAMPLE : String(v))
    })
    row.getCell(10).numFmt = currencyNumberFormat(r.currency)
    row.getCell(7).numFmt = COUNT_FORMAT
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  DETAIL_HEADERS.forEach((label, i) => { ws.getColumn(i + 1).width = fitColumnWidth(label, samples[i]) })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + detail.length, column: DETAIL_HEADERS.length } }

  return wb.xlsx.writeBuffer()
}
