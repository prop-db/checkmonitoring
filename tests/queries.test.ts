import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from './helpers/db'
import { makeCheck } from './helpers/factory'
import { getSummary, listChecks, countChecks, toTableRow } from '@/lib/queries'
import { formatMoney } from '@/lib/money'
import { LIVE_STATUSES, isLiveStatus } from '@/lib/domain/check-status'

beforeEach(resetDb)

describe('getSummary', () => {
  it('counts each status and totals by currency for non-cancelled checks', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'SCHEDULED' })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'CANCELLED' })

    const s = await getSummary(testDb)
    expect(s.pendingSignature).toBe(1)
    expect(s.signed).toBe(1)
    expect(s.readyForRelease).toBe(1)
    expect(s.scheduled).toBe(1)
    expect(s.released).toBe(1)
    expect(s.total).toBe(6)
    // 5 non-cancelled checks (the CANCELLED one excluded) at 197715.42 each, all PHP.
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '988577.1', count: 5 }])
  })

  // The whole point of this step: a dataset spanning multiple currencies must
  // never collapse into one number. Two currencies in means two totals out.
  it('never adds two different currencies together', async () => {
    await makeCheck({ currency: 'PHP', amount: '1000.00' })
    await makeCheck({ currency: 'PHP', amount: '500.50' })
    await makeCheck({ currency: 'CNY', amount: '2000.25' })

    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toHaveLength(2)
    expect(s.totalsByCurrency).toEqual(expect.arrayContaining([
      { currency: 'PHP', total: '1500.5', count: 2 },
      { currency: 'CNY', total: '2000.25', count: 1 },
    ]))
  })

  it('excludes CANCELLED checks from every currency total', async () => {
    await makeCheck({ currency: 'CNY', amount: '999.00', status: 'CANCELLED' })
    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toEqual([])
  })

  // 397 register rows carry no amount. This pins the behaviour the dashboard
  // depends on: SQL SUM() skips NULL rather than reading it as 0, so the total
  // is the sum of the amounts that are actually known - while COUNT(*) still
  // counts the cheque, because it exists and Finance must be able to see it.
  //
  // A total of 1,500.50 over a count of 3 therefore does NOT mean the three
  // amounts add to 1,500.50. That is deliberate: the alternative is a total
  // that silently absorbs 397 unknowns as zeroes and looks authoritative.
  it('leaves a cheque with no recorded amount out of the total but still counts it', async () => {
    await makeCheck({ currency: 'PHP', amount: '1000.00' })
    await makeCheck({ currency: 'PHP', amount: '500.50' })
    await makeCheck({ currency: 'PHP', amount: null })

    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '1500.5', count: 3 }])
    expect(s.total).toBe(3)
  })

  // The degenerate case: every cheque in a currency has an unknown amount, so
  // Postgres returns SUM() = NULL for the whole group.
  //
  // The total is carried through as null, NOT collapsed to zero. "No amount is
  // known for any of these cheques" and "these cheques are worth nothing" are
  // different facts, and a figure reading ₱0.00 while meaning the first is a
  // lie the reader has no way to detect. `formatMoney` renders null as an em
  // dash, so the card shows a dash rather than a confident zero.
  //
  // The row must still appear with its count — dropping it would hide the
  // cheques entirely.
  it('reports a currency whose every amount is unknown with no total, not a zero', async () => {
    await makeCheck({ currency: 'USD', amount: null })
    await makeCheck({ currency: 'USD', amount: null })

    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toEqual([{ currency: 'USD', total: null, count: 2 }])
    expect(formatMoney(s.totalsByCurrency[0].total, 'USD')).toBe('—')
  })
})

describe('listChecks', () => {
  it('finds a check by its number', async () => {
    await makeCheck({ checkNumber: '6000329924' })
    await makeCheck({ checkNumber: '1791379619' })
    const rows = await listChecks(testDb, { q: '6000329' })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000329924')
  })

  it('finds a check by payee, case-insensitively', async () => {
    await makeCheck({})
    const rows = await listChecks(testDb, { q: 'henkel' })
    expect(rows).toHaveLength(1)
  })

  it('filters by status', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })
    const rows = await listChecks(testDb, { status: 'RELEASED' })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('RELEASED')
  })

  it('filters by eligibility so INTERNAL checks can be reviewed separately', async () => {
    await makeCheck({ eligibility: 'INTERNAL' })
    await makeCheck({ eligibility: 'SUPPLIER' })
    const rows = await listChecks(testDb, { eligibility: 'INTERNAL' })
    expect(rows).toHaveLength(1)
  })

  it('returns an empty list rather than throwing when nothing matches', async () => {
    expect(await listChecks(testDb, { q: 'no-such-check' })).toEqual([])
  })
})

