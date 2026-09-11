import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb, testDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { writeAudit } from '@/lib/audit'

/**
 * Guarded like every export: `getSessionUser()` first, 401 not a redirect —
 * and, because the page is admin-only, a FINANCE_USER is refused too. The
 * counting Proxy proves a refused request never asks the database for anything.
 */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: new Proxy(testDb, { get(t, p, r) { state.dbTouches += 1; return Reflect.get(t, p, r) } }) }
})

async function get(url: string) {
  const { GET } = await import('@/app/api/export/audit/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = { id: 'u1', email: 'a@rcl.test', name: 'Admin', role: 'FINANCE_ADMIN' }
  state.dbTouches = 0
})

describe('GET /api/export/audit — the guard', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/audit')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('refuses a FINANCE_USER with 401 and touches nothing', async () => {
    state.user = { id: 'u2', email: 'f@rcl.test', name: 'Finance', role: 'FINANCE_USER' }
    const res = await get('http://localhost/api/export/audit')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export/audit — the file', () => {
  it('serves the filtered range under a dated filename, never cached', async () => {
    const u = await makeUser()
    await writeAudit(testDb, { action: 'released', actorType: 'USER', userId: u.id })
    await writeAudit(testDb, { action: 'imported', actorType: 'SYSTEM' })
    const res = await get('http://localhost/api/export/audit')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="audit-\d{4}-\d{2}-\d{2}\.xlsx"/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
