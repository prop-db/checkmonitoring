import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { VOUCHER_INDEX_SHEET, VOUCHER_FIRST_DATA_ROW } from '@/lib/export/voucher-index'

/**
 * The route's guard. `middleware.ts` DOES NOT RUN in this project, so a route
 * handler has no perimeter in front of it. The database is reached through a
 * Proxy that counts every property touch, so "returned no data" can be
 * asserted as "never asked the database for any".
 */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))

vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => state.user,
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

const SIGNED_IN = {
  id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER',
}

async function get() {
  const { GET } = await import('@/app/api/export/vouchers/route')
  return GET(new Request('http://localhost/api/export/vouchers'))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/vouchers — the guard', () => {
  it('refuses an unauthenticated request with 401, not a redirect', async () => {
    state.user = null
    const res = await get()
    expect(res.status).toBe(401)
  })

  it('never touches the database when unauthenticated', async () => {
    state.user = null
    await get()
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export/vouchers — the file', () => {
  it('serves the fixed filename an external VLOOKUP depends on', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="CHECK BY VOUCHER.xlsx"',
    )
  })

  it('is never cached — it is a register of real cheques', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const res = await get()
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('writes the resolved voucher onto the sheet', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'], checkNumber: '6000353106' })
    const res = await get()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(1).value).toBe('AP-ST042652')
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(2).value).toBe('6000353106')
  })
})
