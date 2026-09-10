import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb, testDb } from '../helpers/db'

/**
 * The scheduled route's guard. `middleware.ts` DOES NOT RUN in this project, so
 * a route handler has no perimeter in front of it; this one authenticates
 * itself with a bearer secret on its first line, and an UNSET secret refuses
 * rather than opens. The database is reached through a Proxy that counts every
 * property touch, so "did nothing" is asserted as "never asked the database",
 * the same way tests/export/route.test.ts does it.
 */
const state = vi.hoisted(() => ({
  dbTouches: 0,
  requested: [] as string[],
  failFor: null as string | null,
}))

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return {
    prisma: new Proxy(testDb, {
      get(target, prop, receiver) {
        state.dbTouches += 1
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
})

vi.mock('@/lib/integrations/acumatica/from-env', () => ({
  createClientForTenant: (tenant: string) => {
    state.requested.push(tenant)
    if (state.failFor === tenant) throw new Error(`${tenant} cannot be built`)
    return { fetchAll: async () => [], fetchPage: async () => [] }
  },
}))

const SECRET = 'test-cron-secret'

async function get(authorization?: string) {
  const { GET } = await import('@/app/api/cron/sync/route')
  return GET(new Request('http://localhost/api/cron/sync', {
    headers: authorization ? { authorization } : {},
  }))
}

const watermarked = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
  testDb.syncRun.create({
    data: {
      mode: 'INCREMENTAL', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })

beforeEach(async () => {
  await resetDb()
  process.env.CRON_SECRET = SECRET
  state.dbTouches = 0
  state.requested = []
  state.failFor = null
})

describe('GET /api/cron/sync — the guard', () => {
  it('refuses with 500 and touches nothing when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    expect(state.dbTouches).toBe(0)
    expect(state.requested).toEqual([])
  })

  it('refuses a request with no bearer', async () => {
    const res = await get()
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('refuses the wrong bearer', async () => {
    const res = await get('Bearer not-the-secret')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
    expect(state.requested).toEqual([])
  })
})

describe('GET /api/cron/sync — the run', () => {
  it('reads both tenants, in order, as SCHEDULED', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.outcomes.map((o: { tenant: string; outcome: string }) => [o.tenant, o.outcome]))
      .toEqual([['GOLIVE', 'RAN'], ['MANUFACTURING', 'RAN']])
    expect(state.requested).toEqual(['GOLIVE', 'MANUFACTURING'])

    const scheduled = await testDb.syncRun.findMany({ where: { trigger: 'SCHEDULED' } })
    expect(scheduled.map((r) => r.tenant).sort()).toEqual(['GOLIVE', 'MANUFACTURING'])
  })

  it('still reads the second tenant when the first fails, and answers 500', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['FAILED', 'RAN'])
    expect(state.requested).toEqual(['GOLIVE', 'MANUFACTURING'])
  })

  it('answers 200 when a tenant merely had no watermark — the refusal is recorded, not a fault of the cron', async () => {
    await watermarked('GOLIVE')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'REFUSED_NO_WATERMARK'])
  })
})
