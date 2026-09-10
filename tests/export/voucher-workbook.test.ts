import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  VOUCHER_INDEX_SHEET, VOUCHER_HEADER_ROW, VOUCHER_FIRST_DATA_ROW,
  type VoucherRow,
} from '@/lib/export/voucher-index'
import { buildVoucherIndexWorkbook, TIMESTAMP_CELL } from '@/lib/export/voucher-workbook'

const GENERATED_AT = new Date('2026-09-10T14:30:00+08:00')

function row(overrides: Partial<VoucherRow> & { voucher: string }): VoucherRow {
  return {
    checkNumber: '6000353106',
    bank: 'BPI',
    company: 'STK',
    status: 'SIGNED',
    checkDate: new Date('2026-08-13'),
    payee: 'HENKEL PHILIPPINES INC.',
    releasedAt: null,
    supersedes: null,
    remarks: null,
    ...overrides,
  }
}

async function build(rows: readonly VoucherRow[], totalRows = rows.length) {
  const buffer = await buildVoucherIndexWorkbook({
    rows,
    meta: { generatedAt: GENERATED_AT, generatedBy: 'Paolo Parcon', totalRows },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

describe('buildVoucherIndexWorkbook', () => {
  it('writes one sheet, named INDEX', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([VOUCHER_INDEX_SHEET])
  })

  /**
   * The staleness cell. A fixed filename means a stale copy is indistinguishable
   * from a fresh one by name, so the Executive Report reads this cell instead:
   * `='…\[CHECK BY VOUCHER.xlsx]INDEX'!$A$2`. It must be a real Date, not text,
   * or Excel cannot format or compare it.
   */
  it('puts the generation timestamp in A2 as a date', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const cell = wb.getWorksheet(VOUCHER_INDEX_SHEET)!.getCell(TIMESTAMP_CELL)
    expect(cell.value).toBeInstanceOf(Date)
    expect((cell.value as Date).getTime()).toBe(GENERATED_AT.getTime())
  })

  it('puts VOUCHER in column A of the header row', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_HEADER_ROW).getCell(1).value).toBe('VOUCHER')
  })

  it('writes the first voucher on the first data row', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(1).value).toBe('AP-ST042652')
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(2).value).toBe('6000353106')
  })

  it('leaves the cheque number blank rather than writing a guess', async () => {
    const wb = await build([row({ voucher: 'AP-ST036567', checkNumber: null, status: 'CONTESTED' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(2).value).toBeNull()
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(5).value).toBe('CONTESTED')
  })

  it('states in the title block when the cap has bitten', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })], 20_100)
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 20,100 VOUCHERS')
  })

  it('says on the sheet that cheques with no amount are excluded', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(String(ws.getCell('A4').value)).toContain('no recorded amount')
  })
})
