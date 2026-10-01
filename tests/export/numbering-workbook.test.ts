// tests/export/numbering-workbook.test.ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildNumberingWorkbook, sheetNameFor, NUMBERING_SUMMARY_SHEET, NUMBERING_ACCOUNT_HEADERS } from '@/lib/export/numbering-workbook'
import { buildSeries, type SeriesCheque } from '@/lib/numbering/series'
import type { NumberingAccount } from '@/lib/numbering/query'

const ch = (n: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque =>
  ({ id: `id-${n}`, checkNumber: n, checkDate: new Date('2026-09-01T00:00:00Z'), payeeName: 'HENKEL', amount: '197715.42', currency: 'PHP', status })
const account = (code: string, cheques: SeriesCheque[]): NumberingAccount =>
  ({ accountId: `acc-${code}`, account: code, bank: 'BPI', company: 'STK', series: buildSeries(cheques) })
const META = { generatedAt: new Date('2026-10-01T02:00:00Z'), generatedBy: 'Paolo Parcon', filterDescription: 'No filters applied', missingOnly: false, noAccountCount: 3, rowLimit: 50_000 }

async function load(buf: ArrayBuffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  return wb
}

describe('sheetNameFor', () => {
  it('strips the characters Excel refuses, caps at 31, and de-duplicates case-insensitively', () => {
    const used = new Set(['SUMMARY'])
    expect(sheetNameFor('BPI/STK [1]', used)).toBe('BPI STK  1')
    expect(sheetNameFor('summary', used)).toBe('summary (2)')
    const long = 'X'.repeat(40)
    expect(sheetNameFor(long, used)).toHaveLength(31)
    expect(sheetNameFor(long, used)).toBe(`${'X'.repeat(27)} (2)`)
  })
})

describe('sheetNameFor apostrophes', () => {
  it('never starts or ends with an apostrophe', () => {
    expect(sheetNameFor("'X'", new Set())).toBe('X')
    expect(sheetNameFor("''", new Set())).toBe('ACCOUNT')
  })
})

describe('buildNumberingWorkbook', () => {
  it('sets an auto-filter over the header and every written row', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101'), ch('104')])], meta: META }))
    const af = wb.getWorksheet('BPI STK')!.autoFilter
    expect(af).toBe('A1:J4')
  })

  it('writes a null amount as an empty cell and a real amount as a number', async () => {
    const noAmount = { ...ch('5'), amount: null }
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [noAmount, ch('6')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(2).getCell(6).value ?? null).toBeNull()
    expect(ws.getRow(3).getCell(6).value).toBe(197715.42)
  })

  it('notes DUPLICATE NUMBER on both cheques sharing a number', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('8'), { ...ch('8'), id: 'id-8b' }])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(2).getCell(10).value).toBe('DUPLICATE NUMBER')
    expect(ws.getRow(3).getCell(10).value).toBe('DUPLICATE NUMBER')
  })

  it('shades the NOTE cell of a MISSING row', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101'), ch('104')])], meta: META }))
    expect(wb.getWorksheet('BPI STK')!.getRow(3).getCell(10).fill).toMatchObject({ type: 'pattern' })
  })

  it('writes SUMMARY and one sheet per account, MISSING lines in their own columns, numbers as text', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104', 'VOIDED')]), account('MBTC A1', [ch('7')])],
      meta: META,
    }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, 'BPI STK', 'MBTC A1'])

    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(1).values).toEqual([undefined, ...NUMBERING_ACCOUNT_HEADERS])
    expect(ws.getRow(2).getCell(1).value).toBe('101')
    expect(ws.getRow(3).getCell(4).value).toBe('MISSING')
    expect(ws.getRow(3).getCell(7).value).toBe('102')
    expect(ws.getRow(3).getCell(8).value).toBe('103')
    expect(ws.getRow(3).getCell(9).value).toBe(2)
    expect(ws.getRow(4).getCell(4).value).toBe('VOIDED')

    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('BPI STK')
    expect(text).toContain('3 cheques with no cash account')
  })

  it('prints no "Not in any series" sentence when noAccountCount is null', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101')])],
      meta: { ...META, noAccountCount: null },
    }))
    const text = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).not.toContain('Not in any series')
  })

  it('missing-only keeps just the MISSING lines', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104')])],
      meta: { ...META, missingOnly: true },
    }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(4).value).toBe('MISSING')
  })

  it('missing-only writes no sheet for an account with nothing missing', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('FULL', [ch('101'), ch('102')]), account('GAPPY', [ch('201'), ch('204')])],
      meta: { ...META, missingOnly: true },
    }))
    expect(wb.getWorksheet('FULL')).toBeUndefined()
    expect(wb.getWorksheet('GAPPY')).toBeDefined()
    expect(wb.getWorksheet(NUMBERING_SUMMARY_SHEET)).toBeDefined()
  })

  it('lists non-numeric cheques after the sequence', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('5'), ch('MEMO')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(3).getCell(1).value).toBe('MEMO')
    expect(ws.getRow(3).getCell(10).value).toBe('NOT NUMERIC')
  })

  it('stops at the row limit and says so on SUMMARY', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('A', [ch('1'), ch('2'), ch('3')]), account('B', [ch('9')])],
      meta: { ...META, rowLimit: 2 },
    }))
    expect(wb.getWorksheet('A')!.rowCount).toBe(3)
    expect(wb.getWorksheet('B')).toBeUndefined()
    const text = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('first 2 of 4 lines')
  })
})
