import { describe, it, expect } from 'vitest'
import {
  isCheckIncomplete, checkDeletable, UNDELETABLE_STATUSES,
} from '@/lib/domain/incomplete'
import type { CheckStatus } from '@/lib/domain/check-status'

// 129 of production's 9,247 imported cheques carry no amount: the register's
// amount cell was blank or held the word "CANCELLED" where a figure belongs,
// and Acumatica — reconciled against all 129 — has no record of any of them.
// They are genuine records (83 name a real payee), not junk, so they are
// flagged for review rather than hidden or deleted wholesale.
describe('isCheckIncomplete', () => {
  it('flags a cheque whose amount the register never recorded', () => {
    expect(isCheckIncomplete({ amount: null })).toBe(true)
  })

  it('does not flag a cheque that records an amount', () => {
    expect(isCheckIncomplete({ amount: '197715.42' })).toBe(false)
  })

  // A cheque genuinely drawn for nothing is a different fact from one whose
  // amount was never recorded, and the column already distinguishes them:
  // NULL means "not recorded", 0.00 means zero. Do not collapse the two here —
  // formatMoney, getSummary and the release guard all read them apart.
  it('does not flag a zero amount, which is a recorded figure', () => {
    expect(isCheckIncomplete({ amount: '0.00' })).toBe(false)
  })
})

const base = {
  actorRole: 'FINANCE_ADMIN' as const,
  amount: null,
  status: 'SIGNATURE_PENDING' as CheckStatus,
  releasedAt: null as Date | null,
}

describe('checkDeletable', () => {
  it('permits a Finance Admin to delete an incomplete cheque that never left the building', () => {
    expect(checkDeletable(base)).toEqual({ ok: true })
  })

  it('permits deletion of an incomplete CANCELLED cheque', () => {
    expect(checkDeletable({ ...base, status: 'CANCELLED' })).toEqual({ ok: true })
  })

  it('refuses a Finance User', () => {
    const result = checkDeletable({ ...base, actorRole: 'FINANCE_USER' })
    expect(result).toEqual({
      ok: false,
      code: 'NOT_ADMIN',
      message: 'Only a Finance Admin can delete a cheque record.',
    })
  })

  // The refusal that will disappoint the request: of the 129, 25 are RELEASED.
  // Deleting one erases the record of money that actually moved.
  it('refuses a RELEASED cheque even with no amount recorded', () => {
    const result = checkDeletable({ ...base, status: 'RELEASED' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('ALREADY_RELEASED')
  })

  // `releasedAt` is tested independently of `status`, not as a proxy for it: a
  // cheque later VOIDED after release still carries the release facts (see
  // voidCheck, which deliberately leaves them standing), and that is exactly
  // the cheque whose deletion would erase the evidence.
  it('refuses a cheque carrying a release timestamp whatever its status now says', () => {
    const result = checkDeletable({
      ...base, status: 'VOIDED', releasedAt: new Date('2026-02-06T04:00:00Z'),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('ALREADY_RELEASED')
  })

  // 6 of the 129 are READY_FOR_RELEASE. A supplier may already have been told
  // the cheque is waiting for them.
  it('refuses a READY_FOR_RELEASE cheque', () => {
    const result = checkDeletable({ ...base, status: 'READY_FOR_RELEASE' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('ANNOUNCED')
  })

  it('refuses a SCHEDULED cheque', () => {
    const result = checkDeletable({ ...base, status: 'SCHEDULED' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('ANNOUNCED')
  })

  it('refuses a cheque that records an amount', () => {
    const result = checkDeletable({ ...base, amount: '197715.42' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('AMOUNT_RECORDED')
  })

  // Order matters, and this pins it. A released cheque WITH an amount must be
  // refused as released, not as "it has an amount" — the second reads as an
  // invitation to blank the amount out and try again, which would turn a
  // safety rule into a two-step workaround.
  it('reports a released cheque as released rather than as one with an amount', () => {
    const result = checkDeletable({
      ...base, amount: '197715.42', status: 'RELEASED',
      releasedAt: new Date('2026-02-06T04:00:00Z'),
    })
    expect(result.ok === false && result.code).toBe('ALREADY_RELEASED')
  })

  // The list is exported so the UI and the report can name the same three
  // statuses the guard enforces, rather than restating them and drifting.
  it('names exactly the three statuses that block deletion', () => {
    expect([...UNDELETABLE_STATUSES].sort())
      .toEqual(['READY_FOR_RELEASE', 'RELEASED', 'SCHEDULED'])
  })
})
