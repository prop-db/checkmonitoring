import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'

const currentUser: { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' } = {
  id: '', email: 'admin@rcl.test', name: 'Finance Admin', role: 'FINANCE_ADMIN',
}
vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser('FINANCE_ADMIN')).id
  currentUser.role = 'FINANCE_ADMIN'
})

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

describe('the settings actions', () => {
  it('saves and resets as an admin', async () => {
    const a = await import('@/app/admin/settings/actions')
    expect(await a.updateSettingAction(fd({ key: 'caps.exportRows', value: '500' }))).toEqual({ ok: true })
    expect((await testDb.setting.findUniqueOrThrow({ where: { key: 'caps.exportRows' } })).value).toBe('500')
    expect(await a.resetSettingAction(fd({ key: 'caps.exportRows' }))).toEqual({ ok: true })
    expect(await testDb.setting.count()).toBe(0)
  })

  it('returns the registry sentence for a bad value', async () => {
    const a = await import('@/app/admin/settings/actions')
    const r = await a.updateSettingAction(fd({ key: 'login.emailFreeFailures', value: '1' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/between 3 and 10/)
  })

  it('refuses a FINANCE_USER by returning, not redirecting', async () => {
    const a = await import('@/app/admin/settings/actions')
    currentUser.role = 'FINANCE_USER'
    expect(await a.updateSettingAction(fd({ key: 'caps.exportRows', value: '500' }))).toEqual({ ok: false, message: 'Only a Finance Admin can change settings.' })
    expect(await a.resetSettingAction(fd({ key: 'caps.exportRows' }))).toEqual({ ok: false, message: 'Only a Finance Admin can change settings.' })
    expect(await testDb.setting.count()).toBe(0)
  })
})
