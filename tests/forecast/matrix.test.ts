import { describe, it, expect } from 'vitest'
import { buildMatrices, NO_BANK } from '@/lib/forecast/matrix'
import type { ForecastRow } from '@/lib/forecast/query'

const TODAY = new Date('2026-09-16T02:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 8, 16 - n))

function row(o: Partial<ForecastRow> & { id: string }): ForecastRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', bank: 'BPI', company: 'STK',
    stage: 'SIGNED', currency: 'PHP', amount: '100.00', checkDate: daysAgo(3),
    ...o,
  }
}

describe('buildMatrices', () => {
  it('adds in centavos, never in floats', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' }),
    ], TODAY)
    const cell = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!.cells.BPI
    expect(cell.count).toBe(2)
    expect(cell.totals).toEqual([{ currency: 'PHP', count: 2, total: '0.30' }])
  })

  it('never sums two currencies together', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '100.00', currency: 'PHP' }),
      row({ id: 'b', amount: '5.00', currency: 'USD' }),
    ], TODAY)
    const cell = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!.cells.BPI
    expect(cell.count).toBe(2)
    expect(cell.totals).toEqual([
      { currency: 'PHP', count: 1, total: '100.00' }, { currency: 'USD', count: 1, total: '5.00' },
    ])
  })

  it('counts each currency on its own, apart from the cell\'s whole count', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '100.00', currency: 'PHP' }),
      row({ id: 'b', amount: '5.00', currency: 'USD' }),
    ], TODAY)
    const cell = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!.cells.BPI
    expect(cell.count).toBe(2)
    expect(cell.totals.find((t) => t.currency === 'PHP')!.count).toBe(1)
    expect(cell.totals.find((t) => t.currency === 'USD')!.count).toBe(1)
  })

  it('has a column per bank present, NO BANK last, and an empty cell where a bank has nothing in a bucket', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', bank: 'MBTC' }),
      row({ id: 'b', bank: null, checkDate: daysAgo(40) }),
      row({ id: 'c', bank: 'BPI', checkDate: daysAgo(40) }),
    ], TODAY)
    expect(byBank.columns).toEqual(['BPI', 'MBTC', NO_BANK])
    const week = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!
    expect(week.cells.BPI).toEqual({ count: 0, totals: [] })
    expect(week.cells.MBTC.count).toBe(1)
    const month = byBank.rows.find((r) => r.bucket === '31–60 DAYS')!
    expect(month.cells[NO_BANK].count).toBe(1)
    expect(month.total.count).toBe(2)
  })

  it('carries every bucket row, in order, even when empty', () => {
    const { byBank } = buildMatrices([row({ id: 'a' })], TODAY)
    expect(byBank.rows.map((r) => r.bucket)[0]).toBe('OVER 90 DAYS')
    expect(byBank.rows).toHaveLength(10)
  })

  it('totals the column and the grand total', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '1.00' }), row({ id: 'b', amount: '2.00', checkDate: daysAgo(100) }),
    ], TODAY)
    expect(byBank.total.cells.BPI).toEqual({ count: 2, totals: [{ currency: 'PHP', count: 2, total: '3.00' }] })
    expect(byBank.total.total).toEqual({ count: 2, totals: [{ currency: 'PHP', count: 2, total: '3.00' }] })
  })

  it('splits by stage in ladder order, only the stages present', () => {
    const { byStage } = buildMatrices([
      row({ id: 'a', stage: 'READY_FOR_RELEASE' }), row({ id: 'b', stage: 'SIGNATURE_PENDING' }),
    ], TODAY)
    expect(byStage.columns).toEqual(['SIGNATURE PENDING', 'READY FOR RELEASE'])
  })

  it('returns every row bucketed, with its days, for the detail sheet', () => {
    const { bucketed } = buildMatrices([row({ id: 'a', checkDate: daysAgo(45) }), row({ id: 'b', checkDate: null })], TODAY)
    expect(bucketed.map((r) => [r.bucket, r.days])).toEqual([['31–60 DAYS', 45], ['NO DATE', null]])
  })
})
