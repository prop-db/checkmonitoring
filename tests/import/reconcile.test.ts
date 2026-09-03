import { describe, it, expect } from 'vitest'
import { reconcile } from '@/lib/import/reconcile'
import type { ParsedRow } from '@/lib/import/parse'

const TODAY = new Date('2026-09-03T00:00:00Z')

const mk = (over: Partial<ParsedRow>): ParsedRow => ({
  sheet: 'S', row: 1, checkNumber: '6000000001', cvNumber: null, apvNumbers: [], poNumbers: [],
  checkBook: null, category: null, clearingRef: null, checkDate: null, amount: null,
  payee: null, unclassified: [], ...over,
})

describe('duplicates across sheets', () => {
  it('reports one cheque appearing on two sheets, naming both', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'CANCELLED', row: 9 }),
    ], { today: TODAY })
    const dup = conflicts.find((c) => c.kind === 'DUPLICATE_ACROSS_SHEETS')
    expect(dup).toBeDefined()
    expect(dup!.rows).toEqual([
      { sheet: 'BPI RELEASED', row: 5 }, { sheet: 'CANCELLED', row: 9 },
    ])
  })

  it('does not treat the same cheque twice on one sheet as a cross-sheet duplicate', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'BPI RELEASED', row: 6 }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'DUPLICATE_ACROSS_SHEETS')).toHaveLength(0)
  })

  it('does not report a cheque that appears once', () => {
    expect(reconcile([mk({})], { today: TODAY }).conflicts).toHaveLength(0)
  })
})

describe('contradictory status', () => {
  it('reports a cheque the register says is both released and cancelled', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'CANCELLED', row: 9 }),
    ], { today: TODAY })
    const c = conflicts.find((x) => x.kind === 'CONTRADICTORY_STATUS')
    expect(c).toBeDefined()
    expect(c!.detail).toContain('RELEASED')
    expect(c!.detail).toContain('CANCELLED')
  })

  it('does not report two sheets that agree', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'MBTC RELEASED', row: 9 }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'CONTRADICTORY_STATUS')).toHaveLength(0)
  })
})

describe('amount mismatch', () => {
  it('reports the same cheque carrying two different amounts', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'A', row: 2, amount: '7950.00' }),
      mk({ sheet: 'B', row: 3, amount: '8950.00' }),
    ], { today: TODAY })
    const c = conflicts.find((x) => x.kind === 'AMOUNT_MISMATCH')
    expect(c).toBeDefined()
    expect(c!.detail).toContain('7950.00')
    expect(c!.detail).toContain('8950.00')
  })

  it('treats trailing-zero differences as the same amount', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'A', row: 2, amount: '7950' }),
      mk({ sheet: 'B', row: 3, amount: '7950.00' }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'AMOUNT_MISMATCH')).toHaveLength(0)
  })

  it('ignores a missing amount rather than calling it a mismatch', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'A', row: 2, amount: '7950.00' }),
      mk({ sheet: 'B', row: 3, amount: null }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'AMOUNT_MISMATCH')).toHaveLength(0)
  })
})

describe('implausible dates', () => {
  it('flags a cheque dated more than a year ahead', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 4, checkDate: new Date('2028-11-18T00:00:00Z') }),
    ], { today: TODAY })
    const c = conflicts.find((x) => x.kind === 'IMPLAUSIBLE_DATE')
    expect(c).toBeDefined()
    expect(c!.detail).toContain('2028-11-18')
  })

  it('does not flag an ordinary post-dated cheque', () => {
    const { conflicts } = reconcile([
      mk({ checkDate: new Date('2026-11-18T00:00:00Z') }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'IMPLAUSIBLE_DATE')).toHaveLength(0)
  })

  it('does not flag a missing date', () => {
    expect(reconcile([mk({ checkDate: null })], { today: TODAY }).conflicts).toHaveLength(0)
  })
})

describe('vendor merges', () => {
  it('groups spelling variants without choosing between them', () => {
    const { vendorMerges } = reconcile([
      mk({ checkNumber: '1', payee: 'STARKSON PACKAGING INC.' }),
      mk({ checkNumber: '2', payee: 'Starkson Packaging Inc.' }),
      mk({ checkNumber: '3', payee: 'HENKEL PHILIPPINES INC.' }),
    ], { today: TODAY })
    const merged = vendorMerges.find((m) => m.variants.length > 1)
    expect(merged!.variants.slice().sort()).toEqual(['STARKSON PACKAGING INC.', 'Starkson Packaging Inc.'])
    expect(vendorMerges.find((m) => m.variants.includes('HENKEL PHILIPPINES INC.'))!.variants).toHaveLength(1)
  })

  it('lists a repeated payee once', () => {
    const { vendorMerges } = reconcile([
      mk({ checkNumber: '1', payee: 'ACME' }),
      mk({ checkNumber: '2', payee: 'ACME' }),
    ], { today: TODAY })
    expect(vendorMerges).toHaveLength(1)
    expect(vendorMerges[0].variants).toEqual(['ACME'])
  })
})

describe('purity', () => {
  it('never mutates or reorders its input', () => {
    const rows = [mk({ sheet: 'A', row: 1 }), mk({ sheet: 'B', row: 2 })]
    const before = JSON.stringify(rows)
    reconcile(rows, { today: TODAY })
    expect(JSON.stringify(rows)).toBe(before)
  })
})
