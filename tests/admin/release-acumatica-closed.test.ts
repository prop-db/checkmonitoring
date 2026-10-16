import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  findClosedStillLive, releaseClosedStillLive, RELEASED_FROM_CLOSED_ACTION,
} from '@/lib/admin/release-acumatica-closed'

const NOW = new Date('2026-10-16T15:00:00+08:00')

beforeEach(resetDb)

let seq = 0
async function acumaticaCheck(
  status: 'SIGNED' | 'READY_FOR_RELEASE' | 'SCHEDULED' | 'RELEASED' | 'SIGNATURE_PENDING' | 'CANCELLED',
  acumaticaStatus: string | null,
  extra: { acumaticaDocType?: string; amount?: string | null; isCheque?: boolean; apvNumbers?: string[]; eligibility?: 'SUPPLIER' | 'INTERNAL' } = {},
) {
  const c = await makeCheck({
    status, amount: extra.amount, isCheque: extra.isCheque, eligibility: extra.eligibility,
    apvNumbers: extra.apvNumbers ?? ['AP-ST000001'],
  })
  seq += 1
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: `CV-R${String(seq).padStart(6, '0')}`, acumaticaTenant: 'GOLIVE',
      acumaticaStatus, acumaticaDocType: extra.acumaticaDocType ?? 'Payment',
    },
  })
}

async function announce(checkId: string) {
  await testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind: 'MARK_AVAILABLE', status: 'SYNCED',
      idempotencyKey: `${checkId}:MARK_AVAILABLE:test`, payload: {}, nextAttemptAt: NOW,
    },
  })
}

describe('findClosedStillLive', () => {
  it('is SIGNED or READY FOR RELEASE real checks with an amount that Acumatica holds Closed, nothing else', async () => {
    const signed = await acumaticaCheck('SIGNED', 'Closed')
    const ready = await acumaticaCheck('READY_FOR_RELEASE', 'Closed')
    await acumaticaCheck('SIGNED', 'Balanced')
    await acumaticaCheck('SIGNED', null)
    await acumaticaCheck('SCHEDULED', 'Closed')
    await acumaticaCheck('RELEASED', 'Closed')
    await acumaticaCheck('SIGNATURE_PENDING', 'Closed')
    await acumaticaCheck('CANCELLED', 'Closed')
    await acumaticaCheck('SIGNED', 'Closed', { isCheque: false })
    await acumaticaCheck('SIGNED', 'Closed', { amount: null })
    await acumaticaCheck('SIGNED', 'Closed', { acumaticaDocType: 'Voided Payment' })

    const rows = await findClosedStillLive(testDb)
    expect(rows.map((r) => r.id).sort()).toEqual([signed.id, ready.id].sort())
  })

  it('never takes a payment the live feed shows with a void', async () => {
    const keep = await acumaticaCheck('SIGNED', 'Closed')
    const pendingVoid = await acumaticaCheck('SIGNED', 'Closed')
    const rows = await findClosedStillLive(testDb, new Set([pendingVoid.acumaticaPaymentId!]))
    expect(rows.map((r) => r.id)).toEqual([keep.id])
  })

  it('tells the portal only about a routed check with an APV that it was told was available', async () => {
    const announced = await acumaticaCheck('READY_FOR_RELEASE', 'Closed')
    await announce(announced.id)
    const neverAnnounced = await acumaticaCheck('SIGNED', 'Closed')
    const internal = await acumaticaCheck('READY_FOR_RELEASE', 'Closed', { eligibility: 'INTERNAL' })
    await announce(internal.id)
    const noApv = await acumaticaCheck('READY_FOR_RELEASE', 'Closed', { apvNumbers: [] })
    await announce(noApv.id)

    const byId = new Map((await findClosedStillLive(testDb)).map((r) => [r.id, r]))
    expect(byId.get(announced.id)).toMatchObject({ announced: true, tellPortal: true })
    expect(byId.get(neverAnnounced.id)).toMatchObject({ announced: false, tellPortal: false })
    expect(byId.get(internal.id)?.tellPortal).toBe(false)
    expect(byId.get(noApv.id)?.tellPortal).toBe(false)
  })
})

describe('releaseClosedStillLive', () => {
  it('moves each to RELEASED, status only, with one audit row, and queues RELEASED only where the portal was told', async () => {
    const ready = await acumaticaCheck('READY_FOR_RELEASE', 'Closed', { amount: '26767200.00' })
    await announce(ready.id)
    const signed = await acumaticaCheck('SIGNED', 'Closed')

    const res = await releaseClosedStillLive(testDb, await findClosedStillLive(testDb), NOW)
    expect(res).toEqual({ released: 2, portalQueued: 1 })

    const r = await testDb.check.findUniqueOrThrow({ where: { id: ready.id } })
    expect(r).toMatchObject({ status: 'RELEASED', releasedAt: null, releasedById: null, portalSyncStatus: 'PENDING', portalDomain: 'LOCAL' })
    const s = await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })
    expect(s).toMatchObject({ status: 'RELEASED', releasedAt: null, releasedById: null })

    const events = await testDb.portalEvent.findMany({ where: { kind: 'RELEASED' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ checkId: ready.id, status: 'PENDING', direction: 'OUT' })
    expect(events[0].nextAttemptAt.getTime()).toBe(NOW.getTime())

    const audits = await testDb.auditLog.findMany({ where: { action: RELEASED_FROM_CLOSED_ACTION }, orderBy: { checkId: 'asc' } })
    expect(audits).toHaveLength(2)
    const readyAudit = audits.find((a) => a.checkId === ready.id)!
    expect(readyAudit.actorType).toBe('SYSTEM')
    expect(readyAudit.details).toMatchObject({
      from: 'READY_FOR_RELEASE', to: 'RELEASED', acumaticaStatus: 'Closed', amount: '26767200', portalNotified: true,
    })
    expect(audits.find((a) => a.checkId === signed.id)!.details).toMatchObject({ from: 'SIGNED', portalNotified: false })
  })

  it('skips a check whose status moved since it was listed, and a re-run changes nothing', async () => {
    const a = await acumaticaCheck('SIGNED', 'Closed')
    const b = await acumaticaCheck('SIGNED', 'Closed')
    const listed = await findClosedStillLive(testDb)
    await testDb.check.update({ where: { id: b.id }, data: { status: 'CANCELLED' } })

    expect(await releaseClosedStillLive(testDb, listed, NOW)).toEqual({ released: 1, portalQueued: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CANCELLED')

    expect(await releaseClosedStillLive(testDb, listed, NOW)).toEqual({ released: 0, portalQueued: 0 })
    expect(await testDb.auditLog.count({ where: { action: RELEASED_FROM_CLOSED_ACTION } })).toBe(1)
  })
})
