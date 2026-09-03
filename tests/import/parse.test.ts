import { describe, it, expect } from 'vitest'
import { parseRows } from '@/lib/import/parse'

const row = (sheet: string, n: number, cells: unknown[]) => ({ sheet, row: n, cells })

describe('parseRows', () => {
  it('finds each field wherever it sits in the row', () => {
    // A BPI RELEASED row: APV in position 7, CV in 3, checkbook in 6.
    const [r] = parseRows([row('BPI RELEASED', 2, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'STARKSON PACKAGING INC.',
      'PO-ST-027363 WEEKLY DIRECT', 'BPI-S-4636', 'AP-ST036198', 46014, 7950, 46024, 'DEPOSITED',
    ])]).parsed
    expect(r.checkNumber).toBe('6000308584')
    expect(r.cvNumber).toBe('CV-ST011550')
    expect(r.apvNumbers).toEqual(['AP-ST036198'])
    expect(r.checkBook).toBe('BPI-S-4636')
    // Serial 46014. Computed, not eyeballed — an earlier version of this file
    // asserted 2026-01-01 here, which is serial 46023 and appears nowhere in
    // the fixture. The parser takes the first date serial in the row.
    expect(r.checkDate?.toISOString().slice(0, 10)).toBe('2025-12-23')
  })

  it('finds the same fields when the columns are in a different order', () => {
    // An MBTC AVAIL. row: CV in position 1, APV in 5, PO in 7.
    const [r] = parseRows([row('MBTC AVAIL.', 2, [
      'YES', 'CV-A1010588', '1791361727', 'Painting of machine due to rust',
      'Rockwell Lumber and Hardware,Inc.', 'AP-A1032102', 'MBT-A-4155', 'PO-A1-024539', 46079,
    ])]).parsed
    expect(r.cvNumber).toBe('CV-A1010588')
    expect(r.checkNumber).toBe('1791361727')
    expect(r.apvNumbers).toEqual(['AP-A1032102'])
    expect(r.poNumbers).toEqual(['PO-A1-024539'])
  })

  it('collects every APV on a multi-bill row', () => {
    const [r] = parseRows([row('BPI RELEASED', 5, [
      '6000308611', 'AP-ST036371', 'AP-ST036372', 'CV-A1009393',
    ])]).parsed
    expect(r.apvNumbers).toEqual(['AP-ST036371', 'AP-ST036372'])
  })

  it('recovers a PO number embedded ahead of its description', () => {
    // 1,508 cells in the register have this shape. Without this the PO is lost
    // and the whole string competes to be free text.
    //
    // NOTE: the payee is placed in column E (index 4) here, not left where an
    // earlier version of this fixture put it (index 2). That earlier layout
    // only passed because the now-removed shortest-lettered-string heuristic
    // happened to guess correctly; it encoded the old guessing behaviour
    // rather than the column-E read this task introduces. See
    // p2-task-6-report.md for the RED this produced.
    const [r] = parseRows([row('BPI RELEASED', 7, [
      '6000308584', null, null, null, 'STARKSON PACKAGING INC.',
      'PO-ST-027363 WEEKLY DIRECT (DISNEY) D2, D5, D7, D6 RESTDAY HOLIDAY FTP NOV. 30, 2025 (11 PAX)',
    ])]).parsed
    expect(r.poNumbers).toContain('PO-ST-027363')
    expect(r.unclassified.some((u) => u.startsWith('WEEKLY DIRECT'))).toBe(true)
    expect(r.unclassified.some((u) => u.startsWith('PO-ST-027363'))).toBe(false)
    expect(r.payee).toBe('STARKSON PACKAGING INC.')
  })

  it('reads the payee from column E', () => {
    // Column index 4. Measured across all fifteen sheets of the real register:
    // 88-100% of rows carry the company name there.
    const [r] = parseRows([row('BPI RELEASED', 2, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'STARKSON PACKAGING INC.',
      'PO-ST-027363 A MUCH LONGER DESCRIPTION OF THE PURCHASE', 'BPI-S-4636',
    ])]).parsed
    expect(r.payee).toBe('STARKSON PACKAGING INC.')
  })

  it('leaves the payee null when column E is empty, rather than guessing', () => {
    // No fallback by design. Guessing from the rest of the row produced four
    // classes of wrong payee across ~10,000 rows of the real register. A blank
    // payee also fails safe: classifyEligibility treats it as INTERNAL, so an
    // unknown payee is never pushed to the supplier portal.
    const [r] = parseRows([row('BPI RELEASED', 3, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', null, 'SOME LONG DESCRIPTION OF THE PURCHASE',
    ])]).parsed
    expect(r.checkNumber).toBe('6000308584')
    expect(r.payee).toBeNull()
  })

  it('does not take a number from column E as the payee', () => {
    const [r] = parseRows([row('BPI RELEASED', 4, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 7950,
    ])]).parsed
    expect(r.payee).toBeNull()
  })

  it('does not take a cash-account label from column E as the payee', () => {
    const [r] = parseRows([row('BPI RELEASED', 5, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'BPI STK',
    ])]).parsed
    expect(r.payee).toBeNull()
    expect(r.cashAccountLabel).toBe('BPI STK')
  })
  it('reports a row with no check number for review rather than dropping it', () => {
    const { parsed, review } = parseRows([row('BPI RELEASED', 9, ['PAID', 'DEPOSITED'])])
    expect(parsed).toHaveLength(0)
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({ sheet: 'BPI RELEASED', row: 9, reason: 'NO_CHECK_NUMBER' })
  })

  it('ignores an Invalid Date rather than passing it to the database', () => {
    // ExcelJS produces these for malformed date cells; three exist in the real
    // register. `instanceof Date` accepts them and Prisma throws on write.
    const [r] = parseRows([row('CANCELLED', 517, ['6000329057', new Date('not a date')])]).parsed
    expect(r.checkNumber).toBe('6000329057')
    expect(r.checkDate).toBeNull()
  })

  it('never silently discards a row', () => {
    const rows = [
      row('A', 2, ['6000000001']),
      row('A', 3, ['nothing useful']),
      row('A', 4, ['6000000002']),
    ]
    const { parsed, review } = parseRows(rows)
    expect(parsed.length + review.length).toBe(rows.length)
  })
})

