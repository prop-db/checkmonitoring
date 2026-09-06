import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  buildExportWorkbook, REGISTER_SHEET, SUMMARY_SHEET,
  REGISTER_HEADERS, HEADER_ROW, FIRST_DATA_ROW,
  type ExportInput, type ExportSummary,
} from '@/lib/export/workbook'
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '@/lib/export/report'
import type { CheckTableRow } from '@/lib/queries'

const GENERATED_AT = new Date(2026, 8, 6, 14, 30)

function row(overrides: Partial<CheckTableRow> = {}): CheckTableRow {
  return {
    id: 'c1',
    checkNumber: '6000240287',
    apvNumbers: ['APV-0001'],
    payeeName: 'HENKEL PHILIPPINES INC.',
    companyCode: 'STK',
    cashAccountCode: 'BPI STK',
    bankCode: 'BPI',
    checkDate: new Date(Date.UTC(2026, 8, 1)),
    amount: '197715.42',
    currency: 'PHP',
    status: 'READY_FOR_RELEASE',
    eligibility: 'SUPPLIER',
    isCheque: true,
    availablePickupDate: new Date(Date.UTC(2026, 8, 3)),
    scheduledPickupDate: null,
    ...overrides,
  }
}

const summary: ExportSummary = {
  total: 9247,
  pendingSignature: 50,
  signed: 120,
  readyForRelease: 81,
  scheduled: 6,
  released: 7433,
  incomplete: 129,
  totalsByCurrency: [
    { currency: 'PHP', total: '1234567.89', count: 9000 },
    { currency: 'CNY', total: '2000.25', count: 47 },
  ],
}

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    rows: [row()],
    summary,
    meta: {
      viewLabel: 'READY FOR RELEASE',
      filterDescription: 'COMPANY: STK',
      generatedAt: GENERATED_AT,
      generatedBy: 'Paolo Parcon',
      totalMatching: 1,
    },
    ...overrides,
  }
}

/** Generate, then read the real file back. Nothing here is asserted by eye. */
async function readBack(inp: ExportInput) {
  const buffer = await buildExportWorkbook(inp)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb
}

/**
 * ExcelJS accepts an autoFilter as a range object and hands it back as an `A1`
 * reference string. Normalised here so the assertion is about the range, not
 * about which of the two shapes the library happened to return.
 */
function autoFilterRef(ws: ExcelJS.Worksheet): string {
  const f = ws.autoFilter as unknown
  if (typeof f === 'string') return f
  const r = f as { from: { row: number; column: number }; to: { row: number; column: number } }
  const col = (n: number) => String.fromCharCode(64 + n)
  return `${col(r.from.column)}${r.from.row}:${col(r.to.column)}${r.to.row}`
}

describe('the workbook itself', () => {
  it('has exactly the two named sheets, register first', async () => {
    const wb = await readBack(input())
    expect(wb.worksheets.map((w) => w.name)).toEqual([REGISTER_SHEET, SUMMARY_SHEET])
  })
})

