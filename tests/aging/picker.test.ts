import { describe, it, expect } from 'vitest'
import { agingColumns, agingValue, stripTotals, inBucket, selectionTotal } from '@/lib/aging-picker'
import type { AgingRow } from '@/lib/aging/query'

const row = (o: Partial<AgingRow>): AgingRow => ({
  id: 'x', checkNumber: '6000000001', cvNumber: 'CV-1', apvNumbers: ['AP-1'], poNumbers: ['PO-1'],
  payee: 'HENKEL', company: 'STK', bank: 'BPI-S-4636', checkDate: '2026-09-01', dueDate: '2026-10-01',
  daysPastDue: 14, bucket: 'b30', amount: '1000.10', currency: 'PHP', ...o,
})

const ROWS = [
  row({ id: 'a', bucket: 'current', amount: '0.10', daysPastDue: -3 }),
  row({ id: 'b', bucket: 'b30', amount: '1000.25' }),
  row({ id: 'c', bucket: 'b90plus', amount: '2000.65', daysPastDue: 120 }),
  row({ id: 'd', bucket: 'noDue', amount: '5.00', dueDate: null, daysPastDue: null }),
  row({ id: 'e', bucket: 'b30', amount: '99.00', currency: 'USD' }),
]

describe('stripTotals — centavo-exact, PHP only', () => {
  it('counts every bucket, OVERDUE and ALL', () => {
    const t = stripTotals(ROWS)
    expect(t.buckets.current).toEqual({ count: 1, amount: '0.10' })
    expect(t.buckets.b30).toEqual({ count: 1, amount: '1,000.25' })
    expect(t.buckets.b60).toEqual({ count: 0, amount: '0.00' })
    expect(t.buckets.b90plus).toEqual({ count: 1, amount: '2,000.65' })
    expect(t.buckets.noDue).toEqual({ count: 1, amount: '5.00' })
    expect(t.overdue).toEqual({ count: 2, amount: '3,000.90' })
    expect(t.all).toEqual({ count: 4, amount: '3,006.00' })
    expect(t.nonPhp).toBe(1)
  })
})

describe('inBucket', () => {
  it('ALL, OVERDUE and one bucket', () => {
    expect(inBucket(ROWS, 'ALL').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(inBucket(ROWS, 'OVERDUE').map((r) => r.id)).toEqual(['b', 'c', 'e'])
    expect(inBucket(ROWS, 'noDue').map((r) => r.id)).toEqual(['d'])
  })
})

describe('selectionTotal', () => {
  it('sums the selected PHP rows', () => {
    expect(selectionTotal(ROWS, new Set(['b', 'c']))).toEqual({ count: 2, amount: '3,000.90' })
  })
})

describe('agingColumns / agingValue', () => {
  it('has the spec\'s columns in order, with dropdowns for company, bank and bucket', () => {
    const cols = agingColumns(['STK'], ['BPI-S-4636'])
    expect(cols.map((c) => c.key)).toEqual([
      'checkNumber', 'cvNumber', 'apvNumbers', 'poNumbers', 'payee', 'company', 'bank',
      'checkDate', 'dueDate', 'daysPastDue', 'bucket', 'amount',
    ])
    expect(cols.find((c) => c.key === 'bucket')!.kind).toBe('enum')
    expect(cols.find((c) => c.key === 'company')!.options).toEqual([{ value: 'STK', label: 'STK' }])
  })

  it('reads values as the kit sorts and filters them', () => {
    const r = row({ apvNumbers: ['AP-1', 'AP-2'] })
    expect(agingValue(r, 'apvNumbers')).toBe('AP-1, AP-2')
    expect(agingValue(r, 'daysPastDue')).toBe('14')
    expect(agingValue(r, 'bucket')).toBe('b30')
    expect(agingValue(row({ daysPastDue: null }), 'daysPastDue')).toBeNull()
  })
})
