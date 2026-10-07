import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { summariseByAccount, type OutstandingRow } from '@/lib/recon/summary'
import { buildReconWorkbook, RECON_SUMMARY_SHEET, RECON_DETAIL_SHEET, RECON_DETAIL_HEADERS } from '@/lib/export/recon-workbook'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
function row(o: Partial<OutstandingRow> & { id: string }): OutstandingRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', accountId: 'acc-bpi', account: 'BPI STK', bank: 'BPI',
    company: 'STK', currency: 'PHP', amount: '100.00', checkDate: d('2026-08-20'), releasedAt: null,
    clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED', ...o,
  }
}

async function build(rows: OutstandingRow[], totalRows?: number) {
  const summary = summariseByAccount(rows, '2026-09-12')
  const buffer = await buildReconWorkbook({
    summary, detail: summary.lines,
    meta: {
      asOfDay: '2026-09-12', generatedAt: new Date('2026-09-12T02:00:00Z'), generatedBy: 'Paolo Parcon',
      filterDescription: 'No filters applied', totalRows: totalRows ?? summary.lines.length, incompleteCount: 25, notYetIssuedCount: 3,
    },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

describe('buildReconWorkbook', () => {
  it('writes SUMMARY then DETAIL, titled by the as-of day, stating the exclusion', async () => {
    const wb = await build([row({ id: 'a' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([RECON_SUMMARY_SHEET, RECON_DETAIL_SHEET])
    const ws = wb.getWorksheet(RECON_SUMMARY_SHEET)!
    expect(String(ws.getCell('A1').value)).toContain('OUTSTANDING CHECKS AS OF 2026-09-12')
    expect(String(ws.getCell('A2').value)).toContain('No filters applied')
    expect(String(ws.getCell('A4').value)).toContain('25')
    expect(String(ws.getCell('A4').value)).toContain('3 released checks dated after the day')
  })

  it('writes one account line per currency with numeric amounts, then totals', async () => {
    const wb = await build([
      row({ id: 'a', amount: '100.00' }), row({ id: 'b', amount: '5.00', currency: 'USD' }),
      row({ id: 'c', accountId: 'acc-m', account: 'MBTC STK', bank: 'MBTC', amount: '7.00' }),
    ])
    const ws = wb.getWorksheet(RECON_SUMMARY_SHEET)!
    const lines: unknown[][] = []
    ws.eachRow((r) => lines.push(r.values as unknown[]))
    // ACCOUNT, BANK, COMPANY, CURRENCY, OUTSTANDING, AMOUNT
    const bpiPhp = lines.find((l) => l[1] === 'BPI STK' && l[4] === 'PHP')!
    expect(bpiPhp[5]).toBe(1)
    expect(bpiPhp[6]).toBe(100)
    const bpiUsd = lines.find((l) => l[1] === 'BPI STK' && l[4] === 'USD')!
    expect(bpiUsd[6]).toBe(5)
    const total = lines.find((l) => l[1] === 'TOTAL' && l[4] === 'PHP')!
    expect(total[5]).toBe(2)
    expect(total[6]).toBe(107)
  })

  it('lists one detail row per outstanding check under the fixed header', async () => {
    const wb = await build([row({ id: 'a' }), row({ id: 'b', releasedAt: new Date('2026-09-10T15:30:00Z') })])
    const ws = wb.getWorksheet(RECON_DETAIL_SHEET)!
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual([...RECON_DETAIL_HEADERS])
    const a = ws.getRow(2).values as unknown[]
    expect(a[1]).toBe('a')
    expect(a[8]).toBe('CHECK DATE')
    expect(a[9]).toBe(23)
    expect(a[10]).toBe('NONE')
    expect(a[12]).toBe(100)
    const b = ws.getRow(3).values as unknown[]
    expect(b[8]).toBe('RELEASED AT')
    expect(b[9]).toBe(2)
  })

  it('says so in the title block when the cap bit', async () => {
    const wb = await build([row({ id: 'a' })], 20_000)
    expect(String(wb.getWorksheet(RECON_SUMMARY_SHEET)!.getCell('A3').value)).toContain('FIRST 1 OF 20,000')
  })
})
