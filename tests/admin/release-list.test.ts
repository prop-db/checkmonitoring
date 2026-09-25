import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  readReleaseList, judge, planReady, applyReady, snapshotOf, READY_FROM_LIST_ACTION, type Candidate,
} from '@/lib/admin/release-list'

/** The three shapes of FOR RELEASE 9.25.2026.xlsx, cut down. */
const DETAIL1 = {
  name: 'Detail1',
  rows: [
    ['Details for Sum of Detail Total'], [],
    ['Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref.', 'Vendor Name'],
    [null, '09-2026', 'AP-ST000001', 'PO-1', 'SUPPLIER'],
    [null, '09-2026', 'not a voucher', 'PO-2', 'SUPPLIER'],
  ],
}
const LOCAL = {
  name: 'LOCAL',
  rows: [
    [null, null, null, 1000],
    ['BANK', 'Date', 'Post Period', { richText: [{ text: 'Reference Nbr.' }] }],
    ['BPI P&P', null, '09-2026', 'STPP-AP-000021'],
    ['BPI P&P', null, '09-2026', 'AP-ST000001'],
  ],
}
const BROKERS = {
  name: 'BROKERS',
  rows: [
    ['PO Number', 'CHECK NUMBER', 'CHECKS APV', 'PAYEE', 'DESCRIPTION', 'TYPE', 'VOUCHER NUMBER'],
    [null, 'BPI 6000400001', 'CV-1', 'BROKER', null, 'BPI-S-4636', 'AP-ST000002'],
    [null, '6000400002', 'CV-2', 'BROKER', null, 'BPI-S-4636', null],
  ],
}
const PIVOT = { name: 'PIVOT', rows: [[null, 'BANK', 'MBTC P&P'], ['Row Labels', 'Sum']] }

describe('readReleaseList', () => {
  it('finds the header on rows 1-3 of each sheet, skips a pivot and its drill-down, and reads vouchers and cheque numbers', () => {
    const r = readReleaseList([DETAIL1, LOCAL, BROKERS, PIVOT])
    expect(r.sheets).toEqual([
      { sheet: 'Detail1', read: false, entries: 0 },
      { sheet: 'LOCAL', read: true, entries: 2 },
      { sheet: 'BROKERS', read: true, entries: 2 },
      { sheet: 'PIVOT', read: false, entries: 0 },
    ])
    expect(r.entries).toEqual([
      { sheet: 'LOCAL', row: 3, voucher: 'STPP-AP-000021', checkNumber: null },
      { sheet: 'LOCAL', row: 4, voucher: 'AP-ST000001', checkNumber: null },
      { sheet: 'BROKERS', row: 2, voucher: 'AP-ST000002', checkNumber: '6000400001' },
      { sheet: 'BROKERS', row: 3, voucher: null, checkNumber: '6000400002' },
    ])
  })
})

describe('judge', () => {
  const c = (o: Partial<Candidate> = {}): Candidate => ({
    id: 'x', checkNumber: '1', status: 'SIGNED', acumaticaStatus: 'Balanced', isCheque: true, ...o,
  })

  it('promotes the one live cheque from a rung below ready', () => {
    for (const status of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED'] as const) {
      expect(judge([c({ status })]).kind).toBe('PROMOTE')
    }
  })

  it('ignores a cancelled twin when exactly one live cheque remains (a re-issue)', () => {
    expect(judge([c({ id: 'old', status: 'CANCELLED' }), c({ id: 'new' })])).toMatchObject({ kind: 'PROMOTE', check: { id: 'new' } })
  })

  it('leaves everything else', () => {
    expect(judge([]).kind).toBe('NO_MATCH')
    expect(judge([c({ status: 'VOIDED' })]).kind).toBe('ONLY_CANCELLED_OR_VOIDED')
    expect(judge([c({ id: 'a' }), c({ id: 'b' })])).toEqual({ kind: 'AMBIGUOUS', count: 2 })
    expect(judge([c({ status: 'READY_FOR_RELEASE' })]).kind).toBe('ALREADY_READY')
    expect(judge([c({ status: 'SCHEDULED' })]).kind).toBe('ALREADY_READY')
    expect(judge([c({ status: 'RELEASED' })]).kind).toBe('RELEASED_HERE')
    expect(judge([c({ isCheque: false })]).kind).toBe('NOT_PROMOTABLE')
    expect(judge([c({ acumaticaStatus: 'Voided' })]).kind).toBe('NOT_PROMOTABLE')
  })
})

describe('plan and apply', () => {
  beforeEach(resetDb)

  it('moves listed cheques to READY_FOR_RELEASE with one audit row each, reports the off-list, and is idempotent', async () => {
    const byVoucher = await makeCheck({ status: 'SIGNED', checkNumber: '7100000001', apvNumbers: ['AP-ST000001'] })
    const byNumber = await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000400002' })
    const released = await makeCheck({ status: 'RELEASED', checkNumber: '7100000003', apvNumbers: ['STPP-AP-000021'] })
    const offList = await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '7100000004' })
    const list = readReleaseList([DETAIL1, LOCAL, BROKERS])

    const plan = await planReady(testDb, 'FOR RELEASE.xlsx', list)
    expect(plan.toPromote.map((p) => p.check.id).sort()).toEqual([byVoucher.id, byNumber.id].sort())
    expect(plan.counts.RELEASED_HERE).toBe(1)
    expect(plan.counts.NO_MATCH).toBe(1) // AP-ST000002 / 6000400001 names nothing
    expect(plan.offList).toEqual([{ checkNumber: '7100000004', acumaticaStatus: null }])
    expect(snapshotOf(plan, new Date()).rows).toHaveLength(2)

    expect(await applyReady(testDb, plan)).toEqual({ promoted: 2, raced: 0 })
    const after = Object.fromEntries((await testDb.check.findMany()).map((c) => [c.id, c]))
    expect(after[byVoucher.id]).toMatchObject({ status: 'READY_FOR_RELEASE', readyAt: null, readyById: null, availablePickupDate: null })
    expect(after[byNumber.id].status).toBe('READY_FOR_RELEASE')
    expect(after[released.id].status).toBe('RELEASED')
    expect(after[offList.id].status).toBe('READY_FOR_RELEASE')

    const audit = await testDb.auditLog.findMany({ where: { action: READY_FROM_LIST_ACTION, checkId: byVoucher.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0].details).toMatchObject({ from: 'SIGNED', to: 'READY_FOR_RELEASE', listRows: [{ sheet: 'LOCAL', row: 4 }] })
    expect(await testDb.portalEvent.count()).toBe(0)

    const again = await planReady(testDb, 'FOR RELEASE.xlsx', list)
    expect(again.toPromote).toEqual([])
    expect(again.counts.ALREADY_READY).toBe(2)
  })

  it('skips a cheque that moved between the plan and the write', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '7100000009', apvNumbers: ['AP-ST000001'] })
    const plan = await planReady(testDb, 'F.xlsx', readReleaseList([LOCAL]))
    await testDb.check.update({ where: { id: c.id }, data: { status: 'CANCELLED' } })
    expect(await applyReady(testDb, plan)).toEqual({ promoted: 0, raced: 1 })
  })
})
