import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { markReleased } from '@/lib/domain/actions'

const NOW = new Date('2026-09-25T10:00:00+08:00')

beforeEach(resetDb)

/**
 * `markReleased` must never wipe or replace a receipt that is already on
 * record — the exact hazard rule 11 exists to prevent, arriving here instead
 * of through `recordReceipt`. See the comment on `markReleased` in
 * `lib/domain/actions.ts`.
 */
describe('markReleased keeps a receipt already on record', () => {
  async function readyChequeWithReceipt() {
    const user = await makeUser()
    const check = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const withReceipt = await testDb.check.update({
      where: { id: check.id },
      data: { orNumber: 'CR 6336', receiptType: 'CR' },
    })
    return { user, check: withReceipt }
  }

  it('releasing with no receipt typed leaves the recorded one untouched', async () => {
    const { user, check } = await readyChequeWithReceipt()
    const out = await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    expect(out.status).toBe('RELEASED')
    expect(out.orNumber).toBe('CR 6336')
    expect(out.receiptType).toBe('CR')
    expect(out.crNumber).toBeNull()

    // The queued portal payload must carry the RECORDED receipt, not this
    // release's own empty box — otherwise a future portal delivery (Plan 3)
    // would be told to wipe a receipt this release never touched. The
    // fixture's default eligibility ('SUPPLIER', from `makeCheck`) routes to
    // the LOCAL portal, so a RELEASED event is queued.
    const event = await testDb.portalEvent.findFirstOrThrow({
      where: { checkId: check.id, kind: 'RELEASED' },
    })
    expect(event.payload).toMatchObject({ orNumber: 'CR 6336' })
  })

  it('releasing with a receipt typed against an already-recorded one is refused, and nothing changes', async () => {
    const { user, check } = await readyChequeWithReceipt()
    await expect(markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-999', receiptType: 'OR', now: NOW,
    })).rejects.toMatchObject({ code: 'RECEIPT_ALREADY_RECORDED' })

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.orNumber).toBe('CR 6336')
    expect(after.receiptType).toBe('CR')
    expect(after.releasedAt).toBeNull()
  })

  it('releasing a cheque with no receipt yet still records one typed at release (regression)', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-000123', receiptType: 'OR', now: NOW,
    })
    expect(out.status).toBe('RELEASED')
    expect(out.orNumber).toBe('OR-000123')
    expect(out.receiptType).toBe('OR')
  })
})
