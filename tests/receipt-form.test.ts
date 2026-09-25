import { describe, it, expect } from 'vitest'
import { readRowReceipts } from '@/lib/receipt-form'

const form = (entries: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of entries) f.append(k, v)
  return f
}

describe('readRowReceipts', () => {
  it('reads one receipt per keyed row and omits a blank box', () => {
    const r = readRowReceipts(form([
      ['orNumber:a', ' OR-000123 '], ['receiptType:a', 'OR'],
      ['orNumber:b', 'CR 88'], ['receiptType:b', 'CR'],
      ['orNumber:c', ''], ['receiptType:c', ''],
    ]), ['a', 'b', 'c'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...r.receipts]).toEqual([
      ['a', { orNumber: 'OR-000123', receiptType: 'OR' }],
      ['b', { orNumber: 'CR 88', receiptType: 'CR' }],
    ])
  })

  it('ignores a type chosen with no reference typed', () => {
    const r = readRowReceipts(form([['receiptType:a', 'OR']]), ['a'])
    expect(r.ok && r.receipts.size).toBe(0)
  })

  it('refuses a reference with no OR/CR, and nothing is read', () => {
    const r = readRowReceipts(form([['orNumber:a', '4471']]), ['a'])
    expect(r).toEqual({ ok: false, message: 'Choose OR or CR for every receipt reference you typed. Nothing was saved.' })
  })

  it('refuses a type that is neither OR nor CR', () => {
    expect(readRowReceipts(form([['orNumber:a', 'X'], ['receiptType:a', 'CRN']]), ['a']))
      .toEqual({ ok: false, message: 'Invalid receipt type.' })
  })

  it('refuses a receipt keyed to a cheque that is not ticked', () => {
    const r = readRowReceipts(form([['orNumber:z', 'OR-1'], ['receiptType:z', 'OR']]), ['a'])
    expect(r).toEqual({ ok: false, message: 'A receipt was sent for a cheque that is not ticked. Nothing was saved.' })
  })

  it('refuses the old single-box fields rather than silently dropping a typed receipt', () => {
    const r = readRowReceipts(form([['orNumber', 'OR-1'], ['receiptType', 'OR']]), ['a'])
    expect(r).toEqual({ ok: false, message: 'This page is out of date. Reload it and type the receipt in the row.' })
  })
})
