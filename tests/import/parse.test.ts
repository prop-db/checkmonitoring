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
    // and the whole string competes to be the payee.
    const [r] = parseRows([row('BPI RELEASED', 7, [
      '6000308584',
      'PO-ST-027363 WEEKLY DIRECT (DISNEY) D2, D5, D7, D6 RESTDAY HOLIDAY FTP NOV. 30, 2025 (11 PAX)',
      'STARKSON PACKAGING INC.',
    ])]).parsed
    expect(r.poNumbers).toContain('PO-ST-027363')
    expect(r.unclassified.some((u) => u.startsWith('WEEKLY DIRECT'))).toBe(true)
    expect(r.unclassified.some((u) => u.startsWith('PO-ST-027363'))).toBe(false)
    expect(r.payee).toBe('STARKSON PACKAGING INC.')
  })

  it('takes the longest unclassified string as the payee', () => {
    // Payee and description are both free text; the description is longer.
    const [r] = parseRows([row('BPI RELEASED', 6, [
      '6000308622', 'Starkson Packaging Inc.',
      'PO-ST-027402 THRU PCF DISNEY - LABOR FEE FOR EXTENDED HOURS - DISNEY 7 R&D FTP DEC. 07, 2025 (1 PAX)',
    ])]).parsed
    expect(r.payee).toBe('Starkson Packaging Inc.')
  })

  it('reports a row with no check number for review rather than dropping it', () => {
    const { parsed, review } = parseRows([row('BPI RELEASED', 9, ['PAID', 'DEPOSITED'])])
    expect(parsed).toHaveLength(0)
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({ sheet: 'BPI RELEASED', row: 9, reason: 'NO_CHECK_NUMBER' })
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
