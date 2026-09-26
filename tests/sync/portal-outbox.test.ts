import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { deliverPortalEvents, RETRY_DELAYS_MS, MAX_ATTEMPTS, UNMATCHED_MAX_ATTEMPTS } from '@/lib/sync/portal-outbox'
import type { PortalClient, PortalDeliveryResult, PortalEventBody } from '@/lib/integrations/portal/client'

const NOW = new Date('2026-09-26T10:00:00+08:00')
const LATER = new Date(NOW.getTime() + 60_000)

function fakeClient(reply: (body: PortalEventBody) => PortalDeliveryResult | Error): PortalClient & { sent: PortalEventBody[] } {
  const sent: PortalEventBody[] = []
  return {
    sent,
    async deliver(body) {
      sent.push(body)
      const r = reply(body)
      if (r instanceof Error) throw r
      return r
    },
  }
}

const ok = (over: Partial<NonNullable<PortalDeliveryResult['body']>> = {}): PortalDeliveryResult => ({
  status: 200,
  body: { eventId: 'x', replay: false, results: [{ ref: 'AP-1', domain: 'local', releaseId: 41, outcome: 'applied' }], unmatched: [], ...over },
})

async function queue(checkId: string, kind: 'MARK_AVAILABLE' | 'RELEASED' | 'REVERT' | 'RELEASE_REVERSED' | 'CANCELLED', createdAt: Date, extra: Record<string, unknown> = {}) {
  return testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind, status: 'PENDING', createdAt, nextAttemptAt: createdAt,
      idempotencyKey: `${checkId}:${kind}:${createdAt.toISOString()}`, payload: { action: kind },
      ...extra,
    },
  })
}

/**
 * A released cheque as the portal payload needs it: RELEASED requires a
 * releaseDate, and the factory leaves `releasedAt` null (a RELEASED event for
 * such a cheque parks as a payload defect - see the MISSING_DATE test).
 */
async function releasedCheck(apv: string) {
  const check = await makeCheck({ status: 'RELEASED', apvNumbers: [apv] })
  return testDb.check.update({ where: { id: check.id }, data: { releasedAt: NOW } })
}

beforeEach(resetDb)

describe('deliverPortalEvents', () => {
  it('delivers a pending event and marks it SYNCED, learning the portal id', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', apvNumbers: ['AP-1'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 1, synced: 1, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false })
    expect(client.sent[0]).toMatchObject({ eventId: ev.id, kind: 'MARK_AVAILABLE', apvs: ['AP-1'], availablePickupDate: '2026-09-30' })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED'); expect(after.attempts).toBe(1); expect(after.claimedBy).toBeTruthy()
    const chk = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(chk.portalSyncStatus).toBe('SYNCED'); expect(chk.portalTradeId).toBe(41)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_synced' } })).toBe(1)
  })

  it('latest wins per cheque: older non-terminal events are superseded, not sent', async () => {
    const check = await releasedCheck('AP-1')
    const old = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    const mid = await queue(check.id, 'REVERT', new Date('2026-08-02T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const newest = await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 1, superseded: 2 })
    expect(client.sent.map((b) => b.eventId)).toEqual([newest.id])
    for (const id of [old.id, mid.id]) {
      const e = await testDb.portalEvent.findUniqueOrThrow({ where: { id } })
      expect(e.status).toBe('SYNCED'); expect(e.lastError).toBe(`superseded by ${newest.id}`)
    }
  })

  it('a newest event not yet due is neither sent nor superseded; the cheque waits', async () => {
    const check = await releasedCheck('AP-1')
    await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 0, superseded: 0 })
    expect(client.sent).toHaveLength(0)
  })

  it('a refused result parks the event and flags the cheque', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok({ results: [{ ref: 'AP-1', domain: 'local', releaseId: 41, outcome: 'refused', reason: 'cancelled in the portal' }] }))
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ parked: 1 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.lastError).toMatch(/cancelled in the portal/)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalSyncStatus).toBe('FAILED')
  })

  it('nothing matched retries daily and parks after UNMATCHED_MAX_ATTEMPTS', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', apvNumbers: ['AP-9'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW, { attempts: UNMATCHED_MAX_ATTEMPTS - 2 })
    const client = fakeClient(() => ok({ results: [], unmatched: ['AP-9'] }))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.lastError).toMatch(/unmatched: AP-9/)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + 24 * 3_600_000)

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.attempts).toBe(UNMATCHED_MAX_ATTEMPTS)
  })

  it('a network error backs off along RETRY_DELAYS_MS and parks at MAX_ATTEMPTS', async () => {
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => new Error('ECONNRESET'))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.attempts).toBe(1); expect(after.lastError).toMatch(/ECONNRESET/)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + RETRY_DELAYS_MS[0])

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED')
  })

  it('401 and 400 park immediately; 503 retries', async () => {
    for (const [status, expected] of [[401, 'PARKED'], [400, 'PARKED'], [503, 'FAILED']] as const) {
      await resetDb()
      const check = await releasedCheck('AP-1')
      const ev = await queue(check.id, 'RELEASED', NOW)
      const client = fakeClient(() => ({ status, body: null }))
      await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
      expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe(expected)
    }
  })

  it('never sends an INTERNAL cheque: the event parks without a request', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-1'] })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('PARKED')
    // An INTERNAL cheque never carries portal state (DB constraint check_internal_never_routes_to_portal).
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalSyncStatus).toBe('NOT_APPLICABLE')
  })

  it('a payload missing its required date parks without a request (never retried)', async () => {
    // The factory leaves releasedAt null: the portal requires releaseDate on RELEASED.
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect(out).toMatchObject({ delivered: 0, parked: 1, failed: 0 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.lastError).toMatch(/releasedAt/)
  })

  it('stops at the deadline and leaves the rest PENDING', async () => {
    const a = await releasedCheck('AP-1')
    const b = await releasedCheck('AP-2')
    await queue(a.id, 'RELEASED', NOW); await queue(b.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() - 1), client })
    expect(out.stoppedAtDeadline).toBe(true); expect(out.delivered).toBe(0)
    expect(await testDb.portalEvent.count({ where: { status: 'PENDING' } })).toBe(2)
  })

  it('a stale IN_FLIGHT claim is retried, a fresh one is left alone', async () => {
    const check = await releasedCheck('AP-1')
    const stale = await queue(check.id, 'RELEASED', NOW, { status: 'IN_FLIGHT', claimedAt: new Date(LATER.getTime() - 3_600_000), claimedBy: 'dead-run' })
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('SYNCED')

    const other = await releasedCheck('AP-2')
    const fresh = await queue(other.id, 'RELEASED', NOW, { status: 'IN_FLIGHT', claimedAt: LATER, claimedBy: 'live-run' })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('IN_FLIGHT')
  })
})
