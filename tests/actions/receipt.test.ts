import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markReadyForRelease, markReleased, recordReceipt, voidCheck,
} from '@/lib/domain/actions'

const NOW = new Date('2026-09-10T13:32:00+08:00')
const LATER = new Date('2026-09-11T09:05:00+08:00')
const PICKUP = new Date('2026-09-10')
const OR_DATE = new Date('2026-09-10T00:00:00Z')

beforeEach(resetDb)

/** A cheque standing at READY_FOR_RELEASE, the state the release form acts on. */
async function readyCheque(eligibility: 'SUPPLIER' | 'INTERNAL' = 'SUPPLIER') {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', eligibility })
  await markReadyForRelease(testDb, {
    checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
  })
  return { user, check }
}

const receiptRows = (checkId: string) =>
  testDb.auditLog.findMany({ where: { checkId, action: 'receipt_recorded' } })

describe('markReleased with a supplier receipt', () => {
  it('records the reference, the date and which kind of receipt it is', async () => {
    const { user, check } = await readyCheque()
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id,
      orNumber: 'OR-000123', orDate: OR_DATE, receiptType: 'OR', now: NOW,
    })
    expect(out.status).toBe('RELEASED')
    expect(out.orNumber).toBe('OR-000123')
    expect(out.orDate).toEqual(OR_DATE)
    expect(out.receiptType).toBe('OR')
  })

  it('records a Collection Receipt as CR', async () => {
    const { user, check } = await readyCheque()
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: '4471', receiptType: 'CR', now: NOW,
    })
    expect(out.receiptType).toBe('CR')
    expect(out.orNumber).toBe('4471')
  })

  /**
   * THE SPECIFIC MISTAKE THIS FEATURE HAD TO AVOID.
   *
   * `crNumber` is the BANK's clearing reference and lives beside
   * `clearingStatus`, recorded weeks after release when the cheque comes back
   * through the account. A supplier's Collection Receipt written there would
   * read to every report as evidence the money had cleared. Releasing a cheque
   * with a CR receipt must leave the clearing columns exactly as it found them.
   */
  it('never writes the supplier receipt into the bank clearing reference', async () => {
    const { user, check } = await readyCheque()
    await markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'CR 88', receiptType: 'CR', now: NOW,
    })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.crNumber).toBeNull()
    expect(after.clearingStatus).toBe('NONE')
    expect(after.clearedDate).toBeNull()
  })

  // The client's ruling, and what RELEASE ALL at the counter depends on.
  it('releases with the box empty', async () => {
    const { user, check } = await readyCheque()
    const out = await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    expect(out.status).toBe('RELEASED')
    expect(out.orNumber).toBeNull()
    expect(out.orDate).toBeNull()
    expect(out.receiptType).toBeNull()
    expect(await receiptRows(check.id)).toHaveLength(0)
  })

  it('refuses a reference with no type chosen, and releases nothing', async () => {
    const { user, check } = await readyCheque()
    await expect(markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-000123', now: NOW,
    })).rejects.toMatchObject({ code: 'RECEIPT_TYPE_REQUIRED' })

    // The whole action aborted: this is a guard, not a field that is skipped.
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.releasedAt).toBeNull()
    expect(after.orNumber).toBeNull()
  })

  it('does not store a type with no reference', async () => {
    const { user, check } = await readyCheque()
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: '   ', receiptType: 'OR', now: NOW,
    })
    expect(out.orNumber).toBeNull()
    expect(out.receiptType).toBeNull()
    expect(await receiptRows(check.id)).toHaveLength(0)
  })

  it('writes an audit row saying who recorded the receipt, and that it came with the release', async () => {
    const { user, check } = await readyCheque()
    await markReleased(testDb, {
      checkId: check.id, userId: user.id,
      orNumber: 'OR-000123', orDate: OR_DATE, receiptType: 'OR', now: NOW,
    })
    const rows = await receiptRows(check.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(user.id)
    expect(rows[0].actorType).toBe('USER')
    expect(rows[0].details).toMatchObject({
      orNumber: 'OR-000123',
      receiptType: 'OR',
      orDate: OR_DATE.toISOString(),
      withRelease: true,
    })
  })

  it('still writes the release audit row of its own', async () => {
    const { user, check } = await readyCheque()
    await markReleased(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: NOW,
    })
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'released' } })).toBe(1)
  })
})

