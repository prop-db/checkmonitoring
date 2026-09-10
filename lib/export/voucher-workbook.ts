import ExcelJS from 'exceljs'
import { fitColumnWidth } from './report'
import { BAND_FILL, DATE_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell } from './sheet-style'
import {
  VOUCHER_INDEX_SHEET, VOUCHER_HEADERS, VOUCHER_HEADER_ROW, VOUCHER_FIRST_DATA_ROW,
  describeVoucherScope, type VoucherRow,
} from './voucher-index'

/**
 * The voucher index, as a workbook. No database, no session, no request —
 * everything it needs is passed in, which is what lets the whole file be
 * generated into a buffer and read back cell by cell in the test.
 */

/**
 * THE STALENESS CELL, and the reason it is fixed.
 *
 * `CHECK BY VOUCHER.xlsx` never changes its name. See `VOUCHER_INDEX_SHEET` /
 * `VOUCHER_INDEX_FILENAME` in `voucher-index.ts` for why: not because a
 * formula needs a stable path any more, but because this is the `/vouchers`
 * screen's extract, and a fixed name is cheaper to find and file than a dated
 * one — at no cost. The cost that DOES come with a fixed name is that a copy
 * left on a shared drive for three months looks exactly like one generated
 * this morning, so the sheet states its own age itself, in a cell just as
 * fixed as the name.
 *
 * A sheet that states its own age beats a filename nobody reads. Do not move it.
 */
export const TIMESTAMP_CELL = 'A2'

export type VoucherIndexMeta = {
  generatedAt: Date
  generatedBy: string
  /** How many vouchers there are in total, before the row cap. */
  totalRows: number
}

export type VoucherIndexInputForSheet = {
  rows: readonly VoucherRow[]
  meta: VoucherIndexMeta
}

/**
 * The one format this sheet does not share with the register export: the
 * staleness cell shows a TIME as well as a date, because a file regenerated
 * twice in one morning must be distinguishable from itself. The trailing
 * literal `"PHT"` says which clock that time is on — see `MANILA_OFFSET_MS`.
 */
const TIMESTAMP_FORMAT = 'dd mmm yyyy hh:mm AM/PM "PHT"'

/**
 * THE TIMEZONE HAZARD, and why a fixed +8 fixes it.
 *
 * ExcelJS does not store a Date cell as displayed digits — it stores the
 * INSTANT (`Date#getTime()`) as an Excel serial number, and Excel renders that
 * serial as a wall-clock reading with no timezone attached. A `Date` built from
 * `meta.generatedAt` therefore displays, in Excel, as whatever wall-clock time
 * that instant was in the timezone of the MACHINE THAT WROTE THE FILE — because
 * that is the only timezone info the writer had.
 *
 * On a Manila laptop that machine is `Asia/Manila`, so the naive code would
 * happen to work. On Vercel it does not: serverless functions run with
 * `TZ=UTC` regardless of where the request came from, so `meta.generatedAt`
 * (itself a correct UTC instant, e.g. `new Date()`) would display as UTC wall
 * time — eight hours behind Manila. A file finished at 07:30 PHT would show
 * "09 Sep 2026 11:30 PM", a calendar day earlier than the truth, on the one
 * cell whose entire job is to tell Finance how stale the file is.
 *
 * The fix shifts the INSTANT written to the cell forward by the Manila offset
 * before handing it to ExcelJS, so the wall-clock digits Excel renders (under
 * any host TZ, because ExcelJS/Excel never consult one) equal Manila time. This
 * is deliberately not "convert to Manila time" in the timezone-arithmetic
 * sense — there is no TZ-aware conversion available at this layer — it is
 * "lie to the serial format by the fixed amount that makes the displayed digits
 * come out right for the one timezone this company operates in."
 *
 * A fixed +8 (not a TZ database lookup) is correct here because the
 * Philippines has observed a single offset, UTC+8, year-round with no daylight
 * saving since 1977. There is no summer-time case to get wrong.
 */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

/** What the cell holds, as text, for width fitting. Dates measure as a sample. */
function widthSample(value: string | Date | null): string {
  if (value === null) return ''
  return value instanceof Date ? DATE_WIDTH_SAMPLE : value
}

export async function buildVoucherIndexWorkbook(
  { rows, meta }: VoucherIndexInputForSheet,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const ws = wb.addWorksheet(VOUCHER_INDEX_SHEET, {
    views: [{ state: 'frozen', ySplit: VOUCHER_HEADER_ROW }],
  })

  // Four lines above the table, NOT merged — a merged cell clips text wider
  // than the merge, and the exclusion line on row 4 is the one that must not be
  // cut in half.
  ws.getCell('A1').value = 'CHECK BY VOUCHER — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF0F172A' } }
  ws.getRow(1).height = 24

  const stamp = ws.getCell(TIMESTAMP_CELL)
  stamp.value = new Date(meta.generatedAt.getTime() + MANILA_OFFSET_MS)
  stamp.numFmt = TIMESTAMP_FORMAT
  stamp.font = { bold: true, size: 12, color: { argb: 'FF0F172A' } }

  ws.getCell('A3').value = `${describeVoucherScope(rows.length, meta.totalRows)}  ·  generated by ${meta.generatedBy}`
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF475569' } }

  ws.getCell('A4').value =
    'Excludes cheques with no recorded amount. A blank CHECK NUMBER means this system will not ' +
    'guess — read REMARKS.'
  ws.getCell('A4').font = { size: 10, color: { argb: 'FF475569' } }

  const header = ws.getRow(VOUCHER_HEADER_ROW)
  VOUCHER_HEADERS.forEach((label, i) => {
    styleHeaderCell(header.getCell(i + 1), label)
  })
  header.height = 20

  const samples: string[][] = VOUCHER_HEADERS.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(VOUCHER_FIRST_DATA_ROW + i)
    const values: (string | Date | null)[] = [
      r.voucher, r.checkNumber, r.bank, r.company, r.status,
      r.checkDate, r.payee, r.releasedAt, r.supersedes, r.remarks,
    ]
    values.forEach((value, col) => {
      const cell = excelRow.getCell(col + 1)
      cell.value = value
      if (value instanceof Date) cell.numFmt = DATE_FORMAT
      samples[col].push(widthSample(value))
    })
    if (i % 2 === 1) {
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } }
      })
    }
  })

  VOUCHER_HEADERS.forEach((label, i) => {
    ws.getColumn(i + 1).width = fitColumnWidth(label, samples[i])
  })

  // The header row filters, so a Finance user can find one voucher by eye
  // without paging through the file — the same reason `/vouchers` has a
  // search box, for whoever opened the download instead.
  ws.autoFilter = {
    from: { row: VOUCHER_HEADER_ROW, column: 1 },
    to: { row: VOUCHER_HEADER_ROW + rows.length, column: VOUCHER_HEADERS.length },
  }

  return wb.xlsx.writeBuffer()
}
