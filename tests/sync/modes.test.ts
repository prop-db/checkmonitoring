import { describe, it, expect } from 'vitest'
import { BILLS_MODE, BILL_REFS_MODE, NON_PAYMENT_MODES } from '@/lib/sync/modes'
import { BILLS_MODE as BILLS_MODE_FROM_BILLS } from '@/lib/sync/bills'

describe('sync modes', () => {
  it('lists every read that is not the payment feed', () => {
    expect(BILLS_MODE).toBe('BILLS')
    expect(BILL_REFS_MODE).toBe('BILL_REFS')
    expect([...NON_PAYMENT_MODES]).toEqual(['BILLS', 'BILL_REFS'])
    expect(BILLS_MODE_FROM_BILLS).toBe(BILLS_MODE)
  })
})