// 129 of production's 9,247 cheques carry no amount, and until now nothing on
// any screen said so. `Check.isIncomplete` is the stored flag; these pin that
// it is counted, filterable, and — crucially — that flagging them changed
// nothing about the money.
describe('incomplete cheques', () => {
  it('counts the cheques flagged incomplete', async () => {
    await makeCheck({ amount: '1000.00' })
    await makeCheck({ amount: null })
    await makeCheck({ amount: null })

    const s = await getSummary(testDb)
    expect(s.incomplete).toBe(2)
    expect(s.total).toBe(3)
  })

  it('filters the table down to the incomplete records', async () => {
    await makeCheck({ amount: '1000.00', checkNumber: '6000000101' })
    await makeCheck({ amount: null, checkNumber: '6000000102' })

    const rows = await listChecks(testDb, { incomplete: true })
    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000102'])
  })

  it('leaves the filter off entirely when it is not asked for', async () => {
    await makeCheck({ amount: '1000.00' })
    await makeCheck({ amount: null })
    expect(await countChecks(testDb, {})).toBe(2)
    expect(await countChecks(testDb, { incomplete: true })).toBe(1)
  })

  // THE ONE THAT MUST NOT BE "FIXED". Flagging a cheque as incomplete does not
  // enrol it in any total: SQL SUM() skips a NULL amount, so the PHP total
  // below is 1,000.00 over a count of 2. A future reader who "corrects" this by
  // coalescing the null to zero would leave the figure looking identical while
  // meaning something else — a total that silently absorbs 129 unknowns as
  // zeroes and reads as authoritative. See getSummary for the full note.
  it('keeps an incomplete cheque out of the currency total while still counting it', async () => {
    await makeCheck({ currency: 'PHP', amount: '1000.00' })
    await makeCheck({ currency: 'PHP', amount: null })

    const s = await getSummary(testDb)
    expect(s.incomplete).toBe(1)
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '1000', count: 2 }])
  })
})

// The dashboard defaults to the cheques that still need Finance. Production
// holds 9,287 of which 7,433 are RELEASED and 531 CANCELLED, so a default of
// "everything" hides the ~400 that matter behind the row limit.
describe('statusIn (the dashboard scope)', () => {
  it('narrows to the live statuses and excludes the closed ones', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'CANCELLED' })

    const rows = await listChecks(testDb, { statusIn: LIVE_STATUSES })

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => isLiveStatus(r.status))).toBe(true)
    expect(await countChecks(testDb, { statusIn: LIVE_STATUSES })).toBe(2)
  })

  it('lets an explicitly chosen status win, so RELEASED is still reachable', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })

    const rows = await listChecks(testDb, { status: 'RELEASED', statusIn: LIVE_STATUSES })

    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('RELEASED')
  })

  it('treats an empty scope as no filter rather than as "match nothing"', async () => {
    await makeCheck({ status: 'RELEASED' })
    expect(await listChecks(testDb, { statusIn: [] })).toHaveLength(1)
  })

  it('narrows alongside the search rather than widening past it', async () => {
    await makeCheck({ status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ status: 'SIGNED', payeeName: 'OTHER SUPPLIER' })

    const rows = await listChecks(testDb, { q: 'henkel', statusIn: LIVE_STATUSES })

    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('SIGNED')
  })
})

// The table is a client component, and `Prisma.Decimal` cannot cross that
// boundary — React refuses to serialise a class instance. `toTableRow` is the
// conversion, and rule 8 decides its shape: the amount travels as a decimal
// string, never as a JS number.
describe('toTableRow', () => {
  it('carries the amount as a decimal string, not a number', async () => {
    await makeCheck({ amount: '197715.42' })
    const [row] = await listChecks(testDb, {})

    const table = toTableRow(row)

    expect(table.amount).toBe('197715.42')
    expect(typeof table.amount).toBe('string')
  })

  it('keeps a missing amount as null rather than zero', async () => {
    await makeCheck({ amount: null })
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).amount).toBeNull()
  })

  it('is JSON-serialisable, so it can be passed to a client component', async () => {
    await makeCheck({})
    const [row] = await listChecks(testDb, {})

    const table = toTableRow(row)

    // A Decimal survives JSON.stringify as a bare string and would pass a
    // shallow check; the property that matters is that nothing here is a class
    // instance. Every value is a primitive, a Date, or an array of strings.
    for (const value of Object.values(table)) {
      const plain = value === null
        || ['string', 'number', 'boolean'].includes(typeof value)
        || value instanceof Date
        || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      expect(plain).toBe(true)
    }
  })

  it('lists every bill’s APV, not just the first', async () => {
    const check = await makeCheck({})
    await testDb.checkBill.createMany({
      data: [
        { checkId: check.id, apvNumber: 'APV-1', amount: '1.00' },
        { checkId: check.id, apvNumber: 'APV-2', amount: '2.00' },
      ],
    })
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).apvNumbers).toEqual(['APV-1', 'APV-2'])
  })
})
