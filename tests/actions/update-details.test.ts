import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { updateDetails } from '@/lib/domain/actions'

const NOW = new Date('2026-09-11T14:00:00+08:00')
beforeEach(resetDb)

const trail = (checkId: string) =>
  testDb.auditLog.findMany({ where: { checkId, action: 'details_updated' } })

describe('updateDetails', () => {
  it('writes the four register fields and one audit row of from → to', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await updateDetails(testDb, {
      checkId: check.id, userId: user.id, now: NOW,
      fields: { remarks: ' hold for GM ', pointPerson: 'ANA', checksPossession: 'TREASURY', category: 'local supplier' },
    })
    expect(out.remarks).toBe('hold for GM')
    expect(out.pointPerson).toBe('ANA')
    expect(out.checksPossession).toBe('TREASURY')
    expect(out.category).toBe('LOCAL SUPPLIER')
    expect(out.status).toBe('SIGNED')

    const rows = await trail(check.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].actorType).toBe('USER')
    expect(rows[0].userId).toBe(user.id)
    expect(rows[0].details).toEqual({
      remarks: { from: null, to: 'hold for GM' },
      pointPerson: { from: null, to: 'ANA' },
      checksPossession: { from: null, to: 'TREASURY' },
      category: { from: null, to: 'LOCAL SUPPLIER' },
    })
  })

  it('records only the fields that changed', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { remarks: 'a', pointPerson: 'ANA' } })
    await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { remarks: 'b', pointPerson: 'ANA' } })
    const rows = await trail(check.id)
    expect(rows).toHaveLength(2)
    expect(rows[1].details).toEqual({ remarks: { from: 'a', to: 'b' } })
  })

  it('writes nothing — no row, no audit — when nothing changed', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { remarks: 'a' } })
    const before = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { remarks: ' a ' } })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(await trail(check.id)).toHaveLength(1)
  })

  it('clears a field with an empty box, and says so on the trail', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { pointPerson: 'ANA' } })
    const out = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { pointPerson: '' } })
    expect(out.pointPerson).toBeNull()
    const rows = await trail(check.id)
    expect(rows[1].details).toEqual({ pointPerson: { from: 'ANA', to: null } })
  })

  it('accepts a note on a cheque in any status — cancelled included', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'CANCELLED' })
    const out = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { remarks: 'spoiled at printing' } })
    expect(out.remarks).toBe('spoiled at printing')
    expect(out.status).toBe('CANCELLED')
  })

  it('never touches a status, a receipt or a clearing column', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-1', receiptType: 'OR', clearingStatus: 'DEPOSITED', crNumber: 'BPI-1' } })
    const out = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { remarks: 'x' } })
    expect(out.status).toBe('RELEASED')
    expect(out.orNumber).toBe('OR-1')
    expect(out.clearingStatus).toBe('DEPOSITED')
    expect(out.crNumber).toBe('BPI-1')
  })

  it('sets and clears the expected outflow date, as a day on the trail', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const set = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { expectedOutflowDate: '2026-09-20' } })
    expect(set.expectedOutflowDate).toEqual(new Date('2026-09-20T00:00:00.000Z'))
    const cleared = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { expectedOutflowDate: '' } })
    expect(cleared.expectedOutflowDate).toBeNull()
    const rows = await trail(check.id)
    expect(rows[0].details).toEqual({ expectedOutflowDate: { from: null, to: '2026-09-20' } })
    expect(rows[1].details).toEqual({ expectedOutflowDate: { from: '2026-09-20', to: null } })
  })

  it('refuses a date it cannot read, writing nothing', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { expectedOutflowDate: 'next week' } }))
      .rejects.toMatchObject({ code: 'INVALID_DATE' })
    expect(await trail(check.id)).toHaveLength(0)
  })
})
