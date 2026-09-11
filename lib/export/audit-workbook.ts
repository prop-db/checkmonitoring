import ExcelJS from 'exceljs'
import { fitColumnWidth } from './report'
import { BAND_FILL, styleHeaderCell } from './sheet-style'
import type { AuditRow } from '@/lib/audit-query'
import { actionWords } from '@/lib/audit-view'

/**
 * The audit trail, filtered, as one sheet. The file IS the view: the filters
 * in force are in the title block. `details` is written as JSON text — a
 * reader who wants a field out of it has the whole record; a column per key
 * would be 21 actions' worth of columns, mostly empty.
 */
export const AUDIT_SHEET = 'AUDIT'
export const AUDIT_HEADERS = ['WHEN', 'WHO', 'ACTION', 'CHECK NUMBER', 'REMARKS', 'DETAILS'] as const
export const AUDIT_HEADER_ROW = 6
export const AUDIT_FIRST_DATA_ROW = AUDIT_HEADER_ROW + 1

export type AuditMeta = { generatedAt: Date; generatedBy: string; filterDescription: string; totalRows: number }

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const count = (n: number) => n.toLocaleString('en-PH')
const TIMESTAMP_FORMAT = 'dd mmm yyyy hh:mm:ss AM/PM'
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

export async function buildAuditWorkbook({ rows, meta }: { rows: readonly AuditRow[]; meta: AuditMeta }): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt
  const ws = wb.addWorksheet(AUDIT_SHEET, { views: [{ state: 'frozen', ySplit: AUDIT_HEADER_ROW }] })

  ws.getCell('A1').value = 'AUDIT TRAIL — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getRow(1).height = 24
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  ws.getCell('A3').value = rows.length < meta.totalRows
    ? `Generated ${stamp} by ${meta.generatedBy}  ·  FIRST ${count(rows.length)} OF ${count(meta.totalRows)} ROWS, newest first`
    : `Generated ${stamp} by ${meta.generatedBy}  ·  ${count(meta.totalRows)} ROW${meta.totalRows === 1 ? '' : 'S'}, newest first`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value = 'Every row is append-only: nothing here can be edited or removed. WHEN is Manila time.'
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(AUDIT_HEADER_ROW)
  AUDIT_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label))
  header.height = 20
  const samples: string[][] = AUDIT_HEADERS.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(AUDIT_FIRST_DATA_ROW + i)
    const values: (string | Date | null)[] = [
      // Shifted by the Manila offset so Excel's zone-less serial shows Manila digits — as voucher-workbook.ts does.
      new Date(r.createdAt.getTime() + MANILA_OFFSET_MS),
      r.actorType === 'SYSTEM' ? 'SYSTEM' : r.userName ?? 'UNKNOWN USER',
      actionWords(r.action),
      r.checkNumber ?? '(cheque removed)',
      r.remarks,
      r.details === null || r.details === undefined ? null : JSON.stringify(r.details),
    ]
    values.forEach((v, col) => {
      const cell = excelRow.getCell(col + 1)
      cell.value = v
      if (v instanceof Date) cell.numFmt = TIMESTAMP_FORMAT
      samples[col].push(v === null ? '' : v instanceof Date ? '11 Sep 2026 10:18:51 AM' : v)
    })
    if (i % 2 === 1) excelRow.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  AUDIT_HEADERS.forEach((label, i) => { ws.getColumn(i + 1).width = fitColumnWidth(label, samples[i]) })
  ws.autoFilter = { from: { row: AUDIT_HEADER_ROW, column: 1 }, to: { row: AUDIT_HEADER_ROW + rows.length, column: AUDIT_HEADERS.length } }
  return wb.xlsx.writeBuffer()
}
