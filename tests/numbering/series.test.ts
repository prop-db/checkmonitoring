import { describe, it, expect } from 'vitest'
import { buildSeries, type SeriesCheque, type SeriesEntry } from '@/lib/numbering/series'

let seq = 0
function c(checkNumber: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque {
  seq += 1
  return { id: `id${String(seq).padStart(4, '0')}`, checkNumber, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP', status }
}
const shape = (entries: SeriesEntry[]) =>
  entries.map((e) => (e.kind === 'CHEQUE' ? e.cheque.checkNumber : `MISSING ${e.from}-${e.to} (${e.count})`))

describe('buildSeries', () => {
  it('a consecutive run has no MISSING line', () => {
    const s = buildSeries([c('103'), c('101'), c('102')])
    expect(shape(s.entries)).toEqual(['101', '102', '103'])
    expect(s.summary).toMatchObject({ first: '101', last: '103', held: 3, missingNumbers: '0', missingRuns: 0 })
  })

  it('one missing number is one line', () => {
    expect(shape(buildSeries([c('101'), c('103')]).entries)).toEqual(['101', 'MISSING 102-102 (1)', '103'])
  })

  it('a large gap is one line with the exact count, never one row per number', () => {
    const s = buildSeries([c('1791259553'), c('6000354350')])
    expect(shape(s.entries)).toEqual(['1791259553', 'MISSING 1791259554-6000354349 (4209094796)', '6000354350'])
    expect(s.summary.missingNumbers).toBe('4209094796')
    expect(s.summary.missingRuns).toBe(1)
  })

  it('gaps either side of a single cheque are two lines', () => {
    expect(shape(buildSeries([c('1'), c('5'), c('9')]).entries))
      .toEqual(['1', 'MISSING 2-4 (3)', '5', 'MISSING 6-8 (3)', '9'])
  })

  it('orders numerically, not as text', () => {
    expect(shape(buildSeries([c('1000'), c('999')]).entries)).toEqual(['999', '1000'])
  })

  it('shows both cheques on a duplicate number, flagged, counted once as held', () => {
    const s = buildSeries([c('7'), c('7'), c('8')])
    expect(s.entries.filter((e) => e.kind === 'CHEQUE' && e.duplicate)).toHaveLength(2)
    expect(s.summary).toMatchObject({ held: 2, duplicates: 2, missingNumbers: '0' })
  })

  it('keeps non-numeric numbers out of the sequence and lists them', () => {
    const s = buildSeries([c('AP-DG001931'), c('5'), c('6')])
    expect(shape(s.entries)).toEqual(['5', '6'])
    expect(s.notNumeric.map((x) => x.checkNumber)).toEqual(['AP-DG001931'])
    expect(s.summary.notNumeric).toBe(1)
  })

  it('counts VOIDED and CANCELLED across every cheque in the account', () => {
    const s = buildSeries([c('1', 'VOIDED'), c('2', 'CANCELLED'), c('3'), c('X', 'VOIDED')])
    expect(s.summary).toMatchObject({ voided: 2, cancelled: 1 })
  })

  it('keeps a leading-zero width on the MISSING bounds', () => {
    expect(shape(buildSeries([c('0098'), c('0101')]).entries)).toEqual(['0098', 'MISSING 0099-0100 (2)', '0101'])
  })

  it('a single cheque, and an empty account', () => {
    expect(buildSeries([c('42')]).summary).toMatchObject({ first: '42', last: '42', held: 1, missingRuns: 0 })
    expect(buildSeries([])).toEqual({
      entries: [], notNumeric: [],
      summary: { first: null, last: null, held: 0, voided: 0, cancelled: 0, missingNumbers: '0', missingRuns: 0, notNumeric: 0, duplicates: 0 },
    })
  })
})
