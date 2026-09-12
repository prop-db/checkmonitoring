import ExcelJS from 'exceljs'
import { currencyNumberFormat, fitColumnWidth } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell } from './sheet-style'
import type { ReconSummary, OutstandingLine } from '@/lib/recon/summary'

/**
 * Outstanding cheques as a workbook: SUMMARY is the account table the Cash
 * Balance sheet's OC column is typed from; DETAIL is every cheque behind it.
 * The file is the view — the as-of day and the filters are in the title
 * block. Amounts are Excel numbers in the cells, the one sanctioned use of a
 * JS number for money; the adding was done in centavos in `summary.ts`.
 */
export const RECON_SUMMARY_SHEET = 'SUMMARY'
export const RECON_DETAIL_SHEET = 'DETAIL'
export const RECON_DETAIL_HEADERS = [
  'CHECK NUMBER', 'PAYEE', 'ACCOUNT', 'BANK', 'COMPANY', 'CHEQUE DATE', 'ISSUED', 'ISSUE BASIS',
  'DAYS OUTSTANDING', 'CLEARING', 'CURRENCY', 'AMOUNT',
] as const
const SUMMARY_HEADERS = ['ACCOUNT', 'BANK', 'COMPANY', 'CURRENCY', 'OUTSTANDING', 'AMOUNT'] as const

export type ReconMeta = {
  asOfDay: string
  generatedAt: Date
  generatedBy: string
  filterDescription: string
  totalRows: number
  incompleteCount: number
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const count = (n: number) => n.toLocaleString('en-PH')
const dayCell = (day: string | null) => (day ? new Date(`${day}T00:00:00Z`) : null)

function generatedLine(meta: ReconMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

export async function buildReconWorkbook(
  { summary, detail, meta }: { summary: ReconSummary; detail: readonly OutstandingLine[]; meta: ReconMeta },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const ws = wb.addWorksheet(RECON_SUMMARY_SHEET)
  ws.getCell('A1').value = `OUTSTANDING CHEQUES AS OF ${meta.asOfDay} — CHECK RELEASE MONITORING`
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getRow(1).height = 24
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  ws.getCell('A3').value = detail.length < meta.totalRows
    ? `${generatedLine(meta)}  ·  DETAIL holds the FIRST ${count(detail.length)} OF ${count(meta.totalRows)} cheques`
    : `${generatedLine(meta)}  ·  ${count(meta.totalRows)} cheque${meta.totalRows === 1 ? '' : 's'}`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value =
    `Outstanding means released and not cleared by the bank as of the day. Where no release date was ` +
    `recorded, the cheque date stands in. Excludes ${count(meta.incompleteCount)} released ` +
    `cheque${meta.incompleteCount === 1 ? '' : 's'} with no recorded amount.`
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(6)
  SUMMARY_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 4 ? 'right' : 'left'))

  let r = 7
  let band = false
  const writeLine = (account: string, bank: string | null, company: string, t: { currency: string; count: number; total: string }, bold: boolean) => {
    const row = ws.getRow(r)
    row.getCell(1).value = account
    row.getCell(2).value = bank
    row.getCell(3).value = company
    row.getCell(4).value = t.currency
    row.getCell(5).value = t.count
    row.getCell(5).numFmt = COUNT_FORMAT
    row.getCell(6).value = Number(t.total)
    row.getCell(6).numFmt = currencyNumberFormat(t.currency)
    if (bold) row.font = { bold: true }
    if (band && !bold) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
    r += 1
  }
  for (const a of summary.accounts) {
    for (const t of a.totals) writeLine(a.account, a.bank, a.company, t, false)
    band = !band
  }
  for (const t of summary.totals) writeLine('TOTAL', null, '', t, true)
  ws.getColumn(1).width = 22
  ws.getColumn(2).width = 10
  ws.getColumn(3).width = 12
  ws.getColumn(4).width = 10
  ws.getColumn(5).width = 14
  ws.getColumn(6).width = 20

  const dws = wb.addWorksheet(RECON_DETAIL_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  const dh = dws.getRow(1)
  RECON_DETAIL_HEADERS.forEach((label, i) => {
    styleHeaderCell(dh.getCell(i + 1), label, label === 'AMOUNT' || label === 'DAYS OUTSTANDING' ? 'right' : 'left')
  })
  dh.height = 20
  const samples: string[][] = RECON_DETAIL_HEADERS.map(() => [])
  detail.forEach((l, i) => {
    const row = dws.getRow(i + 2)
    const values: (string | number | Date | null)[] = [
      l.checkNumber, l.payee, l.account, l.bank, l.company, l.checkDate, dayCell(l.issuedDay), l.basis,
      l.days, l.clearingStatus, l.currency, Number(l.amount),
    ]
    values.forEach((v, col) => {
      const cell = row.getCell(col + 1)
      cell.value = v
      if (v instanceof Date) cell.numFmt = DATE_FORMAT
      samples[col].push(v === null ? '' : v instanceof Date ? DATE_WIDTH_SAMPLE : String(v))
    })
    row.getCell(12).numFmt = currencyNumberFormat(l.currency)
    row.getCell(9).numFmt = COUNT_FORMAT
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  RECON_DETAIL_HEADERS.forEach((label, i) => { dws.getColumn(i + 1).width = fitColumnWidth(label, samples[i]) })
  dws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + detail.length, column: RECON_DETAIL_HEADERS.length } }

  return wb.xlsx.writeBuffer()
}
