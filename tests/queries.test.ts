import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from './helpers/db'
import { makeCheck } from './helpers/factory'
import {
  getSummary, getTodaysRelease, listChecks, countChecks, toTableRow, getFilterOptions,
  parseStatusParam, parseEligibilityParam, parseOptionId,
} from '@/lib/queries'
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

// Postgres sorts NULLs FIRST on a descending sort. `checkDate` is nullable —
// 38 live cheques carry no date — so the dashboard's default ordering opened on
// a screen of nothing but em dashes with every dated cheque pushed below them.
// The fix is `nulls: 'last'`, and this is what stops it coming back: a plain
// `{ checkDate: 'desc' }` fails the first test here.
describe('listChecks ordering', () => {
  it('puts a cheque with no date after every dated one, newest dated first', async () => {
    await makeCheck({ checkNumber: '6000000901', checkDate: null })
    await makeCheck({ checkNumber: '6000000902', checkDate: new Date('2026-01-15') })
    await makeCheck({ checkNumber: '6000000903', checkDate: new Date('2026-08-20') })

    const rows = await listChecks(testDb, {})

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000903', '6000000902', '6000000901'])
  })

  it('still breaks a tie on the check number, ascending', async () => {
    await makeCheck({ checkNumber: '6000000905', checkDate: new Date('2026-03-01') })
    await makeCheck({ checkNumber: '6000000904', checkDate: new Date('2026-03-01') })

    const rows = await listChecks(testDb, {})

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000904', '6000000905'])
  })

  it('orders a table made entirely of dateless cheques rather than dropping them', async () => {
    await makeCheck({ checkNumber: '6000000907', checkDate: null })
    await makeCheck({ checkNumber: '6000000906', checkDate: null })

    const rows = await listChecks(testDb, {})

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000906', '6000000907'])
  })
})

// The BANK column. `Check.cashAccountId` -> `CashAccount` (the code Finance
// actually says out loud, "BPI STK") -> `Bank`. Both cross to the browser as
// plain strings: a Prisma model instance on `CheckTableRow` would throw at the
// server/client boundary, which has happened on this table before.
describe('toTableRow bank columns', () => {
  it('carries the cash account code and its bank code as plain strings', async () => {
    const check = await makeCheck({})
    const account = await testDb.cashAccount.findUniqueOrThrow({
      where: { id: check.cashAccountId! },
      include: { bank: true },
    })

    const [row] = await listChecks(testDb, {})
    const table = toTableRow(row)

    expect(table.cashAccountCode).toBe(account.code)
    expect(table.bankCode).toBe(account.bank.code)
    expect(typeof table.cashAccountCode).toBe('string')
    expect(typeof table.bankCode).toBe('string')
  })

  it('reports null, not an empty string, for a cheque with no cash account', async () => {
    const check = await makeCheck({})
    await testDb.check.update({ where: { id: check.id }, data: { cashAccountId: null } })

    const [row] = await listChecks(testDb, {})
    const table = toTableRow(row)

    expect(table.cashAccountCode).toBeNull()
    expect(table.bankCode).toBeNull()
  })

  it('stays JSON-serialisable with the bank columns on it', async () => {
    await makeCheck({})
    const [row] = await listChecks(testDb, {})

    for (const value of Object.values(toTableRow(row))) {
      const plain = value === null
        || ['string', 'number', 'boolean'].includes(typeof value)
        || value instanceof Date
        || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      expect(plain).toBe(true)
    }
  })
})

// The dropdown options come from the database, so a new company or cash account
// appears on the filter bar without a code change.
describe('getFilterOptions', () => {
  it('lists every company and cash account, ordered by code', async () => {
    const bank = await testDb.bank.create({ data: { code: 'ZBPI', name: 'Bank of the Philippine Islands' } })
    const a = await testDb.company.create({ data: { code: 'ZSTK', name: 'Company A', legalNames: [] } })
    const b = await testDb.company.create({ data: { code: 'ZA1', name: 'Company B', legalNames: [] } })
    await testDb.cashAccount.create({ data: { code: 'ZBPI STK', bankId: bank.id, companyId: a.id } })
    await testDb.cashAccount.create({ data: { code: 'ZBPI A1', bankId: bank.id, companyId: b.id } })

    const options = await getFilterOptions(testDb)

    expect(options.companies.map((c) => c.code)).toEqual(['ZA1', 'ZSTK'])
    expect(options.cashAccounts.map((c) => c.code)).toEqual(['ZBPI A1', 'ZBPI STK'])
    expect(options.cashAccounts.every((c) => c.bankCode === 'ZBPI')).toBe(true)
  })

  it('returns empty lists rather than throwing on an empty database', async () => {
    expect(await getFilterOptions(testDb)).toEqual({ companies: [], cashAccounts: [] })
  })

  it('is JSON-serialisable, so the filter bar can be rendered from it', async () => {
    const bank = await testDb.bank.create({ data: { code: 'ZMBTC', name: 'Metrobank' } })
    const company = await testDb.company.create({ data: { code: 'ZPP', name: 'Company C', legalNames: [] } })
    await testDb.cashAccount.create({ data: { code: 'ZMBTC PP', bankId: bank.id, companyId: company.id } })

    const options = await getFilterOptions(testDb)

    for (const record of [...options.companies, ...options.cashAccounts]) {
      for (const value of Object.values(record)) {
        expect(typeof value).toBe('string')
      }
    }
  })
})

