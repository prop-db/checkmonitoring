import { describe, it, expect } from 'vitest'
import { checkReleaseReversible, RECEIPT_ON_RECORD_MESSAGE, CLEARED_MESSAGE } from '@/lib/domain/reversal'

/**
 * Pure. The two refusals, pinned with literals. Both the domain action and the
 * detail page read this one function, so the page cannot offer a button the
 * action would refuse.
 */
const clean = { orNumber: null, receiptType: null, clearingStatus: 'NONE', crNumber: null, clearedDate: null }

describe('checkReleaseReversible', () => {
  it('allows a cheque with no receipt and no clearing', () => {
    expect(checkReleaseReversible(clean)).toEqual({ ok: true })
  })

  it('refuses when a receipt is on record — by number or by type', () => {
    expect(checkReleaseReversible({ ...clean, orNumber: 'OR-000123' }))
      .toEqual({ ok: false, code: 'RECEIPT_ON_RECORD', message: RECEIPT_ON_RECORD_MESSAGE })
    expect(checkReleaseReversible({ ...clean, receiptType: 'CR' }).ok).toBe(false)
  })

  it('refuses when the bank has cleared it — by status, reference or date', () => {
    expect(checkReleaseReversible({ ...clean, clearingStatus: 'CLEARED' }))
      .toEqual({ ok: false, code: 'CLEARED', message: CLEARED_MESSAGE })
    expect(checkReleaseReversible({ ...clean, clearingStatus: 'DEPOSITED' }).ok).toBe(false)
    expect(checkReleaseReversible({ ...clean, crNumber: 'BNK-9' }).ok).toBe(false)
    expect(checkReleaseReversible({ ...clean, clearedDate: new Date('2026-09-01') }).ok).toBe(false)
  })

  it('reports the receipt before the clearing when both apply', () => {
    const r = checkReleaseReversible({ ...clean, orNumber: 'OR-1', clearingStatus: 'CLEARED' })
    expect(r.ok === false && r.code).toBe('RECEIPT_ON_RECORD')
  })
})
