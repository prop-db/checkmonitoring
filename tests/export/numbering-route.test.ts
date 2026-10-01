// tests/export/numbering-route.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { NUMBERING_SUMMARY_SHEET } from '@/lib/export/numbering-workbook'

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: new Proxy(testDb, { get(t, p, r) { state.dbTouches += 1; return Reflect.get(t, p, r) } }) }
})

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }
async function get(url: string) {
  const { GET } = await import('@/app/api/export/numbering/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/numbering', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/numbering')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('serves an uncached file named cheque-numbering-<day>.xlsx', async () => {
    await makeCheck({ checkNumber: '1' })
    const res = await get('http://localhost/api/export/numbering')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/cheque-numbering-\d{4}-\d{2}-\d{2}\.xlsx/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('honours account: the file holds that account only', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    await makeCheck({ checkNumber: '2' })
    const res = await get(`http://localhost/api/export/numbering?account=${a.cashAccountId}`)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    expect(wb.worksheets.map((w) => w.name)).toHaveLength(2)
    expect(wb.worksheets[0].name).toBe(NUMBERING_SUMMARY_SHEET)
  })

  it('refuses an unknown account with 404 rather than widening to every account', async () => {
    await makeCheck({ checkNumber: '1' })
    const res = await get('http://localhost/api/export/numbering?account=nope')
    expect(res.status).toBe(404)
  })
})
