import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { DETAIL_SHEET } from '@/lib/export/forecast-workbook'

/**
 * The route's guard. `middleware.ts` runs on Vercel but this route is NOT on
 * the public list, and it must not rely on the middleware either way: it
 * authenticates itself on its first line. The counting Proxy asserts an
 * unauthenticated request never touches the database.
 */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))

vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))

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

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }

async function get(url: string) {
  const { GET } = await import('@/app/api/export/forecast/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/forecast — the guard', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/forecast')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export/forecast — the file', () => {
  it('serves a dated filename, never cached', async () => {
    await makeCheck({ status: 'SIGNED' })
    const res = await get('http://localhost/api/export/forecast')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="cash-outflow-\d{4}-\d{2}-\d{2}\.xlsx"/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('honours the stage filter — the file is the view', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '2' })
    const res = await get('http://localhost/api/export/forecast?stage=READY_FOR_RELEASE')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet(DETAIL_SHEET)!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(2).value).toBe('2') // column 1 is KIND since 2026-09-12
  })
})
