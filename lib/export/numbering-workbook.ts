// lib/export/numbering-workbook.ts
import ExcelJS from 'exceljs'
import { currencyNumberFormat } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, styleHeaderCell } from './sheet-style'
import type { NumberingAccount } from '@/lib/numbering/query'
import type { SeriesCheque } from '@/lib/numbering/series'
import { visibleEntries, NUMBERING_SCOPE_NOTE } from '@/lib/numbering-view'

/**
 * The numbering report as a workbook: SUMMARY, then one sheet per account with
 * every cheque in number order and each MISSING run as one row whose FROM, TO
 * and COUNT have their own columns — so a filter on STATUS = MISSING works
 * (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B4). Cheque
 * numbers are text cells. Amounts are Excel numbers in the cells, the one
 * sanctioned use of a JS number for money, as in `recon-workbook.ts`.
 */
export const NUMBERING_SUMMARY_SHEET = 'SUMMARY'
export const NUMBERING_ACCOUNT_HEADERS = [
  'CHECK NUMBER', 'CHEQUE DATE', 'PAYEE', 'STATUS', 'CURRENCY', 'AMOUNT', 'FROM', 'TO', 'COUNT', 'NOTE',
] as const
const SUMMARY_HEADERS = ['ACCOUNT', 'BANK', 'COMPANY', 'FIRST', 'LAST', 'HELD', 'VOIDED', 'CANCELLED', 'MISSING NUMBERS', 'MISSING RUNS', 'NOT NUMERIC'] as const

export type NumberingMeta = {
  generatedAt: Date; generatedBy: string; filterDescription: string
  missingOnly: boolean; noAccountCount: number
  /** `caps.exportRows`: cheque and MISSING lines across all account sheets. */
  rowLimit: number
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const fmt = (n: number) => n.toLocaleString('en-PH')
/** A count as a cell: a number while exact, else its decimal string. */
const countCell = (s: string): number | string => (s.length <= 15 ? Number(s) : s)

/** Excel: ≤31 chars, none of []:*?/\, unique case-insensitively within the book. */
export function sheetNameFor(code: string, used: Set<string>): string {
  const base = (code.replace(/[[\]:*?/\\]/g, ' ').trim() || 'ACCOUNT').slice(0, 31)
  let name = base
  let i = 2
  while (used.has(name.toUpperCase())) {
    const suffix = ` (${i++})`
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`
  }
  used.add(name.toUpperCase())
  return name
}

function generatedLine(meta: NumberingMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

export async function buildNumberingWorkbook(
  { accounts, meta }: { accounts: readonly NumberingAccount[]; meta: NumberingMeta },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const lines = accounts.map((a) => ({ a, entries: visibleEntries(a.series.entries, meta.missingOnly) }))
  const totalLines = lines.reduce((n, l) => n + l.entries.length + (meta.missingOnly ? 0 : l.a.series.notNumeric.length), 0)

  const ws = wb.addWorksheet(NUMBERING_SUMMARY_SHEET)
  ws.getCell('A1').value = 'CHEQUE NUMBERING — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  ws.getCell('A3').value = totalLines > meta.rowLimit
    ? `${generatedLine(meta)}  ·  account sheets hold the first ${fmt(meta.rowLimit)} of ${fmt(totalLines)} lines`
    : `${generatedLine(meta)}  ·  ${fmt(accounts.length)} account${accounts.length === 1 ? '' : 's'}`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value = `${NUMBERING_SCOPE_NOTE} Not in any series: ${fmt(meta.noAccountCount)} cheque${meta.noAccountCount === 1 ? '' : 's'} with no cash account.`
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(6)
  SUMMARY_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 5 ? 'right' : 'left'))
  accounts.forEach((a, i) => {
    const s = a.series.summary
    const row = ws.getRow(7 + i)
    const values: (string | number | null)[] = [
      a.account, a.bank, a.company, s.first, s.last, s.held, s.voided, s.cancelled,
      countCell(s.missingNumbers), s.missingRuns, s.notNumeric,
    ]
    values.forEach((v, col) => {
      row.getCell(col + 1).value = v
      if (col >= 5) row.getCell(col + 1).numFmt = COUNT_FORMAT
    })
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  ;[22, 10, 10, 14, 14, 10, 10, 12, 18, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w })

  const used = new Set([NUMBERING_SUMMARY_SHEET.toUpperCase()])
  let budget = meta.rowLimit
  for (const { a, entries } of lines) {
    if (budget <= 0) break
    const sheet = wb.addWorksheet(sheetNameFor(a.account, used), { views: [{ state: 'frozen', ySplit: 1 }] })
    const h = sheet.getRow(1)
    NUMBERING_ACCOUNT_HEADERS.forEach((label, i) => styleHeaderCell(h.getCell(i + 1), label, label === 'AMOUNT' || label === 'COUNT' ? 'right' : 'left'))
    let r = 2
    const chequeRow = (c: SeriesCheque, note: string | null) => {
      const row = sheet.getRow(r++)
      row.getCell(1).value = c.checkNumber
      row.getCell(2).value = c.checkDate
      if (c.checkDate) row.getCell(2).numFmt = DATE_FORMAT
      row.getCell(3).value = c.payeeName
      row.getCell(4).value = c.status
      row.getCell(5).value = c.currency
      row.getCell(6).value = c.amount === null ? null : Number(c.amount)
      row.getCell(6).numFmt = currencyNumberFormat(c.currency)
      row.getCell(10).value = note
    }
    const rows = [...entries.map((e) => ({ e })), ...(meta.missingOnly ? [] : a.series.notNumeric.map((c) => ({ c })))]
    for (const item of rows.slice(0, budget)) {
      if ('c' in item) { chequeRow(item.c, 'NOT NUMERIC'); continue }
      const e = item.e
      if (e.kind === 'CHEQUE') { chequeRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : null); continue }
      const row = sheet.getRow(r++)
      row.getCell(1).value = e.from === e.to ? e.from : `${e.from} – ${e.to}`
      row.getCell(4).value = 'MISSING'
      row.getCell(7).value = e.from
      row.getCell(8).value = e.to
      row.getCell(9).value = countCell(e.count)
      row.getCell(9).numFmt = COUNT_FORMAT
      row.font = { bold: true }
      row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } } })
    }
    budget -= Math.min(rows.length, budget)
    ;[22, 14, 36, 18, 10, 18, 14, 14, 12, 18].forEach((w, i) => { sheet.getColumn(i + 1).width = w })
  }

  return wb.xlsx.writeBuffer()
}
