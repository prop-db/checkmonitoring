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
