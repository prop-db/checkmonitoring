import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildAgingWorkbook, agingFilename, SUMMARY_SHEET, AGING_HEADERS } from '@/lib/export/aging-workbook'
import type { AgingRow } from '@/lib/aging/query'

const row = (o: Partial<AgingRow>): AgingRow => ({
  id: 'x', checkNumber: '6000000001', cvNumber: 'CV-1', apvNumbers: ['AP-1'], poNumbers: ['PO-1'],
  payee: 'HENKEL', company: 'STK', bank: 'BPI-S-4636', checkDate: '2026-09-01', dueDate: '2026-10-01',
  daysPastDue: 14, bucket: 'b30', amount: '1000.10', currency: 'PHP', ...o,
})

async function load(rows: AgingRow[], truncated?: boolean) {
  const buf = await buildAgingWorkbook({ truncated, rows, generatedAt: new Date('2026-10-15T10:00:00+08:00'), generatedBy: 'Paolo Parcon' })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(new Uint8Array(buf).buffer)
  return wb
}

describe('buildAgingWorkbook', () => {
  it('writes an unreadable amount as an empty cell, not 0', async () => {
    const wb = await load([row({ amount: '1,000.00' })])
    expect(wb.getWorksheet('1–30 DAYS')!.getRow(2).getCell(13).value).toBe('')
  })

  it('says CAPPED on SUMMARY only when the list was truncated', async () => {
    const text = async (t: boolean) => (await load([row({})], t)).getWorksheet(SUMMARY_SHEET)!
      .getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(await text(true)).toContain('CAPPED')
    expect(await text(false)).not.toContain('CAPPED')
  })

  it('has SUMMARY and one sheet per non-empty bucket, in bucket order', async () => {
    const wb = await load([row({ id: 'a', bucket: 'b90plus' }), row({ id: 'b', bucket: 'current' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, 'CURRENT', 'OVER 90 DAYS'])
  })

  it('says it covers all SIGNED checks, and totals each bucket in centavos', async () => {
    const wb = await load([row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' })])
    const summary = wb.getWorksheet(SUMMARY_SHEET)!
    const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('ALL SIGNED CHECKS')
    const b30 = (summary.getColumn(1).values as unknown[]).indexOf('1–30 DAYS')
    expect(summary.getRow(b30).getCell(2).value).toBe(2)
    expect(summary.getRow(b30).getCell(3).value).toBe(0.3)
  })

  it('writes the table columns on a bucket sheet', async () => {
    const wb = await load([row({})])
    const sheet = wb.getWorksheet('1–30 DAYS')!
    expect(sheet.getRow(1).values).toEqual([undefined, ...AGING_HEADERS])
    expect(sheet.getRow(2).getCell(1).value).toBe('6000000001')
  })

  it('names the file by the Manila day', () => {
    expect(agingFilename(new Date('2026-10-15T00:30:00+08:00'))).toBe('AGING 2026-10-15.xlsx')
  })
})
