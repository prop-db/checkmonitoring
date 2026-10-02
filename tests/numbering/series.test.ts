import { describe, it, expect } from 'vitest'
import { buildSeries, stagedSeriesNumber, type SeriesCheque, type SeriesEntry, type SeriesStaged } from '@/lib/numbering/series'

let seq = 0
function c(checkNumber: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque {
  seq += 1
  return { id: `id${String(seq).padStart(4, '0')}`, checkNumber, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP', status }
}
const shape = (entries: SeriesEntry[]) =>
  entries.map((e) => (e.kind === 'CHEQUE' ? e.cheque.checkNumber
    : e.kind === 'STAGED' ? `STAGED ${e.number}`
    : `MISSING ${e.from}-${e.to} (${e.count})`))

const st = (statedCheckRef: string, acumaticaRef = `CV-${statedCheckRef}`): SeriesStaged =>
  ({ acumaticaTenant: 'GOLIVE', acumaticaRef, statedCheckRef, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP' })

describe('buildSeries', () => {
  it('staged rows with the same ref in different tenants both appear, in tenant order', () => {
    const s = buildSeries([c('100'), c('102')], [
      { ...st('101.', 'CV-ST1'), acumaticaTenant: 'MANUFACTURING' },
      { ...st('101.', 'CV-ST1'), acumaticaTenant: 'GOLIVE' },
    ])
    const staged = s.entries.flatMap((e) => (e.kind === 'STAGED' ? [e.staged.acumaticaTenant] : []))
    expect(staged).toEqual(['GOLIVE', 'MANUFACTURING'])
  })

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

  it('flags 007 and 7 in one account as duplicates, counted once as held', () => {
    const s = buildSeries([c('007'), c('7'), c('8')])
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
      summary: { first: null, last: null, held: 0, voided: 0, cancelled: 0, staged: 0, missingNumbers: '0', missingRuns: 0, notNumeric: 0, duplicates: 0 },
    })
  })
})

describe('stagedSeriesNumber', () => {
  it('reads a number that Acumatica re-used with trailing dots', () => {
    expect(stagedSeriesNumber('6000146879.')).toBe('6000146879')
    expect(stagedSeriesNumber('1791361883..')).toBe('1791361883')
    expect(stagedSeriesNumber(' 6000146879. ')).toBe('6000146879')
    expect(stagedSeriesNumber('BPI 6000146879.')).toBe('6000146879')
  })
  it('ignores anything else', () => {
    expect(stagedSeriesNumber('6000146879')).toBeNull()      // no dot: not a re-use
    expect(stagedSeriesNumber('PCF26-00001.')).toBeNull()    // not a number once the dots go
    expect(stagedSeriesNumber('AP-IND000469')).toBeNull()
    expect(stagedSeriesNumber('6000146879.5')).toBeNull()    // a dot inside is not a trailer
    expect(stagedSeriesNumber('.')).toBeNull()
    expect(stagedSeriesNumber(null)).toBeNull()
  })
})

describe('buildSeries with staged re-uses', () => {
  it('a number used only by a staged payment is STAGED, not MISSING', () => {
    const s = buildSeries([c('101'), c('104')], [st('102.')])
    expect(shape(s.entries)).toEqual(['101', 'STAGED 102', 'MISSING 103-103 (1)', '104'])
    expect(s.summary).toMatchObject({ held: 2, staged: 1, missingNumbers: '1', missingRuns: 1 })
  })

  it('a cheque and its dotted re-use: the cheque row first, never a duplicate', () => {
    const s = buildSeries([c('7')], [st('7.'), st('7..', 'CV-second')])
    expect(shape(s.entries)).toEqual(['7', 'STAGED 7', 'STAGED 7'])
    expect(s.summary).toMatchObject({ held: 1, staged: 2, duplicates: 0, missingNumbers: '0' })
    expect(s.entries[0]).toMatchObject({ kind: 'CHEQUE', duplicate: false })
  })

  it('a staged number extends the range', () => {
    const s = buildSeries([c('5')], [st('9.')])
    expect(shape(s.entries)).toEqual(['5', 'MISSING 6-8 (3)', 'STAGED 9'])
    expect(s.summary).toMatchObject({ first: '5', last: '9' })
  })

  it('an account with only staged numbers still has a series', () => {
    const s = buildSeries([], [st('20.'), st('22.')])
    expect(shape(s.entries)).toEqual(['STAGED 20', 'MISSING 21-21 (1)', 'STAGED 22'])
    expect(s.summary).toMatchObject({ first: '20', last: '22', held: 0, staged: 2 })
  })

  it('a staged row that does not qualify is ignored entirely', () => {
    const s = buildSeries([c('1'), c('3')], [st('PCF26-00001.'), st('2')])
    expect(shape(s.entries)).toEqual(['1', 'MISSING 2-2 (1)', '3'])
    expect(s.summary.staged).toBe(0)
  })
})
