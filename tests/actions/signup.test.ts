import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { verifyPassword } from '@/lib/password'

// The request headers the action reads the client address from. Mutable so
// one file can play two addresses.
const requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.9' })

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }))

const STRONG = 'Zq7!vantablack-Ledger'

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}
const good = (over: Record<string, string> = {}) =>
  fd({ name: 'New Person', email: 'new@rcl.com.ph', password: STRONG, confirm: STRONG, ...over })

beforeEach(async () => {
  await resetDb()
  requestHeaders.set('x-forwarded-for', '203.0.113.9')
})

describe('registerAction', () => {
  it('creates a pending account and reports the address only', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good())
    expect(result).toEqual({ ok: true, email: 'new@rcl.com.ph' })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(u.active).toBe(false)
    expect(u.pendingSince).not.toBeNull()
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(STRONG)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })

  it('refuses mismatched passwords before touching the database', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ confirm: 'Different-1!Password' }))
    expect(result).toEqual({ ok: false, message: 'The two passwords do not match.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(0)
  })

  it('does not trim the password', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const spaced = ` ${STRONG} `
    expect((await registerAction(good({ password: spaced, confirm: spaced }))).ok).toBe(true)
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(await verifyPassword(u.passwordHash, spaced)).toBe(true)
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(false)
  })

  it('passes a domain refusal through in its own words, and still records the attempt', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ password: 'short', confirm: 'short' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/at least 12 characters/)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })

  it('refuses an address past its hourly allowance and still records the attempt', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const now = new Date()
    for (let i = 0; i < 5; i++) {
      await testDb.registrationAttempt.create({ data: { ip: '203.0.113.9', email: `bot${i}@x.com`, createdAt: now } })
    }
    const result = await registerAction(good())
    expect(result).toEqual({ ok: false, message: 'Too many accounts have been created from this connection. Try again later.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(6)

    // Another address is unaffected.
    requestHeaders.set('x-forwarded-for', '198.51.100.7')
    expect((await registerAction(good())).ok).toBe(true)
  })

  it('honours the allowance setting', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    await testDb.setting.create({ data: { key: 'signup.ipPerHour', value: '1' } })
    expect((await registerAction(good())).ok).toBe(true)
    expect((await registerAction(good({ email: 'second@rcl.com.ph' }))).ok).toBe(false)
  })
})
