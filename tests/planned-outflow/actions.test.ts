import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import {
  createPlannedOutflow, updatePlannedOutflow, markPlannedOutflowPaid, cancelPlannedOutflow,
} from '@/lib/planned-outflow/actions'
import { listPlannedOutflows, listBanks } from '@/lib/planned-outflow/query'

const NOW = new Date('2026-09-12T10:00:00+08:00')
beforeEach(resetDb)

async function refs() {
  const user = await makeUser()
  const company = await testDb.company.create({ data: { code: `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson', legalNames: [] } })
  const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
  return { user, company, bank }
}

const input = (bankId: string, companyId: string, o: Partial<{ date: string; amount: string; description: string; category: string | null }> = {}) => ({
  date: '2026-09-15', amount: '1250000', bankId, companyId, description: 'SEPT 2ND-HALF PAYROLL', category: 'payroll', ...o,
})

const trail = (id: string, action: string) =>
  testDb.auditLog.findMany({ where: { action, details: { path: ['plannedOutflowId'], equals: id } } })

describe('createPlannedOutflow', () => {
  it('creates a PLANNED line with its audit row', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    expect(line.status).toBe('PLANNED')
    expect(line.amount.toFixed(2)).toBe('1250000.00')
    expect(line.date).toEqual(new Date('2026-09-15T00:00:00.000Z'))
    expect(line.category).toBe('PAYROLL')
    expect(line.createdById).toBe(user.id)
    const rows = await trail(line.id, 'planned_outflow_created')
    expect(rows).toHaveLength(1)
    expect(rows[0].actorType).toBe('USER')
    expect(rows[0].checkId).toBeNull()
    expect(rows[0].details).toMatchObject({ plannedOutflowId: line.id, description: 'SEPT 2ND-HALF PAYROLL', amount: '1250000.00' })
  })

  it('refuses bad input before touching the database', async () => {
    const { user, company, bank } = await refs()
    await expect(createPlannedOutflow(testDb, { input: input(bank.id, company.id, { amount: '1,250,000' }), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(await testDb.plannedOutflow.count()).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('refuses a bank or company that does not exist', async () => {
    const { user, company, bank } = await refs()
    await expect(createPlannedOutflow(testDb, { input: input('nope', company.id), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'UNKNOWN_BANK' })
    await expect(createPlannedOutflow(testDb, { input: input(bank.id, 'nope'), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'UNKNOWN_COMPANY' })
  })
})

describe('updatePlannedOutflow', () => {
  it('writes the changed fields and records from → to', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    const out = await updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id, { amount: '1300000', date: '2026-09-16' }), userId: user.id, now: NOW })
    expect(out.amount.toFixed(2)).toBe('1300000.00')
    expect(out.date).toEqual(new Date('2026-09-16T00:00:00.000Z'))
    const rows = await trail(line.id, 'planned_outflow_updated')
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({
      changes: { amount: { from: '1250000.00', to: '1300000.00' }, date: { from: '2026-09-15', to: '2026-09-16' } },
    })
  })

  it('writes nothing when nothing changed', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id), userId: user.id, now: NOW })
    expect(await trail(line.id, 'planned_outflow_updated')).toHaveLength(0)
  })

  it('keeps a category the list has since dropped, but refuses a new one off the list', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await testDb.setting.create({ data: { key: 'categories', value: '["TAX"]' } })
    const kept = await updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id, { amount: '99' }), userId: user.id, now: NOW })
    expect(kept.category).toBe('PAYROLL')
    await expect(updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id, { category: 'rent' }), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'UNKNOWN_CATEGORY' })
  })

  it('refuses to edit a line that is not PLANNED', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await markPlannedOutflowPaid(testDb, { id: line.id, paidOn: '2026-09-15', userId: user.id, now: NOW })
    await expect(updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id, { amount: '1' }), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_PLANNED' })
  })
})

describe('markPlannedOutflowPaid and cancelPlannedOutflow', () => {
  it('marks PAID with who and when', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    const out = await markPlannedOutflowPaid(testDb, { id: line.id, paidOn: '2026-09-15', userId: user.id, now: NOW })
    expect(out.status).toBe('PAID')
    expect(out.paidById).toBe(user.id)
    expect(out.paidAt).toEqual(new Date('2026-09-15T00:00:00.000Z'))
    expect(await trail(line.id, 'planned_outflow_paid')).toHaveLength(1)
  })

  it('refuses a paid date it cannot read', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await expect(markPlannedOutflowPaid(testDb, { id: line.id, paidOn: 'yesterday', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'INVALID_DATE' })
  })

  it('cancels with a reason, and refuses a blank one', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await expect(cancelPlannedOutflow(testDb, { id: line.id, reason: ' ', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    const out = await cancelPlannedOutflow(testDb, { id: line.id, reason: 'Paid by cheque instead', userId: user.id, now: NOW })
    expect(out.status).toBe('CANCELLED')
    expect(out.cancelReason).toBe('Paid by cheque instead')
    expect(out.cancelledById).toBe(user.id)
    const rows = await trail(line.id, 'planned_outflow_cancelled')
    expect(rows[0].remarks).toBe('Paid by cheque instead')
  })

  it('never reopens a closed line', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await cancelPlannedOutflow(testDb, { id: line.id, reason: 'dup', userId: user.id, now: NOW })
    await expect(markPlannedOutflowPaid(testDb, { id: line.id, paidOn: '2026-09-15', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_PLANNED' })
    await expect(cancelPlannedOutflow(testDb, { id: line.id, reason: 'again', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_PLANNED' })
  })

  it('reports an unknown id as NOT_FOUND', async () => {
    const user = await makeUser()
    await expect(markPlannedOutflowPaid(testDb, { id: 'nope', paidOn: '2026-09-15', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listPlannedOutflows', () => {
  it('lists open lines soonest first, and the closed ones only on request, newest first', async () => {
    const { user, company, bank } = await refs()
    const later = await createPlannedOutflow(testDb, { input: input(bank.id, company.id, { date: '2026-09-20', description: 'LATER' }), userId: user.id, now: NOW })
    const sooner = await createPlannedOutflow(testDb, { input: input(bank.id, company.id, { date: '2026-09-10', description: 'SOONER' }), userId: user.id, now: NOW })
    const paid = await createPlannedOutflow(testDb, { input: input(bank.id, company.id, { description: 'PAID ONE' }), userId: user.id, now: NOW })
    await markPlannedOutflowPaid(testDb, { id: paid.id, paidOn: '2026-09-12', userId: user.id, now: NOW })

    const open = await listPlannedOutflows(testDb, { includeClosed: false })
    expect(open.map((r) => r.id)).toEqual([sooner.id, later.id])
    expect(open[0]).toMatchObject({ amount: '1250000.00', bankCode: bank.code, companyCode: company.code, status: 'PLANNED', createdBy: user.name })
    expect(typeof open[0].amount).toBe('string')

    const all = await listPlannedOutflows(testDb, { includeClosed: true })
    expect(all.map((r) => r.id)).toEqual([sooner.id, later.id, paid.id])
    expect(all[2]).toMatchObject({ status: 'PAID', paidBy: user.name })
  })

  it('lists banks by id and code', async () => {
    const { bank } = await refs()
    expect(await listBanks(testDb)).toEqual([{ id: bank.id, code: bank.code }])
  })
})
