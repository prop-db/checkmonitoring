import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { cancelCheck, voidCheck, NO_APV_SKIP_REASON } from '@/lib/domain/actions'

const NOW = new Date('2026-09-26T10:00:00+08:00')

beforeEach(resetDb)

describe('CANCELLED portal event', () => {
  it('cancelCheck queues CANCELLED for a SUPPLIER cheque', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000001'] })
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
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'BROKER', apvNumbers: ['AP-ST000002'] })
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

  it('cancelCheck queues nothing for a routed cheque with no APV, and says so', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'spoiled', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(after.portalDomain).toBe('LOCAL')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toEqual({ portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON })
  })

  it('voidCheck queues nothing for a routed cheque with no APV, and says so', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'SUPPLIER', apvNumbers: [] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(after.portalDomain).toBe('LOCAL')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided' } })
    expect(audit.details).toMatchObject({ portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON })
  })

  it('voidCheck on a RELEASED routed cheque with no APV queues nothing and audits voided_after_release with the skip reason', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided_after_release' } })
    expect(audit.details).toMatchObject({ portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON })
  })

  it('a cheque with no apvNumbers but a bill still queues — the bill is an APV', async () => {
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: check.id, apvNumber: 'AP-ST000004', amount: '1.00' } })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(ev.kind).toBe('CANCELLED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided' } })
    expect(audit.details).toMatchObject({ portalNotified: true })
  })

  it('a routed cheque that queues records portalNotified: true', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000005'] })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'duplicate', now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toEqual({ portalNotified: true })
  })

  it('an INTERNAL cheque records no portal keys at all', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toBeNull()
  })
})
