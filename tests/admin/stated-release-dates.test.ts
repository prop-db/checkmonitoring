import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { CompanyReferenceData } from '@/lib/import/company'
import type { RawRow } from '@/lib/import/workbook'
import type { RegisterRelease } from '@/lib/admin/register-releases'
import {
  asDay, statedDay, dayToDate, dateToDay, judge, planStatedReleaseDates, applyStatedReleaseDates, snapshotOf,
  STATED_RELEASE_DATE_ACTION, EARLIEST_PLAUSIBLE_DAY, type Candidate,
} from '@/lib/admin/stated-release-dates'

const REF: CompanyReferenceData = {
  cashAccounts: [{ code: 'BPI STK', company: 'STK' }],
  checkBooks: [{ code: 'BPI-S-4636', company: 'STK' }, { code: 'MBT-A-4155', company: 'A1+' }],
}

const HEADER = [
  'REMARKS', 'PO NUMBER', 'CHECK NUMBER', 'CHECKS APV', 'PAYEE', 'DESCRIPTION', 'TYPE',
  'VOUCHER NUMBER', 'CHECK DATE', 'CHECK AMOUNT', 'DATE RELEASED', 'REMARKS',
]

/** The Manila day the script "runs" in these tests. */
const LATEST = '2026-09-28'
const NOW = new Date('2026-09-28T04:00:00.000Z') // 12:00 Manila on the 28th

/** A register row as the RELEASED sheets lay it out. Serial 46290 = 2026-09-25. */
function row(sheet: string, n: number, checkNumber: string, book: string | null = 'BPI-S-4636', released: unknown = 46290): RawRow {
  return {
    sheet, row: n, header: HEADER,
    cells: ['PAID', null, checkNumber, 'CV-ST011550', 'SUPPLIER INC.', null, book, 'AP-ST036198', 46014, 7950, released, 'DEPOSITED'],
  }
}

const release = (rows: RegisterRelease['rows'], companyCodes: string[] = ['STK']): RegisterRelease =>
  ({ checkNumber: '6000308584', companyCodes, rows })

describe('asDay', () => {
  it('reads an Excel date cell as the reader renders it', () => {
    expect(asDay('2026-09-25')).toBe('2026-09-25')
  })

  // 222 of the 228 rows the 9.25 register dates 25 September hold this text.
  it('reads month/day/year typed as text, the only order a Finance workstation here uses', () => {
    expect(asDay('09/25/2026')).toBe('2026-09-25')
    expect(asDay('7/15/2026')).toBe('2026-07-15')
    expect(asDay(' 09/25/2026 ')).toBe('2026-09-25')
  })

  it('reads nothing else', () => {
    for (const v of ['SEPT 25', 'CLEARED', '25/09/2026', '13/01/2026', '2026-02-30', '09-25-2026', '09/25/26', '']) {
      expect(asDay(v)).toBeNull()
    }
  })
})

describe('statedDay', () => {
  it('is the one day the rows state, ignoring blanks and text, in either spelling', () => {
    expect(statedDay(release([
      { sheet: 'A', row: 1, dateReleased: '2026-09-25' },
      { sheet: 'B', row: 2, dateReleased: null },
      { sheet: 'C', row: 3, dateReleased: 'SEPT 25' },
      { sheet: 'D', row: 4, dateReleased: '09/25/2026' },
    ]), LATEST)).toEqual({ kind: 'DAY', day: '2026-09-25' })
  })

  it('refuses two different days rather than picking one', () => {
    expect(statedDay(release([
      { sheet: 'A', row: 1, dateReleased: '2026-09-25' },
      { sheet: 'B', row: 2, dateReleased: '09/22/2026' },
    ]), LATEST)).toEqual({ kind: 'CONFLICTING_DATES', days: ['2026-09-22', '2026-09-25'] })
  })

  it('reports text and blanks as no usable date, keeping the text for a human', () => {
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: 'SEPT 22' }, { sheet: 'B', row: 2, dateReleased: null }]), LATEST))
      .toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['SEPT 22'] })
    expect(statedDay(release([]), LATEST)).toEqual({ kind: 'NO_USABLE_DATE', verbatim: [] })
  })

  it('does not accept a day that is not on the calendar', () => {
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: '2026-02-30' }]), LATEST))
      .toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['2026-02-30'] })
  })

  // The 9.25 register states 2081-05-08 on one row. A mis-key needs a person;
  // it must not be written, and it must not be dropped so another row's day
  // could win on the same cheque.
  it('refuses a day outside the plausible window, and the whole cheque with it', () => {
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: '2081-05-08' }]), LATEST))
      .toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['2081-05-08'] })
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: '2026-09-29' }]), LATEST).kind).toBe('NO_USABLE_DATE')
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: '2014-12-31' }]), LATEST).kind).toBe('NO_USABLE_DATE')
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: EARLIEST_PLAUSIBLE_DAY }]), LATEST).kind).toBe('DAY')
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: LATEST }]), LATEST).kind).toBe('DAY')
    expect(statedDay(release([
      { sheet: 'A', row: 1, dateReleased: '2026-09-25' }, { sheet: 'B', row: 2, dateReleased: '2081-05-08' },
    ]), LATEST)).toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['2026-09-25', '2081-05-08'] })
  })
})

