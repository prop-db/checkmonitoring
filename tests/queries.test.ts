import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from './helpers/db'
import { makeCheck } from './helpers/factory'
import { getSummary, listChecks } from '@/lib/queries'
import { formatMoney } from '@/lib/money'

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
