// tests/export/numbering-route.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb, testDb } from '../helpers/db'
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
/** A cheque in a cheque book of its own, under the cheque's company and bank. */
async function chequeInBook(checkNumber: string) {
  const c = await makeCheck({ checkNumber })
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const book = await testDb.checkBook.create({
    data: { code: `BPI-S-${Math.random().toString(36).slice(2, 6)}`, bankId: acc.bankId, companyId: c.companyId },
  })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
  return { cheque: c, book }
}

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
    await chequeInBook('1')
    const res = await get('http://localhost/api/export/numbering')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/cheque-numbering-\d{4}-\d{2}-\d{2}\.xlsx/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('honours account: the file holds that cheque book only', async () => {
    const a = await chequeInBook('1')
    await chequeInBook('2')
    const res = await get(`http://localhost/api/export/numbering?account=${a.book.id}`)
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    expect(wb.worksheets.map((w) => w.name)).toHaveLength(2)
    expect(wb.worksheets[0].name).toBe(NUMBERING_SUMMARY_SHEET)
    expect(wb.worksheets[1].name).toBe(a.book.code)
  })

  it('with a cheque book set, a company filter does not leak into the file description', async () => {
    const a = await chequeInBook('1')
    const b = await chequeInBook('2')
    expect(a.cheque.companyId).not.toBe(b.cheque.companyId)
    const res = await get(`http://localhost/api/export/numbering?company=${a.cheque.companyId}&account=${b.book.id}`)
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const a2 = String(wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getCell('A2').value)
    expect(a2).toContain('ACCOUNT:')
    expect(a2).not.toContain('COMPANY:')
  })

  it('refuses an unknown cheque book with 404 rather than widening to every cheque book', async () => {
    await chequeInBook('1')
    const res = await get('http://localhost/api/export/numbering?account=nope')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('UNKNOWN CHEQUE BOOK')
  })

  it('refuses a cash-account id with 404: the account parameter names a cheque book', async () => {
    const { cheque } = await chequeInBook('1')
    const res = await get(`http://localhost/api/export/numbering?account=${cheque.cashAccountId}`)
    expect(res.status).toBe(404)
  })
})