// Every URL parameter is validated before it reaches Prisma. An unrecognised
// value is not an error page and not a guess — it is IGNORED, exactly as
// `status` already behaved, because a stale bookmark must open the dashboard
// rather than 500 it.
describe('URL parameter validation', () => {
  it('accepts every status on the ladder, including the closed ones', () => {
    for (const s of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
      'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(parseStatusParam(s)).toBe(s)
    }
  })

  it('ignores an unrecognised, empty or absent status rather than passing it to Prisma', () => {
    expect(parseStatusParam('DROP TABLE')).toBeUndefined()
    // Case matters: the enum is upper case and Prisma would reject 'released'.
    expect(parseStatusParam('released')).toBeUndefined()
    expect(parseStatusParam('')).toBeUndefined()
    expect(parseStatusParam(undefined)).toBeUndefined()
  })

  it('accepts the three eligibilities and ignores anything else', () => {
    expect(parseEligibilityParam('SUPPLIER')).toBe('SUPPLIER')
    expect(parseEligibilityParam('BROKER')).toBe('BROKER')
    expect(parseEligibilityParam('INTERNAL')).toBe('INTERNAL')
    expect(parseEligibilityParam('SUPPLIERS')).toBeUndefined()
    expect(parseEligibilityParam('')).toBeUndefined()
    expect(parseEligibilityParam(undefined)).toBeUndefined()
  })

  // A company or account id is checked against the rows actually loaded from
  // the database. A hand-typed id, or one for a record since removed, drops the
  // filter rather than returning a silently empty table.
  it('accepts an id present in the loaded options and ignores one that is not', () => {
    const options = [{ id: 'cmp_1' }, { id: 'cmp_2' }]
    expect(parseOptionId('cmp_2', options)).toBe('cmp_2')
    expect(parseOptionId('cmp_9', options)).toBeUndefined()
    expect(parseOptionId('', options)).toBeUndefined()
    expect(parseOptionId(undefined, options)).toBeUndefined()
    expect(parseOptionId('cmp_1', [])).toBeUndefined()
  })
})

// The four dropdowns are not four separate queries. `buildWhere` already ANDs
// them, and they must go on narrowing each other, the search box, the
// incomplete checkbox and the NEEDS ACTION scope all at once.
describe('filters compose', () => {
  it('narrows by company, cash account, eligibility, search, scope and incompleteness together', async () => {
    const wanted = await makeCheck({
      checkNumber: '6000000910', status: 'SIGNED', eligibility: 'SUPPLIER',
      amount: null, payeeName: 'HENKEL PHILIPPINES INC.',
    })
    // Same company and account, but released — excluded by the NEEDS ACTION scope.
    await testDb.check.create({
      data: {
        companyId: wanted.companyId, cashAccountId: wanted.cashAccountId,
        checkNumber: '6000000911', status: 'RELEASED', eligibility: 'SUPPLIER',
        payeeName: 'HENKEL PHILIPPINES INC.', isIncomplete: true, checkDate: new Date('2026-09-01'),
      },
    })
    // Same company and account and live, but INTERNAL.
    await testDb.check.create({
      data: {
        companyId: wanted.companyId, cashAccountId: wanted.cashAccountId,
        checkNumber: '6000000912', status: 'SIGNED', eligibility: 'INTERNAL',
        payeeName: 'HENKEL PHILIPPINES INC.', isIncomplete: true, checkDate: new Date('2026-09-01'),
      },
    })
    // A different company entirely.
    await makeCheck({ checkNumber: '6000000913', amount: null, status: 'SIGNED' })

    const filters = {
      q: 'henkel',
      companyId: wanted.companyId,
      cashAccountId: wanted.cashAccountId ?? undefined,
      eligibility: 'SUPPLIER' as const,
      incomplete: true,
      statusIn: LIVE_STATUSES,
    }

    const rows = await listChecks(testDb, filters)

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000910'])
    expect(await countChecks(testDb, filters)).toBe(1)
  })

  it('filters by cash account on its own', async () => {
    const one = await makeCheck({ checkNumber: '6000000920' })
    await makeCheck({ checkNumber: '6000000921' })

    const rows = await listChecks(testDb, { cashAccountId: one.cashAccountId ?? undefined })

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000920'])
  })

  it('filters by company on its own', async () => {
    const one = await makeCheck({ checkNumber: '6000000930' })
    await makeCheck({ checkNumber: '6000000931' })

    const rows = await listChecks(testDb, { companyId: one.companyId })

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000930'])
  })
})

