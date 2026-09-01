import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  const u = await makeUser()
  currentUser.id = u.id
})

function fd(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

describe('readyForReleaseAction', () => {
  it('marks a signed check ready and reports success', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
  })

  it('returns the exact spec warning for an unsigned check', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result).toEqual({
      ok: false,
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    })
  })

  it('rejects a missing availability date without throwing', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('revertAction', () => {
  it('requires a reason', async () => {
    const { readyForReleaseAction, revertAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await revertAction(fd({ checkId: check.id, reason: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('releaseAction', () => {
  it('releases an available check', async () => {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await releaseAction(fd({ checkId: check.id, remarks: 'Picked up by supplier' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
  })
})
