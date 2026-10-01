import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { findUnmatchableCancelled, closeUnmatchableCancelled, UNMATCHABLE_ERROR } from '@/lib/admin/unmatchable-cancelled'

const NOW = new Date('2026-10-01T10:00:00+08:00')

beforeEach(resetDb)

async function parked(checkId: string, kind: 'CANCELLED' | 'MARK_AVAILABLE' = 'CANCELLED', status: 'PARKED' | 'FAILED' = 'PARKED') {
  return testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind, status, attempts: 1, idempotencyKey: `${checkId}:${kind}:${Math.random()}`,
      payload: {}, lastError: 'cheque x has no APV numbers; the portal requires at least one',
    },
  })
}

describe('findUnmatchableCancelled', () => {
  it('selects only PARKED CANCELLED events whose cheque has no APV', async () => {
    const bare = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const withApv = await makeCheck({ status: 'VOIDED', apvNumbers: ['AP-1'] })
    const withBill = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: withBill.id, apvNumber: 'AP-2', amount: '1.00' } })
    const failing = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const otherKind = await makeCheck({ status: 'SIGNED', apvNumbers: [] })
    const target = await parked(bare.id)
    await parked(withApv.id); await parked(withBill.id)
    await parked(failing.id, 'CANCELLED', 'FAILED'); await parked(otherKind.id, 'MARK_AVAILABLE')

    const rows = await findUnmatchableCancelled(testDb)
    expect(rows.map((r) => r.eventId)).toEqual([target.id])
    expect(rows[0]).toMatchObject({ checkId: bare.id, checkNumber: bare.checkNumber, attempts: 1 })
  })
})

describe('closeUnmatchableCancelled', () => {
  it('closes unsent, sets the cheque NOT_APPLICABLE, and writes one audit row each', async () => {
    const check = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await testDb.check.update({ where: { id: check.id }, data: { portalSyncStatus: 'PENDING', portalDomain: 'LOCAL' } })
    const ev = await parked(check.id)
    const closed = await closeUnmatchableCancelled(testDb, await findUnmatchableCancelled(testDb), NOW)
    expect(closed).toBe(1)
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED')
    expect(after.lastError).toBe(UNMATCHABLE_ERROR)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalSyncStatus).toBe('NOT_APPLICABLE')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'portal_event_closed_unmatchable' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ eventId: ev.id, kind: 'CANCELLED', attempts: 1 })
  })

  it('is idempotent: a second run finds and closes nothing', async () => {
    const check = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await parked(check.id)
    await closeUnmatchableCancelled(testDb, await findUnmatchableCancelled(testDb), NOW)
    expect(await findUnmatchableCancelled(testDb)).toEqual([])
    expect(await testDb.auditLog.count({ where: { action: 'portal_event_closed_unmatchable' } })).toBe(1)
  })

  it('leaves a row that is no longer PARKED, or whose cheque gained an APV, untouched', async () => {
    const a = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const b = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const evA = await parked(a.id); const evB = await parked(b.id)
    const rows = await findUnmatchableCancelled(testDb)
    await testDb.portalEvent.update({ where: { id: evA.id }, data: { status: 'PENDING' } })
    await testDb.check.update({ where: { id: b.id }, data: { apvNumbers: ['AP-LATE'] } })
    expect(await closeUnmatchableCancelled(testDb, rows, NOW)).toBe(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evA.id } })).status).toBe('PENDING')
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evB.id } })).status).toBe('PARKED')
  })
})