describe('recordReceipt', () => {
  async function releasedCheque() {
    const { user, check } = await readyCheque()
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    return { user, check }
  }

  it('adds the receipt to a check already released without one', async () => {
    const { user, check } = await releasedCheque()
    const out = await recordReceipt(testDb, {
      checkId: check.id, userId: user.id,
      orNumber: 'OR-000123', orDate: OR_DATE, receiptType: 'OR', now: LATER,
    })
    expect(out.orNumber).toBe('OR-000123')
    expect(out.orDate).toEqual(OR_DATE)
    expect(out.receiptType).toBe('OR')
    // The release itself is untouched: this records a receipt, not a release.
    expect(out.status).toBe('RELEASED')
    expect(out.releasedAt).toEqual(NOW)
    expect(out.releasedById).toBe(user.id)
  })

  it('writes an audit row marked as added later', async () => {
    const { user, check } = await releasedCheque()
    await recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: '4471', receiptType: 'CR', now: LATER,
    })
    const rows = await receiptRows(check.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(user.id)
    expect(rows[0].details).toMatchObject({
      orNumber: '4471', receiptType: 'CR', withRelease: false,
    })
  })

  it('never writes the supplier receipt into the bank clearing reference', async () => {
    const { user, check } = await releasedCheque()
    await recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'CR 88', receiptType: 'CR', now: LATER,
    })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.crNumber).toBeNull()
    expect(after.clearingStatus).toBe('NONE')
  })

  it('refuses a check that has not been released', async () => {
    const { user, check } = await readyCheque()
    await expect(recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER,
    })).rejects.toMatchObject({ code: 'NOT_RELEASED' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.orNumber).toBeNull()
    expect(await receiptRows(check.id)).toHaveLength(0)
  })

  /**
   * A cheque voided after release still carries its release facts — `voidCheck`
   * leaves them standing deliberately, as the evidence the cheque was handed
   * over. The supplier's receipt for that hand-over is part of the same
   * evidence, so it can still be recorded.
   */
  it('accepts a check voided after it was released', async () => {
    const { user, check } = await releasedCheque()
    await voidCheck(testDb, { checkId: check.id, reason: 'Stop payment', now: LATER })
    const out = await recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-9', receiptType: 'OR', now: LATER,
    })
    expect(out.orNumber).toBe('OR-9')
    expect(out.status).toBe('VOIDED')
  })

  it('refuses a blank reference rather than clearing the box', async () => {
    const { user, check } = await releasedCheque()
    await expect(recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: '  ', receiptType: 'OR', now: LATER,
    })).rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' })
  })

  it('refuses a reference with no type chosen', async () => {
    const { user, check } = await releasedCheque()
    await expect(recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: null, now: LATER,
    })).rejects.toMatchObject({ code: 'RECEIPT_TYPE_REQUIRED' })
  })

  /**
   * This path adds a receipt that was missing; it does not amend one that was
   * recorded. Overwriting would replace a fact somebody entered against money
   * that has already moved, and the refusal names what is already there so the
   * person holding the paper can see whether it is the same receipt.
   */
  it('refuses to overwrite a receipt that is already recorded', async () => {
    const { user, check } = await releasedCheque()
    await recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-000123', receiptType: 'OR', now: LATER,
    })
    await expect(recordReceipt(testDb, {
      checkId: check.id, userId: user.id, orNumber: 'OR-999999', receiptType: 'OR', now: LATER,
    })).rejects.toMatchObject({ code: 'RECEIPT_ALREADY_RECORDED' })

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.orNumber).toBe('OR-000123')
    expect(await receiptRows(check.id)).toHaveLength(1)
  })

  it('refuses a check that does not exist', async () => {
    const user = await makeUser()
    await expect(recordReceipt(testDb, {
      checkId: 'nope', userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
