import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { kickPortalDelivery, afterResponse } from '@/lib/sync/portal-kick'

beforeEach(async () => { await resetDb(); delete process.env.PORTAL_BASE_URL; delete process.env.PORTAL_TOKEN })

describe('kickPortalDelivery', () => {
  it('skips, naming the setting, when the portal is not configured', async () => {
    expect(await kickPortalDelivery(testDb, { budgetMs: 1000 })).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })

  it('delivers with an injected client and never throws', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    // The factory leaves releasedAt null; a RELEASED event with no releasedAt
    // is parked, not delivered (tests/sync/portal-outbox.test.ts:40-45). Set
    // it so this test actually reaches the injected client.
    await testDb.check.update({ where: { id: check.id }, data: { releasedAt: new Date() } })
    await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'PENDING', idempotencyKey: 'k', payload: {} } })
    const out = await kickPortalDelivery(testDb, {
      budgetMs: 1000,
      client: { deliver: async () => { throw new Error('boom') } },
    })
    expect(out).toMatchObject({ delivered: 1, failed: 1 })
  })
})

describe('afterResponse', () => {
  it('forwards fn to afterImpl - inside a "request" the scheduled fn runs and delivers', async () => {
    let captured: (() => Promise<unknown>) | undefined
    afterResponse(
      () => kickPortalDelivery(testDb, { budgetMs: 1000 }),
      (fn) => { captured = fn },
    )
    expect(captured).toBeInstanceOf(Function)
    // The fake afterImpl only recorded fn - a real `after` would run it once
    // the response is sent. Invoking it here stands in for that and proves
    // kickPortalDelivery actually ran (skip result, since unconfigured).
    await expect(captured!()).resolves.toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })

  it('swallows "called outside a request scope" and never invokes fn', () => {
    let called = false
    const fn = async () => { called = true }
    const afterImpl = () => {
      throw new Error('`after` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context')
    }
    expect(() => afterResponse(fn, afterImpl)).not.toThrow()
    expect(called).toBe(false)
  })

  it('rethrows any other error from afterImpl', () => {
    const afterImpl = () => { throw new Error('boom') }
    expect(() => afterResponse(() => Promise.resolve(), afterImpl)).toThrow('boom')
  })
})
