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

describe('releaseAction with a receipt', () => {
  async function ready() {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-10' }))
    return check
  }

  it('records the reference, the date and the kind of receipt', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({
      checkId: check.id, orNumber: 'OR-000123', orDate: '2026-09-10', receiptType: 'OR',
    }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.orNumber).toBe('OR-000123')
    expect(after.receiptType).toBe('OR')
    expect(after.crNumber).toBeNull()
  })

  it('releases with an empty box', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({ checkId: check.id, orNumber: '', receiptType: '' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.receiptType).toBeNull()
  })

  it('returns the domain’s sentence for a reference with no type', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({ checkId: check.id, orNumber: 'OR-000123', receiptType: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Collection Receipt')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status)
      .toBe('READY_FOR_RELEASE')
  })

  it('rejects a receipt type that is neither OR nor CR without throwing', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({ checkId: check.id, orNumber: 'X', receiptType: 'crn' }))
    expect(result).toEqual({ ok: false, message: 'Invalid receipt type.' })
  })
})

describe('recordReceiptAction', () => {
  async function released() {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-10' }))
    await releaseAction(fd({ checkId: check.id }))
    return check
  }

  it('adds the receipt to a cheque released without one', async () => {
    const { recordReceiptAction } = await import('@/app/checks/actions')
    const check = await released()
    const result = await recordReceiptAction(fd({
      checkId: check.id, orNumber: '4471', orDate: '2026-09-11', receiptType: 'CR',
    }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.orNumber).toBe('4471')
    expect(after.receiptType).toBe('CR')
    // The Collection Receipt is not a bank clearing reference.
    expect(after.crNumber).toBeNull()
    expect(after.clearingStatus).toBe('NONE')
  })

  it('refuses a cheque that has not been released', async () => {
    const { recordReceiptAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await recordReceiptAction(fd({
      checkId: check.id, orNumber: 'OR-1', receiptType: 'OR',
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('RELEASED')
  })

  it('refuses an empty box rather than reporting success at doing nothing', async () => {
    const { recordReceiptAction } = await import('@/app/checks/actions')
    const check = await released()
    const result = await recordReceiptAction(fd({ checkId: check.id, orNumber: '', receiptType: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('clearingAction', () => {
  it('rejects a bogus clearingStatus without throwing', async () => {
    const { clearingAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await clearingAction(fd({ checkId: check.id, clearingStatus: 'NOT_A_REAL_STATUS' }))
    expect(result).toEqual({ ok: false, message: 'Invalid clearing status.' })
  })
})
