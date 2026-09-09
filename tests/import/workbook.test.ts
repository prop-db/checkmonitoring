import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { readWorkbook } from '@/lib/import/workbook'
import { isBillSheet } from '@/lib/import/bills'

// A workbook built in memory, never one of the client's two files: those hold
// real vendor names and amounts and are gitignored. The point of this file is
// the one thing a fixture grid cannot prove — that a sheet's header survives
// the trip out of ExcelJS and reaches the parser, which is what decides whether
// a sheet is read at all.

const HEADER = [
  'Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref.', 'Vendor Name', 'Balance Amount',
  'Description', 'Due Date', 'Type', 'Detail Total', 'Terms Code', 'Created By', 'NO. OF DAYS',
  '1-30 days Over due', '31-60 days Over due', '61-90days Over due', 'OVER 90 DAYS', 'GL Account',
  'FINANCE REMARKS', 'Payment Ref. #', 'check No. ', 'bank',
]

async function workbookOf(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const { name, rows } of sheets) {
    const sheet = wb.addWorksheet(name)
    for (const row of rows) sheet.addRow(row as ExcelJS.CellValue[])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('readWorkbook', () => {
  it('carries each sheet’s header row onto every row of that sheet', async () => {
    const buffer = await workbookOf([
      { name: 'local supplier', rows: [HEADER, ['2026-08-04', '08-2026', 'AP-A1033419']] },
      { name: 'BROKERAGE', rows: [HEADER, ['2026-08-05', '08-2026', 'AP-ST043131']] },
    ])

    const rows = await readWorkbook(buffer)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.sheet)).toEqual(['local supplier', 'BROKERAGE'])
    // Which is what makes both sheets readable under names nobody has seen
    // before. Before 2026-09-07 this was decided by the name `LIST`, and the
    // 7 September workbook — Sheet3, local supplier, BROKERAGE — imported zero
    // rows and reported success.
    for (const row of rows) expect(isBillSheet(row.header)).toBe(true)
  })

  it('gives a sheet whose row 1 is empty no header', async () => {
    // The pivot sheet, in every export measured. It must not be read: its
    // column 3 holds a subtotal where a bill sheet holds a voucher reference.
    const buffer = await workbookOf([
      { name: 'Sheet3', rows: [[], ['BPI STK', 39, 1234567.89]] },
    ])

    const rows = await readWorkbook(buffer)
    expect(rows).toHaveLength(1)
    expect(isBillSheet(rows[0].header)).toBe(false)
  })

  it('still drops row 1 itself, on every sheet', async () => {
    const buffer = await workbookOf([
      { name: 'local supplier', rows: [HEADER, ['a'], ['b']] },
    ])

    const rows = await readWorkbook(buffer)
    expect(rows.map((r) => r.row)).toEqual([2, 3])
    expect(rows.map((r) => r.cells[0])).toEqual(['a', 'b'])
  })
})
