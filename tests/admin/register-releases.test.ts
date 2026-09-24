import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { CompanyReferenceData } from '@/lib/import/company'
import type { RawRow } from '@/lib/import/workbook'
import {
  readRegisterReleases, judge, planRegisterReleases, applyRegisterReleases, snapshotOf,
  RELEASED_FROM_REGISTER_ACTION, type Candidate, type RegisterRelease,
} from '@/lib/admin/register-releases'

const REF: CompanyReferenceData = {
  cashAccounts: [{ code: 'BPI STK', company: 'STK' }],
  checkBooks: [{ code: 'BPI-S-4636', company: 'STK' }, { code: 'MBT-A-4155', company: 'A1+' }],
}

const HEADER = [
  'REMARKS', 'PO NUMBER', 'CHECK NUMBER', 'CHECKS APV', 'PAYEE', 'DESCRIPTION', 'TYPE',
  'VOUCHER NUMBER', 'CHECK DATE', 'CHECK AMOUNT', 'DATE RELEASED', 'REMARKS',
]

/** A register row, laid out as the RELEASED sheets are. Serial 46024 = 2026-01-02. */
function row(sheet: string, n: number, checkNumber: string, book: string | null = 'BPI-S-4636', released: unknown = 46024): RawRow {
  return {
    sheet, row: n, header: HEADER,
    cells: ['PAID', null, checkNumber, 'CV-ST011550', 'SUPPLIER INC.', null, book, 'AP-ST036198', 46014, 7950, released, 'DEPOSITED'],
  }
}

describe('readRegisterReleases', () => {
  it('reads a cheque on a RELEASED sheet, with its company and the date the register stated', () => {
    const r = readRegisterReleases([row('BPI RELEASED', 7, '6000308584')], REF)
    expect(r.released).toEqual([{
      checkNumber: '6000308584', companyCodes: ['STK'],
      rows: [{ sheet: 'BPI RELEASED', row: 7, dateReleased: '2026-01-02' }],
    }])
  })

  it('ignores a cheque that is only on a pending or AVAIL. sheet', () => {
    const r = readRegisterReleases([row('MBTC AVAIL.', 3, '1791361727', 'MBT-A-4155'), row('MBTC P&P', 4, '1791361728', 'MBT-A-4155')], REF)
    expect(r.released).toEqual([])
  })

  it("applies Finance's rulings across every sheet: RELEASED + CANCELLED is released", () => {
    const r = readRegisterReleases([row('BPI RELEASED', 2, '6000319079'), row('CANCELLED', 9, '6000319079')], REF)
    expect(r.released.map((x) => x.checkNumber)).toEqual(['6000319079'])
    expect(r.released[0].rows).toHaveLength(1)
  })

  it('but RELEASED + CANCELLED + FINDING is cancelled, and is not picked up', () => {
    const r = readRegisterReleases([
      row('BPI RELEASED', 2, '6000319079'), row('CANCELLED', 9, '6000319079'), row('CHECK FINDING', 4, '6000319079'),
    ], REF)
    expect(r.released).toEqual([])
    expect(r.overruled).toBe(1)
  })

  it('keeps a DATE RELEASED that is text verbatim, and a blank or invalid one as null', () => {
    const r = readRegisterReleases([row('BPI RELEASED', 2, '6000400001', null, 'SEPT 22'), row('BPI RELEASED', 3, '6000400002', null, null), row('BPI RELEASED', 4, '6000400003', null, new Date(NaN))], REF)
    expect(r.released.map((x) => x.rows[0].dateReleased)).toEqual(['SEPT 22', null, null])
    expect(r.released[0].companyCodes).toEqual([])
  })
})

