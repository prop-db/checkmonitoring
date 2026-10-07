import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildMatrices } from '@/lib/forecast/matrix'
import type { ForecastRow } from '@/lib/forecast/query'
import {
  buildForecastWorkbook, SUMMARY_SHEET, DETAIL_SHEET, DETAIL_HEADERS,
} from '@/lib/export/forecast-workbook'

const TODAY = new Date('2026-09-16T02:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 8, 16 - n))

function row(o: Partial<ForecastRow> & { id: string }): ForecastRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', bank: 'BPI', company: 'STK',
    stage: 'SIGNED', currency: 'PHP', amount: '100.00', checkDate: daysAgo(3),
    kind: 'CHECK', expectedOutflowDate: null,
    ...o,
  }
}

async function build(rows: ForecastRow[], totalRows = rows.length) {
  const { byBank, byStage, bucketed } = buildMatrices(rows, TODAY)
  const buffer = await buildForecastWorkbook({
    byBank, byStage, detail: bucketed,
    meta: {
      generatedAt: TODAY, generatedBy: 'Paolo Parcon',
      filterDescription: 'No filters applied', totalRows, incompleteCount: 129,
      plannedCount: 0, expectedCount: 0,
    },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

describe('buildForecastWorkbook', () => {
  it('writes SUMMARY then DETAIL', async () => {
    const wb = await build([row({ id: 'a' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, DETAIL_SHEET])
  })

  it('titles the summary and states the exclusion and the filters', async () => {
    const wb = await build([row({ id: 'a' })])
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    expect(String(ws.getCell('A1').value)).toContain('CASH OUTFLOW')
    expect(String(ws.getCell('A2').value)).toContain('No filters applied')
    expect(String(ws.getCell('A4').value)).toContain('129')
  })

  it('writes a bucket row per currency with numeric amounts the reader can sum', async () => {
    const wb = await build([
      row({ id: 'a', amount: '100.00' }), row({ id: 'b', amount: '5.00', currency: 'USD' }),
    ])
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    const lines: string[][] = []
    ws.eachRow((r) => lines.push(r.values as string[]))
    const php = lines.find((l) => l[1] === '1–7 DAYS' && l[2] === 'PHP')!
    const usd = lines.find((l) => l[1] === '1–7 DAYS' && l[2] === 'USD')!
    expect(php).toBeDefined()
    expect(usd).toBeDefined()
    // BUCKET, CURRENCY, BPI CHEQUES, BPI AMOUNT, TOTAL CHEQUES, TOTAL AMOUNT
    expect(php[3]).toBe(1)
    expect(php[4]).toBe(100)
    expect(usd[4]).toBe(5)
  })

  it('lists one detail row per check under the fixed header', async () => {
    const wb = await build([row({ id: 'a', checkDate: daysAgo(45) })])
    const ws = wb.getWorksheet(DETAIL_SHEET)!
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual([...DETAIL_HEADERS])
    const r = ws.getRow(2).values as unknown[]
    expect(r[2]).toBe('a')
    expect(r[10]).toBe(45)
    expect(r[11]).toBe('31–60 DAYS')
    expect(r[13]).toBe(100)
  })

  it('says so in the title block when the cap bit', async () => {
    const wb = await build([row({ id: 'a' })], 20_000)
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 20,000')
  })

  // Regression: SUMMARY's counts must come from the matrix, never from
  // `detail`. `detail` is capped at EXPORT_ROW_LIMIT while the matrices are
  // built over the whole population — before this fix, a bucket's CHEQUES
  // column was re-derived by counting `detail` rows, so a capped `detail`
  // silently under-counted the SAME line whose AMOUNT still summed everyone.
  // Here two cheques land in one bucket but `detail` carries only the first,
  // the way the cap would in production: the SUMMARY line must still read
  // CHEQUES = 2 and AMOUNT = 300, because both numbers now come off the
  // matrix, which never saw the cap.
  it('reads counts off the matrix, not off the capped detail rows', async () => {
    const rows = [row({ id: 'a', amount: '100.00' }), row({ id: 'b', amount: '200.00' })]
    const { byBank, byStage, bucketed } = buildMatrices(rows, TODAY)
    const buffer = await buildForecastWorkbook({
      byBank, byStage, detail: bucketed.slice(0, 1),
      meta: {
        generatedAt: TODAY, generatedBy: 'Paolo Parcon',
        filterDescription: 'No filters applied', totalRows: 2, incompleteCount: 129,
        plannedCount: 0, expectedCount: 0,
      },
    })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer)
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    const lines: string[][] = []
    ws.eachRow((r) => lines.push(r.values as string[]))
    const php = lines.find((l) => l[1] === '1–7 DAYS' && l[2] === 'PHP')!
    // BUCKET, CURRENCY, BPI CHEQUES, BPI AMOUNT, TOTAL CHEQUES, TOTAL AMOUNT
    expect(php[3]).toBe(2)
    expect(php[4]).toBe(300)
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 2')
  })

  it('writes KIND, EXPECTED OUT and DATE BASIS on DETAIL, for a check and a planned line', async () => {
    const wb = await build([
      row({ id: 'a', expectedOutflowDate: daysAgo(-2) }),
      row({ id: 'p', checkNumber: 'PLANNED', payee: 'SEPT PAYROLL', stage: 'PLANNED', kind: 'PLANNED', checkDate: daysAgo(0), amount: '250.00' }),
    ])
    const ws = wb.getWorksheet(DETAIL_SHEET)!
    expect(ws.getRow(1).values).toEqual([undefined, ...DETAIL_HEADERS])
    const cheque = ws.getRow(2).values as unknown[]
    expect(cheque[1]).toBe('CHECK')
    expect(cheque[9]).toBe('EXPECTED')
    expect((cheque[8] as Date).toISOString().slice(0, 10)).toBe('2026-09-18')
    const line = ws.getRow(3).values as unknown[]
    expect(line.slice(1, 4)).toEqual(['PLANNED', 'PLANNED', 'SEPT PAYROLL'])
    expect(line[6]).toBe('PLANNED')
    expect(line[9]).toBe('PLANNED')
    expect(line[13]).toBe(250)
  })
})
