import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { MAX_BULK_SELECTION } from '@/lib/bulk'

const currentUser = {
  id: '',
  email: 'f@rcl.test',
  name: 'Finance User',
  role: 'FINANCE_USER' as 'FINANCE_USER' | 'FINANCE_ADMIN',
}

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
  currentUser.role = 'FINANCE_USER'
})

function fd(checkIds: string[], extra: Record<string, string> = {}) {
  const f = new FormData()
  for (const id of checkIds) f.append('checkId', id)
  for (const [k, v] of Object.entries(extra)) f.append(k, v)
  return f
}

// A per-cheque outcome, found by id. Every assertion below goes through this so
// a reordering of the outcomes array can never make a test pass by accident.
function outcomeFor(result: unknown, checkId: string) {
  const r = result as { ok: true; outcomes: { checkId: string }[] }
  const found = r.outcomes.find((o) => o.checkId === checkId)
  if (!found) throw new Error(`No outcome reported for ${checkId}`)
  return found as { checkId: string; checkNumber: string | null; ok: boolean; message?: string }
}

describe('bulkSignAction', () => {
  it('signs every selected cheque', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING' })

    const result = await bulkSignAction(fd([a.id, b.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    for (const id of [a.id, b.id]) {
      const after = await testDb.check.findUniqueOrThrow({ where: { id } })
      expect(after.status).toBe('SIGNED')
      expect(after.signedById).toBe(currentUser.id)
    }
  })

  it('processes each cheque independently: one refusal does not abort the rest', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    // The refused one FIRST, so an implementation that aborts on the first
    // failure leaves the other two untouched and fails this test.
    const released = await makeCheck({ status: 'RELEASED' })
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING' })

    const result = await bulkSignAction(fd([released.id, a.id, b.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: released.id } })).status).toBe('RELEASED')
  })

  it('reports the domain’s own sentence for a refusal, not a generic one', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const released = await makeCheck({ status: 'RELEASED' })

    const result = await bulkSignAction(fd([released.id]))

    expect(result.ok).toBe(true)
    const outcome = outcomeFor(result, released.id)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('Cannot move a check from RELEASED to SIGNED.')
    expect(outcome.checkNumber).toBe(released.checkNumber)
  })

  it('refuses a non-cheque payment with the spec wording', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const transfer = await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: false })

    const result = await bulkSignAction(fd([transfer.id]))

    expect(result.ok).toBe(true)
    expect(outcomeFor(result, transfer.id).message).toBe(
      'This payment is not a cheque, so it cannot be signed or released. It is tracked here for visibility only.',
    )
  })

  it('refuses an empty selection without touching anything', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const result = await bulkSignAction(fd([]))
    expect(result).toEqual({ ok: false, message: 'Select at least one cheque first.' })
  })

  it('refuses a selection larger than the cap and writes nothing', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const real = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const padding = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `missing-${i}`)

    const result = await bulkSignAction(fd([real.id, ...padding]))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(String(MAX_BULK_SELECTION))
    // The cap is a real refusal, not a truncation: the cheque that WOULD have
    // fitted is untouched too.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: real.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('writes one audit row per cheque actually changed', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const released = await makeCheck({ status: 'RELEASED' })

    await bulkSignAction(fd([a.id, released.id]))

    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: 'marked_signed' } })).toBe(1)
    expect(await testDb.auditLog.count({ where: { checkId: released.id } })).toBe(0)
  })
})

describe('bulkReadyForReleaseAction', () => {
  it('marks signed cheques ready and records the pickup date', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNED' })
    const b = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(fd([a.id, b.id], { availablePickupDate: '2026-09-10' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.availablePickupDate?.toISOString().slice(0, 10)).toBe('2026-09-10')
  })

  it('refuses the whole batch when no pickup date was given', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(fd([a.id], { availablePickupDate: '' }))

    expect(result).toEqual({
      ok: false,
      message: 'Enter the available pickup date before marking cheques ready for release.',
    })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
  })

  it('refuses an unparseable pickup date rather than storing an Invalid Date', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(fd([a.id], { availablePickupDate: 'not-a-date' }))

    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
  })

  it('an INTERNAL cheque still changes status and produces NO portal event', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const internal = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    const supplier = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })

    const result = await bulkReadyForReleaseAction(
      fd([internal.id, supplier.id], { availablePickupDate: '2026-09-10' }),
    )

    expect(result.ok).toBe(true)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: internal.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    // The property the whole system exists to protect: no instruction about an
    // internal payment may ever reach the supplier portal, however it was
    // marked ready.
    expect(await testDb.portalEvent.count({ where: { checkId: internal.id } })).toBe(0)
    // And the batch did not simply skip portal events altogether.
    expect(await testDb.portalEvent.count({ where: { checkId: supplier.id } })).toBe(1)
  })

  it('reports the missing-fields refusal per cheque', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const noAmount = await makeCheck({ status: 'SIGNED', amount: null })
    const fine = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(
      fd([noAmount.id, fine.id], { availablePickupDate: '2026-09-10' }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    expect(outcomeFor(result, noAmount.id).message).toBe(
      'This check cannot be released because required information is missing: AMOUNT.',
    )
  })
})

describe('bulkReleaseAction', () => {
  it('refuses a FINANCE_USER by returning a result, never by throwing a redirect', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkReleaseAction(fd([a.id]))

    expect(result).toEqual({ ok: false, message: 'Only a Finance Admin can mark a cheque RELEASED.' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('releases the selected cheques for a FINANCE_ADMIN', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'SCHEDULED' })
    const notReady = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReleaseAction(fd([a.id, b.id, notReady.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('RELEASED')
    expect(outcomeFor(result, notReady.id).message).toBe('Cannot move a check from SIGNED to RELEASED.')
  })
})