// The amount lives in column J (index 9) on all fifteen sheets, headed either
// "CHECK AMOUNT" or "AMOUNT" — the same kind of structural fact as the payee in
// column E. Measured across the real register's 12,227 data rows: 11,827
// numbers, 260 empty, 135 the word "CANCELLED", 2 dates, 2 with a currency
// prefix, 1 a stray newline.
//
// Before this, amounts were captured for *no* row at all. `sniff` returns
// UNKNOWN for a plain numeric cell — it is neither a date serial nor a 6/10
// digit cheque number — so every amount fell through to free text, and the
// AMOUNT rule that fed `r.amount` only ever fired for comma-formatted decimal
// *strings*, of which the register has none in that column.
describe('parseRows — the amount column', () => {
  const atNine = (v: unknown) =>
    ['PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'ACME INC.', null, null, null, 46014, v]

  it('reads the amount from column J', () => {
    const [r] = parseRows([row('BPI RELEASED', 2, atNine(7950))]).parsed
    expect(r.amount).toBe('7950')
  })

  it('keeps centavos exactly as written', () => {
    // Not reformatted, not rounded, not passed through a float dance. The
    // column is Decimal(18,2); the parser's job is to hand over the digits.
    const [r] = parseRows([row('BPI RELEASED', 3, atNine(80552.41))]).parsed
    expect(r.amount).toBe('80552.41')
  })

  it('keeps a negative amount rather than dropping or flipping it', () => {
    // 16 real rows are negative — reversals on BPI A1 RELEASED and CANCELLED.
    // A reversal that imports as a positive amount would overstate the ledger.
    const [r] = parseRows([row('CANCELLED', 245, atNine(-2982))]).parsed
    expect(r.amount).toBe('-2982')
  })

  it('records the currency when the cell states one', () => {
    // FT & MC:8 holds "USD 300000". Read as 300000 PHP it would understate the
    // cheque by roughly the exchange rate.
    const [r] = parseRows([row('FT & MC', 8, atNine('USD 300000'))]).parsed
    expect(r.amount).toBe('300000')
    expect(r.currency).toBe('USD')
  })

  it('leaves the currency unstated when the cell is a bare number', () => {
    // The parser reports what the register says. Defaulting to PHP is a
    // decision for the upsert, made once and visibly, not invented here.
    const [r] = parseRows([row('BPI RELEASED', 2, atNine(7950))]).parsed
    expect(r.currency).toBeNull()
  })

  it('reads a text-formatted amount', () => {
    const [r] = parseRows([row('BPI RELEASED', 4, atNine('1,254,000.00'))]).parsed
    expect(r.amount).toBe('1254000.00')
  })

  it('has no amount when the column holds a status word', () => {
    // 135 rows on the CANCELLED sheet carry "CANCELLED" here.
    const [r] = parseRows([row('CANCELLED', 20, atNine('CANCELLED'))]).parsed
    expect(r.amount).toBeNull()
  })

  it('has no amount when the column holds a date', () => {
    // 2 real rows are shifted and put a date here. The row still imports.
    const [r] = parseRows([row('BPI RELEASED', 3698, atNine(new Date('2026-05-25')))]).parsed
    expect(r.amount).toBeNull()
    expect(r.checkNumber).toBe('6000308584')
  })

  it('has no amount when the column is empty', () => {
    expect(parseRows([row('BPI RELEASED', 5, atNine(null))]).parsed[0].amount).toBeNull()
    expect(parseRows([row('MBTC AVAIL.', 53, atNine('\n'))]).parsed[0].amount).toBeNull()
  })

  it('does not take an amount from any other column', () => {
    // The old behaviour let any amount-shaped cell anywhere in the row win the
    // `??=` race. Column J is the amount; a figure in REMARKS is not.
    const cells = atNine(null)
    cells[11] = '235714.29'
    const [r] = parseRows([row('STK P&P RELEASED', 6, cells)]).parsed
    expect(r.amount).toBeNull()
  })

  it('keeps the amount cell out of the free-text pool', () => {
    const [r] = parseRows([row('BPI RELEASED', 2, atNine(7950))]).parsed
    expect(r.unclassified).not.toContain('7950')
  })
})

describe('parseRows — the mis-keyed checkbook', () => {
  // Finance confirmed (2026-09-03) that MBT-S-9048 is a mis-keying of
  // MBT-A-9048. It is deliberately absent from prisma/reference-data.ts, so a
  // parser that passed the typo through would either fail to resolve the
  // checkbook or — if someone "helpfully" re-added it to the reference data —
  // seed a second CheckBook row for one physical book and split its cheques.
  // Both codes map to A1PP, so no cheque would land under the wrong company:
  // the fault would be invisible, which is why it is pinned here.
  it('corrects the mis-keyed checkbook code on the way in', () => {
    const [r] = parseRows([row('MBTC RELEASED', 4, [
      'PAID', null, '1791379605', null, 'ACME INC.', null, 'MBT-S-9048',
    ])]).parsed
    expect(r.checkBook).toBe('MBT-A-9048')
  })

  it('leaves a genuine checkbook code alone', () => {
    const [r] = parseRows([row('BPI RELEASED', 5, [
      'PAID', null, '6000308584', null, 'ACME INC.', null, 'BPI-S-4636',
    ])]).parsed
    expect(r.checkBook).toBe('BPI-S-4636')
  })
})
