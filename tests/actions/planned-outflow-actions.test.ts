import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }
vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser()).id
})

function fd(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

async function refs() {
  const company = await testDb.company.create({ data: { code: `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson', legalNames: [] } })
  const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
  return { company, bank }
}

describe('the planned outflow actions', () => {
  it('creates, edits, pays and cancels through the form', async () => {
    const a = await import('@/app/forecast/planned/actions')
    const { company, bank } = await refs()
    const created = await a.createPlannedOutflowAction(fd({
      date: '2026-09-15', amount: '1250000', currency: '', bankId: bank.id, companyId: company.id, description: 'SEPT PAYROLL', category: 'payroll',
    }))
    expect(created).toEqual({ ok: true })
    const line = await testDb.plannedOutflow.findFirstOrThrow()
    expect(line.amount.toFixed(2)).toBe('1250000.00')
    expect(line.currency).toBe('PHP')

    expect(await a.updatePlannedOutflowAction(fd({
      id: line.id, date: '2026-09-16', amount: '1250000', currency: 'PHP', bankId: bank.id, companyId: company.id, description: 'SEPT PAYROLL', category: 'PAYROLL',
    }))).toEqual({ ok: true })

    const second = await testDb.plannedOutflow.create({ data: { date: new Date('2026-09-20T00:00:00Z'), amount: '1.00', bankId: bank.id, companyId: company.id, description: 'X', createdById: currentUser.id } })
    expect(await a.markPlannedOutflowPaidAction(fd({ id: line.id, paidOn: '2026-09-16' }))).toEqual({ ok: true })
    expect(await a.cancelPlannedOutflowAction(fd({ id: second.id, reason: 'Paid by cheque' }))).toEqual({ ok: true })
    expect((await testDb.plannedOutflow.findUniqueOrThrow({ where: { id: line.id } })).status).toBe('PAID')
    expect((await testDb.plannedOutflow.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('CANCELLED')
  })

  it('returns the domain sentence for bad input, writing nothing', async () => {
    const a = await import('@/app/forecast/planned/actions')
    const { company, bank } = await refs()
    const r = await a.createPlannedOutflowAction(fd({ date: '2026-09-15', amount: '1,250,000', bankId: bank.id, companyId: company.id, description: 'X' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/AMOUNT/)
    expect(await testDb.plannedOutflow.count()).toBe(0)
  })

  it('reports an unknown line without throwing', async () => {
    const a = await import('@/app/forecast/planned/actions')
    const r = await a.markPlannedOutflowPaidAction(fd({ id: 'nope', paidOn: '2026-09-16' }))
    expect(r).toEqual({ ok: false, message: 'Planned outflow not found.' })
  })
})
