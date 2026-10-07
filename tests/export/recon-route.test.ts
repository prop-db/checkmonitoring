import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { RECON_DETAIL_SHEET } from '@/lib/export/recon-workbook'

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
  const { GET } = await import('@/app/api/export/recon/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/recon', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/recon')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('serves a file named by the as-of day, never cached', async () => {
    await makeCheck({ status: 'RELEASED' })
    const res = await get('http://localhost/api/export/recon?asOf=2026-08-31')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('outstanding-checks-2026-08-31.xlsx')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('applies the as-of day — the file is the view', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: '1', checkDate: new Date('2026-08-20') })
    await makeCheck({ status: 'RELEASED', checkNumber: '2', checkDate: new Date('2026-09-05') })
    const res = await get('http://localhost/api/export/recon?asOf=2026-08-31')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet(RECON_DETAIL_SHEET)!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(1).value).toBe('1')
  })
})
