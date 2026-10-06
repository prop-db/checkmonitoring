// tests/export/numbering-workbook.test.ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  buildNumberingWorkbook, sheetNameFor, NUMBERING_SUMMARY_SHEET, NUMBERING_ACCOUNT_HEADERS, NUMBERING_TO_FIX_SHEET, NUMBERING_TO_FIX_HEADERS,
} from '@/lib/export/numbering-workbook'
import { buildSeries, type SeriesCheque, type SeriesStaged } from '@/lib/numbering/series'
import type { NumberingAccount } from '@/lib/numbering/query'

const ch = (n: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque =>
  ({ id: `id-${n}`, checkNumber: n, checkDate: new Date('2026-09-01T00:00:00Z'), payeeName: 'HENKEL', amount: '197715.42', currency: 'PHP', status, cv: `CV-${n}` })
const account = (code: string, cheques: SeriesCheque[]): NumberingAccount =>
  ({ accountId: `acc-${code}`, account: code, bank: 'BPI', company: 'STK', series: buildSeries(cheques) })
const META = { generatedAt: new Date('2026-10-01T02:00:00Z'), generatedBy: 'Paolo Parcon', filterDescription: 'No filters applied', missingOnly: false, noAccountCount: 3, registerOnlyCount: 5, rowLimit: 50_000 }

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
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, NUMBERING_TO_FIX_SHEET, 'BPI STK', 'MBTC A1'])

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
    expect(text).toContain('3 cheques with no cheque book')
  })

  it('prints no "Not in any series" sentence when noAccountCount is null', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101')])],
      meta: { ...META, noAccountCount: null, registerOnlyCount: null },
    }))
    const text = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).not.toContain('Not in any series')
    expect(text).not.toContain('REGISTER-ONLY')
  })

  it('states the register-only count on A4, after the no-book sentence (spec §G2)', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101')])], meta: META }))
    const a4 = String(wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getCell('A4').value)
    expect(a4).toContain('5 REGISTER-ONLY CHEQUES (NOT IN ACUMATICA) ARE NOT SHOWN.')
    expect(a4.indexOf('3 cheques with no cheque book')).toBeLessThan(a4.indexOf('5 REGISTER-ONLY'))
    const one = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101')])], meta: { ...META, registerOnlyCount: 1 } }))
    expect(String(one.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getCell('A4').value)).toContain('1 REGISTER-ONLY CHEQUE (NOT IN ACUMATICA) IS NOT SHOWN.')
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

const stg = (ref: string, cv: string): SeriesStaged =>
  ({ acumaticaTenant: 'GOLIVE', acumaticaRef: cv, statedCheckRef: ref, checkDate: new Date('2026-09-02T00:00:00Z'), payeeName: 'HENKEL', amount: '500.00', currency: 'PHP' })

describe('STAGED lines', () => {
  it('writes a STAGED row with the stated reference verbatim and the CV in NOTE', async () => {
    const acc = { accountId: 'acc-X', account: 'BPI STK', bank: 'BPI', company: 'STK', series: buildSeries([ch('101'), ch('103')], [stg('102.', 'CV-ST000102')]) }
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    const row = ws.getRow(3)
    expect(row.getCell(1).value).toBe('102.')
    expect(row.getCell(4).value).toBe('STAGED')
    expect(row.getCell(6).value).toBe(500)
    expect(String(row.getCell(10).value)).toContain('CV-ST000102')
    expect(ws.rowCount).toBe(4) // header, 101, STAGED 102, 103 — no MISSING line
  })

  it('an out-of-pattern cheque is written after the sequence with its note, and SUMMARY counts it', async () => {
    const inPattern = Array.from({ length: 25 }, (_, i) => ch(String(6000100000 + i)))
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [...inPattern, ch('1791361374')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.rowCount).toBe(27) // header, 25 in sequence, 1 out of pattern — no MISSING line
    expect(ws.getRow(27).getCell(1).value).toBe('1791361374')
    expect(ws.getRow(27).getCell(10).value).toBe('OUT OF PATTERN (expected 10 digits starting 60)')
    expect(ws.getRow(26).getCell(1).value).toBe('6000100024')

    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const labels = Array.from({ length: 13 }, (_, i) => summary.getRow(6).getCell(i + 1).value)
    const col = labels.indexOf('OUT OF PATTERN') + 1
    expect(col).toBe(labels.indexOf('NOT NUMERIC') + 2)
    expect(summary.getRow(7).getCell(col).value).toBe(1)
  })

  it('SUMMARY carries a STAGED column', async () => {
    const acc = { accountId: 'acc-X', account: 'BPI STK', bank: 'BPI', company: 'STK', series: buildSeries([ch('101')], [stg('102.', 'CV-1'), stg('102..', 'CV-2')]) }
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const header = summary.getRow(6)
    const labels = Array.from({ length: 12 }, (_, i) => header.getCell(i + 1).value)
    const col = labels.indexOf('STAGED') + 1
    expect(col).toBeGreaterThan(0)
    expect(summary.getRow(7).getCell(col).value).toBe(2)
  })
})

describe('TO FIX IN ACUMATICA (spec §G3)', () => {
  /** BPI STK: 25 in pattern (6000100000..24), a stray first 6000000001, one cheque and one staged line out of pattern. */
  function toFixBook(): NumberingAccount {
    const inPattern = Array.from({ length: 25 }, (_, i) => ch(String(6000100000 + i)))
    return {
      accountId: 'acc-BPI', account: 'BPI STK', bank: 'BPI', company: 'STK',
      series: buildSeries([ch('6000000001'), ...inPattern, ch('1791361374', 'VOIDED')], [stg('1791361375.', 'CV-ST000777')]),
    }
  }
  const rowsOf = (ws: ExcelJS.Worksheet) =>
    Array.from({ length: ws.rowCount - 1 }, (_, i) => Array.from({ length: 7 }, (_, c) => ws.getRow(i + 2).getCell(c + 1).value))

  it('sits right after SUMMARY with its header, and lists every entry newest cheque date first, each with its CV', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [toFixBook(), account('MBTC A1', [ch('7')])], meta: META }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, NUMBERING_TO_FIX_SHEET, 'BPI STK', 'MBTC A1'])
    const ws = wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!
    expect(ws.getRow(1).values).toEqual([undefined, ...NUMBERING_TO_FIX_HEADERS])
    expect(NUMBERING_TO_FIX_HEADERS).toEqual(['CHEQUE BOOK', 'CHECK NUMBER', 'CV', 'CHEQUE DATE', 'PAYEE', 'STATUS', 'REASON'])
    const sept1 = new Date('2026-09-01T00:00:00Z')
    const sept2 = new Date('2026-09-02T00:00:00Z')
    // Newest cheque date first; on the same date, by cheque book, then cheque number.
    expect(rowsOf(ws)).toEqual([
      ['BPI STK', '1791361375.', 'CV-ST000777', sept2, 'HENKEL', 'STAGED', 'OUT OF PATTERN — expected 10 digits starting 60'],
      ['BPI STK', '1791361374', 'CV-1791361374', sept1, 'HENKEL', 'VOIDED', 'OUT OF PATTERN — expected 10 digits starting 60'],
      ['BPI STK', '6000000001', 'CV-6000000001', sept1, 'HENKEL', 'RELEASED', 'STRAY FIRST NUMBER — next is 99999 higher'],
    ])
    expect(ws.autoFilter).toBe('A1:G4')
  })

  it('sorts across cheque books newest first, with an undated cheque last (user request 2026-10-06)', async () => {
    const dated = (n: string, day: string | null, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque =>
      ({ ...ch(n, status), checkDate: day ? new Date(`${day}T00:00:00Z`) : null })
    const inPattern = (base: number) => Array.from({ length: 25 }, (_, i) => ch(String(base + i)))
    const older: NumberingAccount = {
      accountId: 'acc-A', account: 'AAA BOOK', bank: 'BPI', company: 'STK',
      series: buildSeries([...inPattern(6000100000), dated('1791000001', '2026-02-10'), dated('1791000002', null)]),
    }
    const newer: NumberingAccount = {
      accountId: 'acc-Z', account: 'ZZZ BOOK', bank: 'BPI', company: 'STK',
      series: buildSeries([...inPattern(6000200000), dated('1791000003', '2026-10-05', 'SIGNATURE_PENDING')]),
    }
    const wb = await load(await buildNumberingWorkbook({ accounts: [older, newer], meta: META }))
    const numbers = rowsOf(wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!).map((r) => r[1])
    expect(numbers).toEqual(['1791000003', '1791000001', '1791000002'])
  })

  it('is written in full under MISSING ONLY and past the row limit', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [toFixBook()], meta: { ...META, missingOnly: true, rowLimit: 1 } }))
    expect(wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!.rowCount).toBe(4)
  })

  it('holds only its header when there is nothing to fix, and its name is never reused by a book', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('TO FIX IN ACUMATICA', [ch('1'), ch('2')])], meta: META }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, NUMBERING_TO_FIX_SHEET, 'TO FIX IN ACUMATICA (2)'])
    expect(wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!.rowCount).toBe(1)
  })
})
