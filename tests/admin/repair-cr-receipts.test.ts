import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  classifyRow, planRepair, snapshotOf, applyRepair,
  RECEIPT_RECLASSIFIED_ACTION, RULING, type RepairRow,
} from '@/lib/admin/repair-cr-receipts'

beforeEach(resetDb)

const base: RepairRow = {
  id: 'x', checkNumber: '6000319079', crNumber: 'CR 6336',
  orNumber: null, receiptType: null, clearingStatus: 'NONE', clearedDate: null,
  sourceSheet: 'BPI RELEASED', sourceRow: 412,
}

describe('classifyRow', () => {
  it('repairs a CR-shaped crNumber on a cheque with no receipt and no clearing', () => {
    expect(classifyRow(base)).toEqual({ repair: true })
    expect(classifyRow({ ...base, crNumber: 'CR08970' })).toEqual({ repair: true })
  })

  it('leaves a crNumber that is not CR-shaped — that one may really be the bank', () => {
    expect(classifyRow({ ...base, crNumber: 'BPI-77123' })).toEqual({ repair: false, reason: 'NOT_CR_SHAPED' })
  })

  it('leaves a cheque that already records a receipt', () => {
    expect(classifyRow({ ...base, orNumber: 'OR-1', receiptType: 'OR' }))
      .toEqual({ repair: false, reason: 'RECEIPT_ALREADY_RECORDED' })
  })

  it('leaves a cheque with any clearing recorded — that crNumber may be genuine', () => {
    expect(classifyRow({ ...base, clearingStatus: 'DEPOSITED' }))
      .toEqual({ repair: false, reason: 'CLEARING_RECORDED' })
    expect(classifyRow({ ...base, clearedDate: new Date('2026-09-01') }))
      .toEqual({ repair: false, reason: 'CLEARING_RECORDED' })
  })
})

/** A released cheque the 9 September import filed with a CR in the wrong column. */
async function misfiled(crNumber = 'CR 6336') {
  const c = await makeCheck({ status: 'RELEASED' })
  return testDb.check.update({
    where: { id: c.id },
    data: { crNumber, sourceSheet: 'BPI RELEASED', sourceRow: 412 },
  })
}

describe('planRepair', () => {
  it('selects only the misfiled, and counts what it skips', async () => {
    const a = await misfiled()
    const b = await misfiled('CR08970')
    const receipted = await misfiled('CR 1')
    await testDb.check.update({ where: { id: receipted.id }, data: { orNumber: 'OR-9', receiptType: 'OR' } })
    const cleared = await misfiled('CR 2')
    await testDb.check.update({ where: { id: cleared.id }, data: { clearingStatus: 'CLEARED' } })
    const bank = await misfiled('BPI-77123')
    await makeCheck({ status: 'RELEASED' }) // no crNumber at all

    const plan = await planRepair(testDb)
    expect(plan.candidates.map((c) => c.id).sort()).toEqual([a.id, b.id].sort())
    expect(plan.skipped).toEqual({ NOT_CR_SHAPED: 1, RECEIPT_ALREADY_RECORDED: 1, CLEARING_RECORDED: 1 })
    expect(plan.withCrNumber).toBe(5)
    expect(bank.crNumber).toBe('BPI-77123')
  })
})

describe('snapshotOf', () => {
  it('records every affected row as it was, and the ruling', async () => {
    const a = await misfiled()
    const plan = await planRepair(testDb)
    const snap = snapshotOf(plan, new Date('2026-09-11T10:00:00Z'))
    expect(snap.takenAt).toBe('2026-09-11T10:00:00.000Z')
    expect(snap.ruling).toBe(RULING)
    expect(snap.rows).toEqual([{
      id: a.id, checkNumber: a.checkNumber, crNumber: 'CR 6336',
      orNumber: null, receiptType: null, clearingStatus: 'NONE',
    }])
  })
})

describe('applyRepair', () => {
  it('moves the number to the receipt columns, blanks crNumber, writes one SYSTEM audit row', async () => {
    const a = await misfiled()
    // Values on columns the repair must not touch, so a widening of the
    // `data` object is caught here rather than on 2,727 real cheques.
    await testDb.check.update({
      where: { id: a.id }, data: { remarks: 'keep me', apvNumbers: ['AP-ST042652'] },
    })
    const plan = await planRepair(testDb)
    const out = await applyRepair(testDb, plan)
    expect(out).toEqual({ repaired: 1, raced: 0 })

    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.orNumber).toBe('CR 6336')
    expect(after.receiptType).toBe('CR')
    expect(after.orDate).toBeNull()
    expect(after.crNumber).toBeNull()
    expect(after.clearingStatus).toBe('NONE')
    expect(after.clearedDate).toBeNull()
    expect(after.status).toBe('RELEASED')
    expect(after.remarks).toBe('keep me')
    expect(after.apvNumbers).toEqual(['AP-ST042652'])
    expect(after.amount?.toString()).toBe(a.amount?.toString())

    const rows = await testDb.auditLog.findMany({ where: { checkId: a.id, action: RECEIPT_RECLASSIFIED_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0].actorType).toBe('SYSTEM')
    expect(rows[0].userId).toBeNull()
    expect(rows[0].remarks).toBe(RULING)
    expect(rows[0].details).toEqual({
      from: 'crNumber', value: 'CR 6336', sourceSheet: 'BPI RELEASED', sourceRow: 412, ruling: RULING,
    })
  })

  it('is idempotent: a second plan finds nothing', async () => {
    await misfiled()
    await applyRepair(testDb, await planRepair(testDb))
    const again = await planRepair(testDb)
    expect(again.candidates).toHaveLength(0)
    expect(again.withCrNumber).toBe(0)
  })

  it('skips, and counts, a row that changed between plan and apply', async () => {
    const a = await misfiled()
    const plan = await planRepair(testDb)
    // Somebody recorded a real clearing in between.
    await testDb.check.update({ where: { id: a.id }, data: { clearingStatus: 'DEPOSITED' } })
    const out = await applyRepair(testDb, plan)
    expect(out).toEqual({ repaired: 0, raced: 1 })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.crNumber).toBe('CR 6336')
    expect(after.orNumber).toBeNull()
    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: RECEIPT_RECLASSIFIED_ACTION } })).toBe(0)
  })
})
