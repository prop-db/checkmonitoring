import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { getPortalOverview } from '@/lib/admin/portal-overview'

beforeEach(resetDb)

describe('getPortalOverview', () => {
  it('counts by status and lists parked and failed rows newest first', async () => {
    const check = await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL' })
    const mk = (status: 'PENDING' | 'SYNCED' | 'FAILED' | 'PARKED', key: string, createdAt: Date) =>
      testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status, idempotencyKey: key, payload: {}, createdAt, lastError: status === 'SYNCED' ? null : `e-${key}` } })
    await mk('PENDING', 'a', new Date('2026-09-01')); await mk('SYNCED', 'b', new Date('2026-09-02'))
    await mk('FAILED', 'c', new Date('2026-09-03')); await mk('PARKED', 'd', new Date('2026-09-04'))
    const o = await getPortalOverview(testDb)
    expect(o.counts).toMatchObject({ PENDING: 1, SYNCED: 1, FAILED: 1, PARKED: 1, IN_FLIGHT: 0 })
    expect(o.closed).toEqual({ delivered: 1, superseded: 0, stale: 0, unmatchable: 0 })
    expect(o.attention.map((r) => [r.status, r.lastError, r.checkNumber, r.payeeName])).toEqual([
      ['PARKED', 'e-d', check.checkNumber, 'HENKEL'], ['FAILED', 'e-c', check.checkNumber, 'HENKEL'],
    ])
  })

  it('does not count rows closed unsent (superseded or stale) as delivered (final review 2026-09-26)', async () => {
    const check = await makeCheck({ status: 'RELEASED' })
    const mk = (key: string, lastError: string | null) =>
      testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'SYNCED', idempotencyKey: key, payload: {}, lastError } })
    await mk('a', null); await mk('b', 'unmatched: AP-9'); await mk('c', 'superseded by x'); await mk('d', 'stale: check is now CANCELLED')
    await mk('e', 'unmatchable: no APV numbers')
    const o = await getPortalOverview(testDb)
    expect(o.counts.SYNCED).toBe(5)
    expect(o.closed).toEqual({ delivered: 2, superseded: 1, stale: 1, unmatchable: 1 })
  })
})
