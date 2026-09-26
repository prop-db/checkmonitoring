import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { summariseBacklog } from '@/lib/admin/portal-backlog'

beforeEach(resetDb)

describe('summariseBacklog', () => {
  it('applies latest-wins as a dry run and never carries an amount', async () => {
    const check = await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL' })
    const mk = (kind: 'MARK_AVAILABLE' | 'RELEASED', at: Date) =>
      testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind, status: 'PENDING', idempotencyKey: `${kind}${at.toISOString()}`, payload: {}, createdAt: at } })
    await mk('MARK_AVAILABLE', new Date('2026-09-05')); await mk('RELEASED', new Date('2026-09-06'))
    const s = await summariseBacklog(testDb)
    expect(s.total).toBe(2); expect(s.superseded).toBe(1)
    expect(s.winners).toEqual([expect.objectContaining({ kind: 'RELEASED', checkNumber: check.checkNumber, payeeName: 'HENKEL', checkStatus: 'RELEASED', eligibility: 'SUPPLIER' })])
    expect(s.byKind).toEqual({ MARK_AVAILABLE: 1, RELEASED: 1 })
    expect(JSON.stringify(s)).not.toMatch(/197715/)
  })
})