describe('judge', () => {
  const release: RegisterRelease = { checkNumber: '6000308584', companyCodes: ['STK'], rows: [] }
  const c = (o: Partial<Candidate> = {}): Candidate => ({
    id: 'x', checkNumber: '6000308584', companyCode: 'STK', status: 'SIGNED', acumaticaStatus: 'Balanced', ...o,
  })

  it('releases the one matching cheque at a live rung', () => {
    for (const status of ['SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const) {
      expect(judge(release, [c({ status })]).kind).toBe('RELEASE')
    }
  })

  it('matches the one cheque with that number even when the register names another company', () => {
    // The register's company is known wrong on 1,958 cheques; Acumatica's wins.
    expect(judge(release, [c({ id: 'a', companyCode: 'A1+' })])).toMatchObject({ kind: 'RELEASE', check: { id: 'a' } })
  })

  it('uses the register row’s company only to break a tie between cheques sharing a number', () => {
    expect(judge(release, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b' })])).toMatchObject({ kind: 'RELEASE', check: { id: 'b' } })
    expect(judge(release, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b', companyCode: 'IND' })]))
      .toEqual({ kind: 'AMBIGUOUS', count: 2 })
  })

  it('refuses more than one match when the register named no company', () => {
    expect(judge({ ...release, companyCodes: [] }, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b' })]))
      .toEqual({ kind: 'AMBIGUOUS', count: 2 })
  })

  it('leaves what is released, cancelled, voided, voided in Acumatica, or absent', () => {
    expect(judge(release, [c({ status: 'RELEASED' })]).kind).toBe('ALREADY_RELEASED')
    expect(judge(release, [c({ status: 'CANCELLED' })]).kind).toBe('CANCELLED_OR_VOIDED_HERE')
    expect(judge(release, [c({ status: 'VOIDED' })]).kind).toBe('CANCELLED_OR_VOIDED_HERE')
    expect(judge(release, [c({ acumaticaStatus: 'Voided' })]).kind).toBe('VOIDED_IN_ACUMATICA')
    expect(judge(release, []).kind).toBe('NOT_IN_SYSTEM')
  })
})

describe('plan and apply', () => {
  beforeEach(resetDb)

  it('moves a picked-up cheque to RELEASED with one audit row, and a second run does nothing', async () => {
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '7000000001' })
    const cancelled = await makeCheck({ status: 'CANCELLED', checkNumber: '7000000002' })
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '7000000003' }) // not on a RELEASED sheet
    const raw = [
      row('STK P&P RELEASED', 5, '7000000001', null),
      row('STK P&P RELEASED', 6, '7000000002', null),
      row('BPI PAPER AND PLASTIC', 7, '7000000003', null),
    ]

    const plan = await planRegisterReleases(testDb, 'REGISTER.xlsx', raw, REF)
    expect(plan.toRelease.map((t) => t.check.id)).toEqual([signed.id])
    expect(plan.counts.CANCELLED_OR_VOIDED_HERE).toBe(1)
    expect(snapshotOf(plan, new Date()).rows).toEqual([expect.objectContaining({ id: signed.id, status: 'SIGNED' })])

    expect(await applyRegisterReleases(testDb, plan)).toEqual({ released: 1, raced: 0 })

    const after = await testDb.check.findMany({ where: { id: { in: [signed.id, cancelled.id, pending.id] } } })
    const status = Object.fromEntries(after.map((a) => [a.id, a]))
    expect(status[signed.id].status).toBe('RELEASED')
    expect(status[signed.id].releasedAt).toBeNull()
    expect(status[signed.id].releasedById).toBeNull()
    expect(status[cancelled.id].status).toBe('CANCELLED')
    expect(status[pending.id].status).toBe('SIGNATURE_PENDING')

    const audit = await testDb.auditLog.findMany({ where: { action: RELEASED_FROM_REGISTER_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ checkId: signed.id, actorType: 'SYSTEM' })
    expect(audit[0].details).toMatchObject({
      from: 'SIGNED', to: 'RELEASED', registerRows: [{ sheet: 'STK P&P RELEASED', row: 5, dateReleased: '2026-01-02' }],
    })

    const again = await planRegisterReleases(testDb, 'REGISTER.xlsx', raw, REF)
    expect(again.toRelease).toEqual([])
    expect(again.counts.ALREADY_RELEASED).toBe(1)
  })

  it('skips a cheque that moved between the plan and the write', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '7000000009' })
    const plan = await planRegisterReleases(testDb, 'R.xlsx', [row('BPI RELEASED', 2, '7000000009', null)], REF)
    await testDb.check.update({ where: { id: c.id }, data: { status: 'READY_FOR_RELEASE' } })
    expect(await applyRegisterReleases(testDb, plan)).toEqual({ released: 0, raced: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('READY_FOR_RELEASE')
  })
})