describe('day conversion', () => {
  it('stores a day as its UTC midnight and reads it back unchanged', () => {
    expect(dayToDate('2026-09-25').toISOString()).toBe('2026-09-25T00:00:00.000Z')
    expect(dateToDay(new Date('2026-09-25T00:00:00.000Z'))).toBe('2026-09-25')
  })
})

describe('judge', () => {
  const rel = release([{ sheet: 'BPI RELEASED', row: 5, dateReleased: '2026-09-25' }])
  const c = (o: Partial<Candidate> = {}): Candidate => ({
    id: 'x', checkNumber: '6000308584', companyCode: 'STK', status: 'RELEASED', statedReleaseDate: null, ...o,
  })

  it('writes the day onto the one RELEASED cheque with that number', () => {
    expect(judge(rel, [c()], LATEST)).toEqual({ kind: 'WRITE', check: c(), day: '2026-09-25' })
  })

  it('matches on the number even when the register names another company', () => {
    expect(judge(rel, [c({ id: 'a', companyCode: 'A1+' })], LATEST)).toMatchObject({ kind: 'WRITE', check: { id: 'a' } })
  })

  it('uses the register’s company only to break a tie', () => {
    expect(judge(rel, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b' })], LATEST)).toMatchObject({ kind: 'WRITE', check: { id: 'b' } })
    expect(judge(rel, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b', companyCode: 'IND' })], LATEST)).toEqual({ kind: 'AMBIGUOUS', count: 2 })
    expect(judge(release(rel.rows, []), [c({ id: 'a' }), c({ id: 'b' })], LATEST)).toEqual({ kind: 'AMBIGUOUS', count: 2 })
  })

  it('leaves a cheque that is absent, not released here, or already stated', () => {
    expect(judge(rel, [], LATEST)).toEqual({ kind: 'NOT_IN_SYSTEM' })
    expect(judge(rel, [c({ status: 'SIGNED' })], LATEST)).toMatchObject({ kind: 'NOT_RELEASED_HERE' })
    expect(judge(rel, [c({ status: 'CANCELLED' })], LATEST)).toMatchObject({ kind: 'NOT_RELEASED_HERE' })
    expect(judge(rel, [c({ statedReleaseDate: dayToDate('2026-09-25') })], LATEST)).toMatchObject({ kind: 'ALREADY_STATED' })
  })

  it('never overwrites a different stated day', () => {
    expect(judge(rel, [c({ statedReleaseDate: dayToDate('2026-09-22') })], LATEST))
      .toMatchObject({ kind: 'DIFFERENT_DATE_STATED', stated: '2026-09-22', day: '2026-09-25' })
  })

  it('reports an unusable or conflicting date before looking anything up', () => {
    expect(judge(release([{ sheet: 'A', row: 1, dateReleased: 'SEPT 25' }]), [c()], LATEST)).toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['SEPT 25'] })
    expect(judge(release([{ sheet: 'A', row: 1, dateReleased: '2026-09-25' }, { sheet: 'B', row: 2, dateReleased: '2026-09-24' }]), [c()], LATEST))
      .toEqual({ kind: 'CONFLICTING_DATES', days: ['2026-09-24', '2026-09-25'] })
  })
})

describe('plan and apply', () => {
  beforeEach(resetDb)

  it('writes the stated day and one audit row, touches nothing else, and a second run does nothing', async () => {
    const released = await makeCheck({ status: 'RELEASED', checkNumber: '7000000001' })
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '7000000002' })
    const text = await makeCheck({ status: 'RELEASED', checkNumber: '7000000003' })
    const typed = await makeCheck({ status: 'RELEASED', checkNumber: '7000000005' })
    const raw = [
      row('STK P&P RELEASED', 5, '7000000001', null),
      row('STK P&P RELEASED', 6, '7000000002', null),
      row('STK P&P RELEASED', 7, '7000000003', null, 'SEPT 25'),
      row('STK P&P RELEASED', 8, '7000000005', null, '09/25/2026'),
    ]

    const plan = await planStatedReleaseDates(testDb, 'REGISTER.xlsx', raw, REF, NOW)
    expect(plan.latest).toBe(LATEST)
    expect(plan.toWrite.map((t) => [t.check.id, t.day]).sort()).toEqual([[released.id, '2026-09-25'], [typed.id, '2026-09-25']].sort())
    expect(plan.counts.NOT_RELEASED_HERE).toBe(1)
    expect(plan.counts.NO_USABLE_DATE).toBe(1)
    expect(plan.listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkNumber: '7000000002', kind: 'NOT_RELEASED_HERE' }),
      expect.objectContaining({ checkNumber: '7000000003', kind: 'NO_USABLE_DATE', detail: 'SEPT 25' }),
    ]))
    expect(snapshotOf(plan, new Date()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: released.id, status: 'RELEASED', statedReleaseDate: null }),
      expect.objectContaining({ id: typed.id, status: 'RELEASED', statedReleaseDate: null }),
    ]))

    expect(await applyStatedReleaseDates(testDb, plan)).toEqual({ written: 2, raced: 0 })

    const after = Object.fromEntries((await testDb.check.findMany()).map((c) => [c.id, c]))
    expect(after[released.id].statedReleaseDate).toEqual(dayToDate('2026-09-25'))
    expect(after[released.id].releasedAt).toBeNull()
    expect(after[released.id].releasedById).toBeNull()
    expect(after[released.id].status).toBe('RELEASED')
    expect(after[typed.id].statedReleaseDate).toEqual(dayToDate('2026-09-25'))
    expect(after[signed.id].statedReleaseDate).toBeNull()
    expect(after[signed.id].status).toBe('SIGNED')
    expect(after[text.id].statedReleaseDate).toBeNull()

    const audit = await testDb.auditLog.findMany({ where: { action: STATED_RELEASE_DATE_ACTION, checkId: released.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ checkId: released.id, actorType: 'SYSTEM', userId: null })
    expect(audit[0].details).toMatchObject({
      file: 'REGISTER.xlsx', statedReleaseDate: '2026-09-25',
      registerRows: [{ sheet: 'STK P&P RELEASED', row: 5, dateReleased: '2026-09-25' }],
    })
    expect(await testDb.auditLog.count({ where: { action: STATED_RELEASE_DATE_ACTION } })).toBe(2)

    const again = await planStatedReleaseDates(testDb, 'REGISTER.xlsx', raw, REF, NOW)
    expect(again.toWrite).toEqual([])
    expect(again.counts.ALREADY_STATED).toBe(2)
  })

  it('also writes the stated day onto a cheque the app released, leaving the timestamp alone', async () => {
    const when = new Date('2026-09-25T02:00:00.000Z')
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '7000000004', releasedAt: when })
    const plan = await planStatedReleaseDates(testDb, 'R.xlsx', [row('BPI RELEASED', 2, '7000000004', null)], REF, NOW)
    expect(await applyStatedReleaseDates(testDb, plan)).toEqual({ written: 1, raced: 0 })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.releasedAt).toEqual(when)
    expect(after.statedReleaseDate).toEqual(dayToDate('2026-09-25'))
  })

  it('skips a cheque that changed between the plan and the write', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '7000000009' })
    const plan = await planStatedReleaseDates(testDb, 'R.xlsx', [row('BPI RELEASED', 2, '7000000009', null)], REF, NOW)
    await testDb.check.update({ where: { id: c.id }, data: { statedReleaseDate: dayToDate('2026-09-20') } })
    expect(await applyStatedReleaseDates(testDb, plan)).toEqual({ written: 0, raced: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).statedReleaseDate).toEqual(dayToDate('2026-09-20'))
    expect(await testDb.auditLog.count({ where: { action: STATED_RELEASE_DATE_ACTION } })).toBe(0)
  })
})
