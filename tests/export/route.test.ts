import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { REGISTER_SHEET, SUMMARY_SHEET, FIRST_DATA_ROW, HEADER_ROW } from '@/lib/export/workbook'

/**
 * The export route's guard.
 *
 * `middleware.ts` DOES NOT RUN in this project — Node-runtime middleware is
 * silently unregistered in Next 15.5.25 — so a route handler has no perimeter
 * in front of it whatsoever. This endpoint returns every cheque the group has
 * issued: payee, amount, bank, cheque number. If it does not authenticate
 * itself, nothing does.
 *
 * The database is reached through a Proxy that counts every property touch, so
 * "returned no data" is asserted as "never asked the database for any" rather
 * than as "the body happened to look empty".
 */
type SessionUser = { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }

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

const SIGNED_IN: SessionUser = {
  id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER',
}

async function get(url: string) {
  const { GET } = await import('@/app/api/export/route')
  return GET(new Request(url))
}

async function sheetsFrom(res: Response) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await res.arrayBuffer())
  return wb
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export — the guard', () => {
  it('refuses an unauthenticated request with 401', async () => {
    state.user = null
    const res = await get('http://localhost/api/export')
    expect(res.status).toBe(401)
  })

  // The assertion that matters: not merely "no workbook came back", but that
  // the request never reached the database at all.
  it('hands an unauthenticated caller no cheque data of any kind', async () => {
    await makeCheck({ payeeName: 'HENKEL PHILIPPINES INC.', checkNumber: '6000240287' })
    state.dbTouches = 0
    state.user = null

    const res = await get('http://localhost/api/export?scope=all')
    const body = await res.text()

    expect(state.dbTouches).toBe(0)
    expect(body).not.toContain('HENKEL')
    expect(body).not.toContain('6000240287')
    // A .xlsx is a zip; "PK" is its first two bytes. Nothing resembling a
    // workbook may leave here.
    expect(body.startsWith('PK')).toBe(false)
    expect(res.headers.get('content-type')).not.toContain('spreadsheetml')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('checks the session BEFORE it reads anything, not after', async () => {
    state.user = null
    await get('http://localhost/api/export?status=RELEASED&scope=all')
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export — the download', () => {
  it('answers a signed-in user with an .xlsx named for the view and the date', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE' })
    const res = await get('http://localhost/api/export?status=READY_FOR_RELEASE')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('attachment')
    expect(disposition).toMatch(/filename="check-register-ready-for-release-\d{4}-\d{2}-\d{2}\.xlsx"/)
    // Financial data must not sit in a proxy or a browser cache.
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('produces a workbook with both sheets and the cheque in it', async () => {
    const check = await makeCheck({ status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.' })
    const wb = await sheetsFrom(await get('http://localhost/api/export?status=SIGNED'))

    expect(wb.worksheets.map((w) => w.name)).toEqual([REGISTER_SHEET, SUMMARY_SHEET])
    const ws = wb.getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(HEADER_ROW).getCell(1).value).toBe('CHECK NUMBER')
    expect(ws.getRow(FIRST_DATA_ROW).getCell(1).value).toBe(check.checkNumber)
    expect(ws.getRow(FIRST_DATA_ROW).getCell(3).value).toBe('HENKEL PHILIPPINES INC.')
    expect(ws.getRow(FIRST_DATA_ROW).getCell(7).value).toBe(197715.42)
  })

  it('names the user who generated it', async () => {
    await makeCheck()
    const wb = await sheetsFrom(await get('http://localhost/api/export'))
    expect(String(wb.getWorksheet(REGISTER_SHEET)!.getCell('A4').value)).toContain('Paolo Parcon')
  })

  /**
   * The whole point of the feature: the file holds what the reader is looking
   * at. The route runs the SAME resolver the dashboard page runs, so this is
   * the check that the wiring is intact rather than a second filtering path.
   */
  it('exports exactly the filtered view, not the whole register', async () => {
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000000001' })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000002' })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000003' })

    const ws = (await sheetsFrom(await get('http://localhost/api/export?status=READY_FOR_RELEASE')))
      .getWorksheet(REGISTER_SHEET)!

    const numbers: string[] = []
    for (let r = FIRST_DATA_ROW; r <= FIRST_DATA_ROW + 5; r++) {
      const v = ws.getRow(r).getCell(1).value
      if (typeof v === 'string' && /^\d/.test(v)) numbers.push(v)
    }
    expect(numbers).toEqual([ready.checkNumber])
    expect(ws.getCell('A2').value).toBe('READY FOR RELEASE — 1 CHEQUE')
  })

  it('carries a search term into the file and says so in the title block', async () => {
    await makeCheck({ status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ status: 'SIGNED', payeeName: 'SHELL PILIPINAS CORP.' })

    const ws = (await sheetsFrom(await get('http://localhost/api/export?q=henkel')))
      .getWorksheet(REGISTER_SHEET)!

    expect(ws.getCell('A3').value).toBe('SEARCH: "henkel"')
    expect(ws.getRow(FIRST_DATA_ROW).getCell(3).value).toBe('HENKEL PHILIPPINES INC.')
    expect(ws.getRow(FIRST_DATA_ROW + 1).getCell(3).value).toBeNull()
  })

  it('opens on the NEEDS ACTION view when no parameters are given, like the dashboard', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })
    const ws = (await sheetsFrom(await get('http://localhost/api/export')))
      .getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A2').value).toBe('NEEDS ACTION — 1 CHEQUE')
  })

  // A hand-edited or stale bookmarked link must produce an unfiltered export,
  // never a 500 from Prisma being handed an invalid enum value.
  it('ignores an unrecognised parameter rather than failing', async () => {
    await makeCheck({ status: 'SIGNED' })
    const res = await get('http://localhost/api/export?status=DELETED&company=nope&eligibility=MAYBE')
    expect(res.status).toBe(200)
    const ws = (await sheetsFrom(res)).getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A2').value).toBe('NEEDS ACTION — 1 CHEQUE')
    expect(ws.getCell('A3').value).toBe('No filters applied')
  })

  it('leaves a cheque with no recorded amount blank, all the way through the route', async () => {
    await makeCheck({ status: 'SIGNED', amount: null })
    const ws = (await sheetsFrom(await get('http://localhost/api/export?status=SIGNED')))
      .getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(FIRST_DATA_ROW).getCell(7).value).toBeNull()
  })

  it('writes the system-wide figures onto the SUMMARY sheet', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })
    const ws = (await sheetsFrom(await get('http://localhost/api/export?status=SIGNED')))
      .getWorksheet(SUMMARY_SHEET)!

    const found = new Map<string, unknown>()
    ws.eachRow((r) => {
      const label = r.getCell(1).value
      if (typeof label === 'string') found.set(label, r.getCell(2).value)
    })
    // Two cheques exist; the register sheet holds only the one SIGNED cheque.
    // The summary counts both, exactly as the dashboard cards do.
    expect(found.get('TOTAL CHEQUES')).toBe(2)
    expect(found.get('RELEASED')).toBe(1)
  })

  it('still returns a readable workbook when nothing matches', async () => {
    const res = await get('http://localhost/api/export?status=SCHEDULED')
    expect(res.status).toBe(200)
    const ws = (await sheetsFrom(res)).getWorksheet(REGISTER_SHEET)!
    expect(ws.getCell('A2').value).toBe('SCHEDULED — NO CHEQUES MATCH')
  })
})
