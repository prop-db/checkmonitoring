import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildTransmittalWorkbook, TRANSMITTAL_SHEET } from '@/lib/export/transmittal-workbook'

describe('buildTransmittalWorkbook', () => {
  it('lays out TO, the columns, the rows, a centavo-exact total and the signatories', async () => {
    const buf = await buildTransmittalWorkbook({
      lines: [
        { checkNumber: '1791405999', cashAccount: 'MBT-A-9048', poNumber: '23X09-0056', voucher: 'AP-A1015451', payee: 'SAVE PLUS', amount: '190817.35', currency: 'PHP' },
        { checkNumber: '1791406000', cashAccount: 'MBT-A-9048', poNumber: '', voucher: 'AP-A1015281', payee: 'SAVE PLUS', amount: '0.10', currency: 'PHP' },
      ],
      meta: { to: 'BOSS ROBERT', date: '2026-10-06', preparedBy: 'Ayessa', checkedBy: 'Maureen', approvedBy: 'GPG/GTC' },
    })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.getWorksheet(TRANSMITTAL_SHEET)!
    expect(ws.getCell('A6').value).toBe('TO:  BOSS ROBERT')
    expect(ws.getCell('G6').value).toBe('10/6/2026')
    expect(ws.getCell('B8').value).toBe('1791405999')
    expect(ws.getCell('G8').value).toBe(190817.35)
    expect(ws.getCell('A10').value).toBeNull()
    expect(JSON.stringify(ws.getRows(1, 20)!.map((r) => r.values))).not.toContain('TOTAL')
    expect(ws.pageSetup.orientation).toBe('portrait')
    expect(ws.pageSetup.paperSize).toBe(1)
    // Three separate signature lines: the columns between the blocks carry no rule.
    expect(ws.getCell('A14').border?.top).toBeTruthy()
    expect(ws.getCell('C14').border?.top).toBeUndefined()
    expect(ws.getCell('F14').border?.top).toBeUndefined()
    const all = ws.getRows(1, 20)!.flatMap((r) => (r.values as unknown[]).filter((v) => typeof v === 'string'))
    expect(all).toEqual(expect.arrayContaining(['PREPARED BY:', 'AYESSA', 'CHECKED BY:', 'MAUREEN', 'APPROVED BY:', 'GPG/GTC']))
  })
})