describe('CHECK REGISTER — the title block', () => {
  it('opens with the system name, the view, the filters and who generated it', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A1').value).toBe('CHECK RELEASE MONITORING')
    expect(ws.getCell('A2').value).toBe('READY FOR RELEASE — 1 CHEQUE')
    expect(ws.getCell('A3').value).toBe('COMPANY: STK')
    expect(String(ws.getCell('A4').value)).toContain('Paolo Parcon')
    expect(String(ws.getCell('A4').value)).toMatch(/^Generated /)
    expect(String(ws.getCell('A4').value)).toContain('2026')
    // A blank row separates the block from the table.
    expect(ws.getCell(`A${HEADER_ROW - 1}`).value).toBeNull()
  })

  it('sets the first line bold and larger than the body', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const title = ws.getCell('A1')
    expect(title.font?.bold).toBe(true)
    expect(title.font?.size).toBeGreaterThan(11)
  })

  // A short file must never be mistaken for a small result.
  it('states the truncation in the title block when the cap bites', async () => {
    const ws = (await readBack(input({
      meta: { ...input().meta, totalMatching: 12_227 },
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A2').value).toBe('READY FOR RELEASE — FIRST 1 OF 12,227 MATCHING CHEQUES')
  })

  it('says so plainly when nothing is narrowing the view', async () => {
    const ws = (await readBack(input({
      meta: { ...input().meta, filterDescription: 'No filters applied' },
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A3').value).toBe('No filters applied')
  })
})

describe('CHECK REGISTER — the header row', () => {
  it('carries the ten agreed columns, in order', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const header = ws.getRow(HEADER_ROW)
    expect(REGISTER_HEADERS).toEqual([
      'CHECK NUMBER', 'APV NUMBER', 'SUPPLIER NAME', 'COMPANY', 'BANK',
      'CHECK DATE', 'AMOUNT', 'STATUS', 'AVAILABLE DATE', 'PICKUP SCHEDULE',
    ])
    expect(REGISTER_HEADERS.map((_, i) => header.getCell(i + 1).value)).toEqual([...REGISTER_HEADERS])
  })

  it('is bold, white, on a dark fill', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const cell = ws.getRow(HEADER_ROW).getCell(1)
    expect(cell.font?.bold).toBe(true)
    expect(cell.font?.color?.argb).toBe('FFFFFFFF')
    const fill = cell.fill as ExcelJS.FillPattern
    expect(fill.type).toBe('pattern')
    expect(fill.fgColor?.argb).toBe('FF1E293B')
  })

  // Frozen BELOW the header, not at row 1: the point is that the column names
  // stay on screen when a manager scrolls into the four-thousandth row.
  it('is frozen, together with the title block above it', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: HEADER_ROW })
    expect(HEADER_ROW).toBeGreaterThan(1)
  })

  it('carries an autofilter over the header and the data, but not the totals', async () => {
    const ws = (await readBack(input({ rows: [row(), row({ id: 'c2' })] }))).getWorksheet(REGISTER_SHEET)!
    expect(autoFilterRef(ws)).toBe(`A${HEADER_ROW}:J${HEADER_ROW + 2}`)
  })
})

describe('CHECK REGISTER — the rows', () => {
  it('writes each field into its column', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const r = ws.getRow(FIRST_DATA_ROW)
    expect(r.getCell(1).value).toBe('6000240287')
    expect(r.getCell(2).value).toBe('APV-0001')
    expect(r.getCell(3).value).toBe('HENKEL PHILIPPINES INC.')
    expect(r.getCell(4).value).toBe('STK')
    expect(r.getCell(5).value).toBe('BPI STK')
    expect(r.getCell(8).value).toBe('READY FOR RELEASE')
  })

  it('joins every APV on the cheque, because the search matched across all of them', async () => {
    const ws = (await readBack(input({
      rows: [row({ apvNumbers: ['APV-1', 'APV-2'] })],
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(FIRST_DATA_ROW).getCell(2).value).toBe('APV-1, APV-2')
  })

  it('names the institution when the cash account code does not already', async () => {
    const ws = (await readBack(input({
      rows: [row({ cashAccountCode: 'STK MAIN', bankCode: 'BDO' })],
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(FIRST_DATA_ROW).getCell(5).value).toBe('STK MAIN (BDO)')
  })

  it('writes the amount as a real number with a currency format, right aligned', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const cell = ws.getRow(FIRST_DATA_ROW).getCell(7)
    expect(typeof cell.value).toBe('number')
    expect(cell.value).toBe(197715.42)
    expect(cell.numFmt).toBe('"₱"#,##0.00')
    expect(cell.alignment?.horizontal).toBe('right')
  })

  it('formats a CNY amount in its own currency, never in pesos', async () => {
    const ws = (await readBack(input({
      rows: [row({ currency: 'CNY', amount: '2000.25' })],
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(FIRST_DATA_ROW).getCell(7).numFmt).toBe('"¥"#,##0.00')
  })

  /**
   * The one that matters most. 129 production cheques carry no amount, and a
   * zero would be read as a cheque genuinely drawn for nothing — indistinguishable
   * from the real thing once it is in a spreadsheet on somebody's laptop.
   */
  it('leaves the amount cell BLANK for a cheque with no recorded amount, never zero', async () => {
    const ws = (await readBack(input({
      rows: [row({ amount: null })],
    }))).getWorksheet(REGISTER_SHEET)!
    const cell = ws.getRow(FIRST_DATA_ROW).getCell(7)
    expect(cell.value).toBeNull()
    expect(cell.value).not.toBe(0)
  })

  it('writes the dates as real Excel dates with a readable format', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const cell = ws.getRow(FIRST_DATA_ROW).getCell(6)
    expect(cell.value).toBeInstanceOf(Date)
    expect((cell.value as Date).toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(cell.numFmt).toBe('dd mmm yyyy')
    expect(ws.getRow(FIRST_DATA_ROW).getCell(9).value).toBeInstanceOf(Date)
  })

  it('leaves a missing date, payee or APV blank rather than writing a placeholder', async () => {
    const ws = (await readBack(input({
      rows: [row({ checkDate: null, payeeName: null, apvNumbers: [], scheduledPickupDate: null })],
    }))).getWorksheet(REGISTER_SHEET)!
    const r = ws.getRow(FIRST_DATA_ROW)
    expect(r.getCell(2).value).toBeNull()
    expect(r.getCell(3).value).toBeNull()
    expect(r.getCell(6).value).toBeNull()
    expect(r.getCell(10).value).toBeNull()
  })

  it('bands alternate rows and borders every cell so it reads in print', async () => {
    const ws = (await readBack(input({
      rows: [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })],
    }))).getWorksheet(REGISTER_SHEET)!
    const first = ws.getRow(FIRST_DATA_ROW).getCell(1)
    const second = ws.getRow(FIRST_DATA_ROW + 1).getCell(1)
    expect((first.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb).toBeUndefined()
    expect((second.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFF1F5F9')
    expect(first.border?.bottom?.style).toBe('thin')
  })
})

describe('CHECK REGISTER — the totals', () => {
  it('states the count and then one total per currency', async () => {
    const ws = (await readBack(input({
      rows: [
        row({ id: 'a', currency: 'PHP', amount: '1000.00' }),
        row({ id: 'b', currency: 'PHP', amount: '500.50' }),
        row({ id: 'c', currency: 'CNY', amount: '2000.25' }),
      ],
      meta: { ...input().meta, totalMatching: 3 },
    }))).getWorksheet(REGISTER_SHEET)!

    const countRow = FIRST_DATA_ROW + 3 + 1 // three rows, then a blank
    expect(ws.getCell(`A${countRow}`).value).toBe('TOTAL — 3 CHEQUES EXPORTED')

    expect(ws.getCell(`A${countRow + 1}`).value).toBe('TOTAL VALUE — CNY (1 CHEQUE)')
    expect(ws.getCell(`G${countRow + 1}`).value).toBe(2000.25)
    expect(ws.getCell(`G${countRow + 1}`).numFmt).toBe('"¥"#,##0.00')

    expect(ws.getCell(`A${countRow + 2}`).value).toBe('TOTAL VALUE — PHP (2 CHEQUES)')
    expect(ws.getCell(`G${countRow + 2}`).value).toBe(1500.5)
    expect(ws.getCell(`G${countRow + 2}`).numFmt).toBe('"₱"#,##0.00')
    expect(ws.getCell(`G${countRow + 2}`).font?.bold).toBe(true)
  })

  // The hard rule, restated where a spreadsheet could most easily break it: one
  // grand total across two currencies would be a number with no meaning.
  it('never writes a figure that adds two currencies together', async () => {
    const ws = (await readBack(input({
      rows: [
        row({ id: 'a', currency: 'PHP', amount: '1000.00' }),
        row({ id: 'b', currency: 'CNY', amount: '2000.25' }),
      ],
    }))).getWorksheet(REGISTER_SHEET)!
    const amounts: number[] = []
    ws.eachRow((r) => {
      const v = r.getCell(7).value
      if (typeof v === 'number') amounts.push(v)
    })
    expect(amounts).not.toContain(3000.25)
    expect(amounts.sort((a, b) => a - b)).toEqual([1000, 1000, 2000.25, 2000.25])
  })

  it('leaves the total blank when no amount in a currency is known', async () => {
    const ws = (await readBack(input({
      rows: [row({ id: 'a', amount: null }), row({ id: 'b', amount: null })],
    }))).getWorksheet(REGISTER_SHEET)!
    const totalRow = FIRST_DATA_ROW + 2 + 2
    expect(ws.getCell(`A${totalRow}`).value).toBe('TOTAL VALUE — PHP (2 CHEQUES)')
    expect(ws.getCell(`G${totalRow}`).value).toBeNull()
  })

  it('says how many of the exported cheques carry no amount', async () => {
    const ws = (await readBack(input({
      rows: [row({ id: 'a' }), row({ id: 'b', amount: null })],
    }))).getWorksheet(REGISTER_SHEET)!
    const note = FIRST_DATA_ROW + 2 + 1 + 1 + 1 // rows, blank, count, one currency
    expect(String(ws.getCell(`A${note}`).value)).toContain('1 OF THESE CHEQUES HAS NO RECORDED AMOUNT')
  })

  it('omits that note when every exported cheque carries an amount', async () => {
    const ws = (await readBack(input())).getWorksheet(REGISTER_SHEET)!
    const values: string[] = []
    ws.eachRow((r) => { if (typeof r.getCell(1).value === 'string') values.push(r.getCell(1).value as string) })
    expect(values.some((v) => v.includes('NO RECORDED AMOUNT'))).toBe(false)
  })

  it('still writes a readable sheet when nothing matches the filters', async () => {
    const ws = (await readBack(input({
      rows: [], meta: { ...input().meta, totalMatching: 0 },
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A2').value).toBe('READY FOR RELEASE — NO CHEQUES MATCH')
    expect(ws.getRow(HEADER_ROW).getCell(1).value).toBe('CHECK NUMBER')
    expect(ws.getCell(`A${FIRST_DATA_ROW + 1}`).value).toBe('TOTAL — 0 CHEQUES EXPORTED')
  })
})

describe('CHECK REGISTER — the column widths', () => {
  it('fits each column to its own longest value, within bounds', async () => {
    const ws = (await readBack(input({
      rows: [row({ payeeName: 'HENKEL PHILIPPINES INCORPORATED AND COMPANY' })],
    }))).getWorksheet(REGISTER_SHEET)!
    for (let i = 1; i <= REGISTER_HEADERS.length; i++) {
      const w = ws.getColumn(i).width
      expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH)
      expect(w).toBeLessThanOrEqual(MAX_COLUMN_WIDTH)
    }
    // COMPANY holds "STK"; SUPPLIER NAME holds a 43-character payee. They must
    // not come out the same width.
    expect(ws.getColumn(4).width).toBeLessThan(ws.getColumn(3).width!)
    expect(ws.getColumn(3).width).toBe(MAX_COLUMN_WIDTH)
  })

  it('measures the formatted amount, not the raw decimal string', async () => {
    const ws = (await readBack(input({
      rows: [row({ amount: '1234567890.12' })],
    }))).getWorksheet(REGISTER_SHEET)!
    // "₱1,234,567,890.12" is 17 characters — wider than the AMOUNT header.
    expect(ws.getColumn(7).width).toBeGreaterThan('AMOUNT'.length + 2)
  })
})

describe('SUMMARY', () => {
  it('repeats the title block and says the figures are not filtered', async () => {
    const ws = (await readBack(input())).getWorksheet(SUMMARY_SHEET)!
    expect(ws.getCell('A1').value).toBe('CHECK RELEASE MONITORING')
    expect(ws.getCell('A1').font?.bold).toBe(true)
    expect(ws.getCell('A2').value).toBe('SUMMARY — EVERY CHEQUE IN THE SYSTEM')
    expect(String(ws.getCell('A3').value)).toContain('not narrowed by the filters')
    expect(String(ws.getCell('A4').value)).toContain('Paolo Parcon')
  })

  it('lists the count for every status the dashboard cards show', async () => {
    const ws = (await readBack(input())).getWorksheet(SUMMARY_SHEET)!
    const found = new Map<string, unknown>()
    ws.eachRow((r) => {
      const label = r.getCell(1).value
      if (typeof label === 'string') found.set(label, r.getCell(2).value)
    })
    expect(found.get('PENDING SIGNATURE')).toBe(50)
    expect(found.get('SIGNED')).toBe(120)
    expect(found.get('READY FOR RELEASE')).toBe(81)
    expect(found.get('SCHEDULED')).toBe(6)
    expect(found.get('RELEASED')).toBe(7433)
    expect(found.get('TOTAL CHEQUES')).toBe(9247)
    expect(found.get('NO RECORDED AMOUNT')).toBe(129)
  })

  it('gives every currency its own value line and never one grand total', async () => {
    const ws = (await readBack(input())).getWorksheet(SUMMARY_SHEET)!
    const values = new Map<string, { count: unknown; total: unknown; numFmt: string | undefined }>()
    ws.eachRow((r) => {
      const c = r.getCell(1).value
      if (c === 'PHP' || c === 'CNY') {
        values.set(c, { count: r.getCell(2).value, total: r.getCell(3).value, numFmt: r.getCell(3).numFmt })
      }
    })
    expect(values.get('PHP')).toEqual({ count: 9000, total: 1234567.89, numFmt: '"₱"#,##0.00' })
    expect(values.get('CNY')).toEqual({ count: 47, total: 2000.25, numFmt: '"¥"#,##0.00' })
  })

  it('leaves a currency total blank rather than writing zero when nothing is known', async () => {
    const ws = (await readBack(input({
      summary: { ...summary, totalsByCurrency: [{ currency: 'PHP', total: null, count: 3 }] },
    }))).getWorksheet(SUMMARY_SHEET)!
    let total: unknown = 'not found'
    ws.eachRow((r) => { if (r.getCell(1).value === 'PHP') total = r.getCell(3).value })
    expect(total).toBeNull()
  })

  it('fits its own columns rather than leaving them at the default', async () => {
    const ws = (await readBack(input())).getWorksheet(SUMMARY_SHEET)!
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH)
    expect(ws.getColumn(1).width).toBeLessThanOrEqual(MAX_COLUMN_WIDTH)
    expect(ws.getColumn(2).width).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH)
  })
})

describe('a large export', () => {
  it('writes several thousand rows without losing one', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) =>
      row({ id: `c${i}`, checkNumber: `60002${String(i).padStart(5, '0')}`, amount: '1.00' }))
    const ws = (await readBack(input({
      rows, meta: { ...input().meta, totalMatching: 2_500 },
    }))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(FIRST_DATA_ROW + 2_499).getCell(1).value).toBe('60002' + '02499')
    expect(ws.getCell(`G${FIRST_DATA_ROW + 2_500 + 2}`).value).toBe(2500)
  })
})
