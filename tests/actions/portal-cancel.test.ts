import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { cancelCheck, voidCheck } from '@/lib/domain/actions'

const NOW = new Date('2026-09-26T10:00:00+08:00')

beforeEach(resetDb)

describe('CANCELLED portal event', () => {
  it('cancelCheck queues CANCELLED for a SUPPLIER cheque', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'duplicate', now: NOW })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(ev.kind).toBe('CANCELLED')
    expect(ev.status).toBe('PENDING')
    expect(ev.idempotencyKey).toBe(`${check.id}:CANCELLED:${NOW.toISOString()}`)
    expect(ev.payload).toEqual({ action: 'CANCELLED', checkNumber: check.checkNumber })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('PENDING')
    expect(after.portalDomain).toBe('LOCAL')
  })

  it('voidCheck queues CANCELLED for a BROKER cheque, even after release', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'BROKER' })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(ev.kind).toBe('CANCELLED')
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalDomain).toBe('BROKER')
  })

  it('an INTERNAL cheque queues nothing', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
  })
})