/**
 * TODAY'S RELEASE: the panel above the table, and the set RELEASE ALL acts on.
 *
 * The set is READY_FOR_RELEASE **and** SCHEDULED, exactly like the card of the
 * same name — a panel offering to release 81 cheques above a card reading 87 is
 * a bug report waiting to happen. The pairing is not restated here or in
 * `getTodaysRelease`; both read `viewStatusFilter` in lib/dashboard-view.ts.
 */
describe('getTodaysRelease', () => {
  it('covers READY_FOR_RELEASE and SCHEDULED together and nothing else', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '100.00' })
    await makeCheck({ status: 'SCHEDULED', amount: '200.00' })
    await makeCheck({ status: 'SIGNED', amount: '400.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: '800.00' })
    await makeCheck({ status: 'RELEASED', amount: '1600.00' })
    await makeCheck({ status: 'CANCELLED', amount: '3200.00' })

    const t = await getTodaysRelease(testDb)
    expect(t.count).toBe(2)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: '300', count: 2 }])
  })

  // The same rule getSummary obeys. Production is PHP-only today; the rule is
  // structural, not a reading of the current data.
  it('never adds two different currencies together', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', currency: 'PHP', amount: '1000.00' })
    await makeCheck({ status: 'SCHEDULED', currency: 'PHP', amount: '500.50' })
    await makeCheck({ status: 'READY_FOR_RELEASE', currency: 'CNY', amount: '2000.25' })

    const t = await getTodaysRelease(testDb)
    expect(t.count).toBe(3)
    expect(t.totalsByCurrency).toHaveLength(2)
    expect(t.totalsByCurrency).toEqual(expect.arrayContaining([
      { currency: 'PHP', total: '1500.5', count: 2 },
      { currency: 'CNY', total: '2000.25', count: 1 },
    ]))
  })

  // Six of the 129 incomplete cheques are READY_FOR_RELEASE in production, so
  // this is a live case, not a hypothetical. The cheque is counted and its
  // (absent) amount is not summed - and `incomplete` exists so the panel can
  // SAY so, rather than leaving a reader to wonder why 81 cheques total less
  // than they expected.
  it('counts a cheque with no amount but leaves it out of the total, and reports how many', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '1000.00' })
    await makeCheck({ status: 'SCHEDULED', amount: null })

    const t = await getTodaysRelease(testDb)
    expect(t.count).toBe(2)
    expect(t.incomplete).toBe(1)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: '1000', count: 2 }])
  })

  // Every amount unknown is not the same fact as a total of zero, and must not
  // render as one. `formatMoney` shows null as an em dash.
  it('carries a wholly unknown total through as null rather than zero', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: null })

    const t = await getTodaysRelease(testDb)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: null, count: 1 }])
    expect(t.incomplete).toBe(1)
  })

  // The panel is shown even when there is nothing to release, so the empty
  // answer has to be a real one rather than a throw or a null.
  it('answers zero when nothing is ready', async () => {
    await makeCheck({ status: 'SIGNED' })
    const t = await getTodaysRelease(testDb)
    expect(t).toEqual({ count: 0, incomplete: 0, totalsByCurrency: [] })
  })

  // The amount is a decimal STRING at every boundary. A JS number here would
  // lose centavos on a nine-figure peso total, and this is the figure a person
  // reads before handing over the money.
  it('reports the total as a decimal string, never a number', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '6315173.06' })
    const t = await getTodaysRelease(testDb)
    expect(typeof t.totalsByCurrency[0].total).toBe('string')
    expect(formatMoney(t.totalsByCurrency[0].total, 'PHP')).toBe('₱6,315,173.06')
  })
})
