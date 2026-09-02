import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markSigned, markReadyForRelease, revertAvailability, markReleased,
  recordClearing, cancelCheck, applyPickupConfirmation,
} from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

const NOW = new Date('2026-09-01T13:32:00+08:00')
const PICKUP = new Date('2026-09-03')

beforeEach(resetDb)

describe('markSigned', () => {
  it('moves SIGNATURE_PENDING to SIGNED and records who and when', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const out = await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    expect(out.status).toBe('SIGNED')
    expect(out.signedById).toBe(user.id)
    expect(out.signedAt).toEqual(NOW)
  })

  it('writes an audit row', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    expect(audit.action).toBe('marked_signed')
    expect(audit.userId).toBe(user.id)
  })
})

describe('markReadyForRelease', () => {
  it('sets status, actor, timestamp and the availability date', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.readyById).toBe(user.id)
    expect(out.readyAt).toEqual(NOW)
    expect(out.availablePickupDate).toEqual(PICKUP)
  })

  it('queues a portal event for a SUPPLIER check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('OUT')
    expect(events[0].status).toBe('PENDING')
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('PENDING')
  })

  it('queues NO portal event for an INTERNAL check but still changes status', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    const out = await markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('refuses a check that is not SIGNED and leaves it untouched', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })).rejects.toMatchObject({ code: 'NOT_SIGNED' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('refuses when the availability date is missing', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: null, now: NOW,
    })).rejects.toMatchObject({ code: 'MISSING_FIELDS' })
  })
})

describe('revertAvailability', () => {
  it('returns the check to SIGNED, requires a reason, and never deletes it', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await revertAvailability(testDb, {
      checkId: check.id, userId: user.id,
      reason: 'Check temporarily unavailable due to operational circumstances.', now: NOW,
    })
    expect(out.status).toBe('SIGNED')
    expect(out.availablePickupDate).toBeNull()
    expect(await testDb.check.count({ where: { id: check.id } })).toBe(1)
    const audit = await testDb.auditLog.findFirst({
      where: { checkId: check.id, action: 'reverted_availability' },
    })
    expect(audit?.remarks).toContain('operational circumstances')
  })

  it('clears any supplier-confirmed pickup so no phantom schedule survives', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan', confirmedAt: NOW,
    })
    const out = await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    expect(out.status).toBe('SIGNED')
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
    expect(out.pickupRep).toBeNull()
  })

  it('rejects a blank reason', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await expect(revertAvailability(testDb, {
      checkId: check.id, userId: user.id, reason: '   ', now: NOW,
    })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
  })

  // Regression test for the bug: markReadyForRelease routes on eligibility,
  // but a seeded check can reach READY_FOR_RELEASE with portalSyncStatus still
  // at its schema default of NOT_APPLICABLE (the seed never set it). If revert
  // routed on portalSyncStatus instead of eligibility, this would emit no
  // retract event and leave the portal advertising a withdrawn check.
  it('emits a REVERT event for a SUPPLIER check even when portalSyncStatus was left at its default', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    // Reproduce the seeded shape: portalSyncStatus back at the schema default.
    await testDb.check.update({ where: { id: check.id }, data: { portalSyncStatus: 'NOT_APPLICABLE' } })

    await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events.some((e) => (e.payload as { action?: string }).action === 'REVERT')).toBe(true)
  })

  // Regression test for the other half of the bug: an INTERNAL check must
  // never produce a portal event. This used to be proved by forcing
  // portalSyncStatus to 'PENDING' on an INTERNAL check via testDb, but that
  // state is now unreachable: the database's own CHECK constraint
  // (check_internal_never_routes_to_portal) rejects it directly, which is a
  // stronger guarantee than the original test asserted.
  it('rejects an attempt to force an INTERNAL check into a portal-routed state', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })

    await expect(testDb.check.update({
      where: { id: check.id }, data: { portalSyncStatus: 'PENDING' },
    })).rejects.toThrow()
  })

  it('emits no event when reverting an INTERNAL check marked ready then reverted', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })

    await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })

    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })
})

describe('applyPickupConfirmation', () => {
  it('moves READY_FOR_RELEASE to SCHEDULED', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan Dela Cruz', confirmedAt: NOW,
    })
    expect(out.status).toBe('SCHEDULED')
    expect(out.scheduledPickupTime).toBe('10:00')
    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { checkId: check.id, action: 'supplier_pickup_confirmed' },
    })
    expect(audit.actorType).toBe('SYSTEM')
  })

  it('cannot mark a check RELEASED', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyPickupConfirmation(testDb, { checkId: check.id, pickupDate: PICKUP, confirmedAt: NOW })
    expect(out.status).toBe('SCHEDULED')
  })

  it('refuses to confirm against a check that is not available', async () => {
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, confirmedAt: NOW,
    })).rejects.toBeInstanceOf(DomainError)
  })
})

describe('markReleased', () => {
  it('releases directly from READY_FOR_RELEASE without a confirmed slot', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id, remarks: 'Picked up by supplier', now: NOW,
    })
    expect(out.status).toBe('RELEASED')
    expect(out.releasedById).toBe(user.id)
    expect(out.releasedAt).toEqual(NOW)
    expect(out.remarks).toBe('Picked up by supplier')
  })

  it('refuses to release a check that was never made available', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })

  it('queues a RELEASED portal event for a SUPPLIER check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', now: NOW })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    const released = events.find((e) => (e.payload as { action?: string }).action === 'RELEASED')
    expect(released).toBeDefined()
    expect(released?.direction).toBe('OUT')
    expect(released?.status).toBe('PENDING')
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('PENDING')
  })

  it('queues no portal event when releasing an INTERNAL check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })

    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('NOT_APPLICABLE')
  })
})

describe('recordClearing', () => {
  it('records DEPOSITED then CLEARED with a CR number', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const dep = await recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'DEPOSITED', now: NOW,
    })
    expect(dep.clearingStatus).toBe('DEPOSITED')
    const cleared = await recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'CLEARED',
      crNumber: 'CR 6336', clearedDate: new Date('2026-09-10'), now: NOW,
    })
    expect(cleared.clearingStatus).toBe('CLEARED')
    expect(cleared.crNumber).toBe('CR 6336')
  })

  it('refuses clearing before the check is released', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'DEPOSITED', now: NOW,
    })).rejects.toMatchObject({ code: 'ILLEGAL_CLEARING' })
  })
})

describe('cancelCheck', () => {
  it('cancels with a reason and keeps the record', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await cancelCheck(testDb, {
      checkId: check.id, userId: user.id, reason: 'Spoiled check', now: NOW,
    })
    expect(out.status).toBe('CANCELLED')
    expect(out.cancelReason).toBe('Spoiled check')
    expect(await testDb.check.count({ where: { id: check.id } })).toBe(1)
  })

  it('refuses to cancel an already released check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    await expect(cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })
})
