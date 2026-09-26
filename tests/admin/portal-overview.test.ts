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
    expect(o.attention.map((r) => [r.status, r.lastError, r.checkNumber, r.payeeName])).toEqual([
      ['PARKED', 'e-d', check.checkNumber, 'HENKEL'], ['FAILED', 'e-c', check.checkNumber, 'HENKEL'],
    ])
  })
})
