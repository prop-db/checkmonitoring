import ExcelJS from 'exceljs'
import { amountToCentavos } from '@/lib/transmittal'
import { manilaToday } from '@/lib/manila-day'
import { AGING_BUCKETS, AGING_LABELS, type AgingBucket } from '@/lib/aging/buckets'
import { AGING_LIMIT, type AgingRow } from '@/lib/aging/query'
import { COUNT_FORMAT, styleHeaderCell } from './sheet-style'
import { currencyNumberFormat } from './report'

/**
 * AGING as a workbook (spec 2026-10-15): SUMMARY (bucket x count x PHP amount,
 * then bucket x bank), and one sheet per non-empty bucket. Every SIGNED check
 * in the population, no filters, and the title block says so. Amounts are
 * summed in centavos and written as Excel numbers — a presentational value,
 * never added to anything here (see workbook.ts).
 */

export const SUMMARY_SHEET = 'SUMMARY'

export const AGING_HEADERS = [
  'CHECK NO.', 'CV', 'APV', 'PO NUMBER', 'PAYEE', 'COMPANY', 'BANK', 'CHECK DATE', 'DUE DATE',
  'DAYS PAST DUE', 'BUCKET', 'CURRENCY', 'AMOUNT',
] as const

const ZERO = BigInt(0)

function phpCentavos(rows: readonly AgingRow[]): bigint {
  let sum = ZERO
  for (const r of rows) {
    if (r.currency !== 'PHP' || r.amount === null) continue
    sum += amountToCentavos(r.amount) ?? ZERO
  }
  return sum
}

// An unreadable amount is blank, never 0: a zero would read as a recorded figure.
function amountCell(amount: string | null): number | '' {
  if (amount === null) return ''
  const c = amountToCentavos(amount)
  return c === null ? '' : asNumber(c)
}

// Centavos -> an Excel number. Safe: a sum of SIGNED checks is far below 2^53 centavos.
const asNumber = (c: bigint) => Number(c) / 100

export function agingFilename(now: Date): string {
  return `AGING ${manilaToday(now)}.xlsx`
}

export async function buildAgingWorkbook(args: {
  rows: readonly AgingRow[]
  generatedAt: Date
  generatedBy: string
  truncated?: boolean
}): Promise<Buffer> {
  const { rows, generatedAt, generatedBy, truncated } = args
  const wb = new ExcelJS.Workbook()
  const byBucket = new Map<AgingBucket, AgingRow[]>(AGING_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b)]))

  const summary = wb.addWorksheet(SUMMARY_SHEET)
  summary.addRow(['AGING — ALL SIGNED CHECKS'])
  summary.addRow([`Aged by the earliest due date of the bills each check pays, as in the Supplier Portal. Generated ${manilaToday(generatedAt)} by ${generatedBy}. Peso totals only.`])
  if (truncated) summary.addRow([`CAPPED: the list holds the first ${AGING_LIMIT.toLocaleString('en-US')} SIGNED checks by check number; the rest are not in this file.`])
  summary.addRow([])
  const head = summary.addRow([])
  ;['BUCKET', 'CHECKS', 'AMOUNT (PHP)'].forEach((h, i) => styleHeaderCell(head.getCell(i + 1), h, i === 0 ? 'left' : 'right'))
  for (const b of AGING_BUCKETS) {
    const inB = byBucket.get(b)!
    const r = summary.addRow([AGING_LABELS[b], inB.length, asNumber(phpCentavos(inB))])
    r.getCell(2).numFmt = COUNT_FORMAT
    r.getCell(3).numFmt = currencyNumberFormat('PHP')
  }

  summary.addRow([])
  const banks = [...new Set(rows.map((r) => r.bank ?? '(NO BANK)'))].sort()
  const bankHead = summary.addRow([])
  ;['BANK', ...AGING_BUCKETS.map((b) => AGING_LABELS[b])].forEach((h, i) => styleHeaderCell(bankHead.getCell(i + 1), h, i === 0 ? 'left' : 'right'))
  for (const bank of banks) {
    const r = summary.addRow([bank, ...AGING_BUCKETS.map((b) =>
      asNumber(phpCentavos(byBucket.get(b)!.filter((x) => (x.bank ?? '(NO BANK)') === bank))))])
    for (let i = 2; i <= AGING_BUCKETS.length + 1; i++) r.getCell(i).numFmt = currencyNumberFormat('PHP')
  }
  summary.getColumn(1).width = 28
  for (let i = 2; i <= AGING_BUCKETS.length + 1; i++) summary.getColumn(i).width = 18

  for (const b of AGING_BUCKETS) {
    const inB = byBucket.get(b)!
    if (inB.length === 0) continue
    const sheet = wb.addWorksheet(AGING_LABELS[b])
    const h = sheet.addRow([])
    AGING_HEADERS.forEach((label, i) => styleHeaderCell(h.getCell(i + 1), label, label === 'AMOUNT' || label === 'DAYS PAST DUE' ? 'right' : 'left'))
    const sorted = [...inB].sort((x, y) => (y.daysPastDue ?? -Infinity) - (x.daysPastDue ?? -Infinity))
    for (const r of sorted) {
      const line = sheet.addRow([
        r.checkNumber, r.cvNumber ?? '', r.apvNumbers.join(', '), r.poNumbers.join(', '), r.payee ?? '',
        r.company, r.bank ?? '', r.checkDate ?? '', r.dueDate ?? '', r.daysPastDue ?? '', AGING_LABELS[r.bucket],
        r.currency, amountCell(r.amount),
      ])
      line.getCell(13).numFmt = currencyNumberFormat(r.currency)
    }
    AGING_HEADERS.forEach((label, i) => { sheet.getColumn(i + 1).width = Math.max(12, label.length + 4) })
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}
