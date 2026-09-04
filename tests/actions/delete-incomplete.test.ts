import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { deleteIncompleteCheck } from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

// A mutable session, so one file can exercise both roles — the pattern
// tests/admin/user-actions.test.ts established. The server action must refuse a
// FINANCE_USER by RETURNING a result, never by redirecting: `requireAdmin`
// redirects, Next implements a redirect by throwing, and `run()`'s catch would
// swallow it and report "something went wrong" instead.
const currentUser: { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' } = {
  id: '', email: 'admin@rcl.test', name: 'Finance Admin', role: 'FINANCE_ADMIN',
}

vi.mock('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => currentUser,
}))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

let actorId = ''

beforeEach(async () => {
  await resetDb()
  currentUser.role = 'FINANCE_ADMIN'
  const actor = await makeUser('FINANCE_ADMIN')
  actorId = actor.id
  currentUser.id = actor.id
})

const REASON = 'Register row has no amount and Acumatica has no record of it.'

const del = (checkId: string, over: Partial<{ userId: string; actorRole: 'FINANCE_USER' | 'FINANCE_ADMIN'; reason: string }> = {}) =>
  deleteIncompleteCheck(testDb, {
    checkId,
    userId: over.userId ?? actorId,
    actorRole: over.actorRole ?? 'FINANCE_ADMIN',
    reason: over.reason ?? REASON,
    now: new Date('2026-09-04T09:00:00Z'),
  })

describe('deleteIncompleteCheck', () => {
  it('deletes an incomplete cheque that never left the building', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    await del(check.id)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).toBeNull()
  })

  // The whole point of the feature. The audit rows are the record of who
  // touched money; they survive the deletion detached — checkId nulled by the
  // FK's ON DELETE SET NULL — with every other column byte-identical.
  it('leaves every audit row standing, detached but otherwise untouched', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    const before = await testDb.auditLog.create({
      data: {
        checkId: check.id, actorType: 'USER', userId: actorId, action: 'marked_signed',
        details: { source: 'WORKBOOK' }, remarks: 'a remark a human wrote',
      },
    })

    await del(check.id)

    const after = await testDb.auditLog.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.checkId).toBeNull()
    expect(after.action).toBe('marked_signed')
    expect(after.actorType).toBe('USER')
    expect(after.userId).toBe(actorId)
    expect(after.details).toEqual({ source: 'WORKBOOK' })
    expect(after.remarks).toBe('a remark a human wrote')
    expect(after.createdAt).toEqual(before.createdAt)
  })

  // Without this row the surviving audit rows point at nothing and nobody can
  // say what was deleted. It is the deletion's own record and is written in the
  // same transaction, so a failed delete cannot leave it behind claiming
  // something that still exists.
  it('writes a final audit row naming what was removed', async () => {
    const check = await makeCheck({
      amount: null, status: 'SIGNATURE_PENDING', payeeName: 'HENKEL PHILIPPINES INC.',
      checkNumber: '6000240287',
    })
    const company = await testDb.company.findUniqueOrThrow({ where: { id: check.companyId } })
    await testDb.check.update({
      where: { id: check.id }, data: { sourceSheet: 'BPI RELEASED', sourceRow: 412 },
    })

    await del(check.id)

    const row = await testDb.auditLog.findFirstOrThrow({
      where: { action: 'incomplete_check_deleted' },
    })
    expect(row.actorType).toBe('USER')
    expect(row.userId).toBe(actorId)
    expect(row.details).toMatchObject({
      checkId: check.id,
      checkNumber: '6000240287',
      companyCode: company.code,
      payeeName: 'HENKEL PHILIPPINES INC.',
      status: 'SIGNATURE_PENDING',
      sourceSheet: 'BPI RELEASED',
      sourceRow: 412,
    })
    expect(row.remarks).toContain(REASON)
  })

  it('refuses a Finance User and deletes nothing', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    await expect(del(check.id, { actorRole: 'FINANCE_USER' })).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  it('refuses a cheque that records an amount', async () => {
    const check = await makeCheck({ amount: '197715.42', status: 'SIGNATURE_PENDING' })
    await expect(del(check.id)).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  it('refuses a RELEASED cheque with no amount — 25 of the 129 are exactly this', async () => {
    const check = await makeCheck({ amount: null, status: 'RELEASED' })
    await expect(del(check.id)).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  it('refuses a cheque carrying a release timestamp whatever its status says', async () => {
    const check = await makeCheck({ amount: null, status: 'VOIDED' })
    await testDb.check.update({
      where: { id: check.id }, data: { releasedAt: new Date('2026-02-06T04:00:00Z') },
    })
    await expect(del(check.id)).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  it('requires a reason', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    await expect(del(check.id, { reason: '   ' })).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  it('reports a cheque that is already gone rather than succeeding silently', async () => {
    await expect(del('no-such-check-id')).rejects.toThrow(DomainError)
  })

  // `PortalEvent.checkId` is NOT NULL, so an event cannot be detached the way
  // an audit row can — and a queued event is an instruction to tell a supplier
  // something about a cheque. The outbox must never be left holding one whose
  // cheque has vanished.
  it('refuses a cheque the outbox still holds an event for', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    await testDb.portalEvent.create({
      data: {
        checkId: check.id, direction: 'OUT', kind: 'MARK_AVAILABLE', payload: {},
        idempotencyKey: `${check.id}:MARK_AVAILABLE:probe`,
      },
    })
    await expect(del(check.id)).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  // `StagedCheck.promotedCheckId` is a plain column with no foreign key, so
  // nothing in the database would stop this and the pointer would simply
  // dangle — the staged queue would go on reporting the row as promoted into a
  // cheque that no longer exists.
  it('refuses a cheque a staged register row was promoted into', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI RELEASED', sourceRow: 999,
        reason: 'NO_COMPANY', impliedStatus: 'SIGNATURE_PENDING',
        checkNumber: check.checkNumber, promotedCheckId: check.id,
      },
    })
    await expect(del(check.id)).rejects.toThrow(DomainError)
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  // A bill is a line OF the cheque and has no meaning without it, which is why
  // the FK has always been ON DELETE CASCADE. None of the 129 carry one; this
  // pins what happens if a future incomplete cheque does.
  it('takes the cheque bills with it', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    await testDb.checkBill.create({
      data: { checkId: check.id, apvNumber: 'APV-0001', amount: '1.00' },
    })
    await del(check.id)
    expect(await testDb.checkBill.count({ where: { checkId: check.id } })).toBe(0)
  })

  // The append-only trigger still means what it says. Detaching a row from a
  // cheque that is genuinely gone is the ONE mutation it permits; every other
  // UPDATE, including blanking the checkId of a live cheque's audit row, still
  // raises.
  it('does not let an audit row be detached from a cheque that still exists', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    const row = await testDb.auditLog.create({
      data: { checkId: check.id, actorType: 'USER', userId: actorId, action: 'marked_signed' },
    })
    await expect(
      testDb.auditLog.update({ where: { id: row.id }, data: { checkId: null } }),
    ).rejects.toThrow()
  })

  it('still refuses to rewrite the content of an audit row', async () => {
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    const row = await testDb.auditLog.create({
      data: { checkId: check.id, actorType: 'USER', userId: actorId, action: 'released' },
    })
    await expect(
      testDb.auditLog.update({ where: { id: row.id }, data: { action: 'nothing_happened' } }),
    ).rejects.toThrow()
  })
})

describe('deleteIncompleteCheckAction', () => {
  it('deletes and reports success for a Finance Admin', async () => {
    const { deleteIncompleteCheckAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    const result = await deleteIncompleteCheckAction(fd({ checkId: check.id, reason: REASON }))
    expect(result).toEqual({ ok: true })
    expect(await testDb.check.findUnique({ where: { id: check.id } })).toBeNull()
  })

  it('refuses a Finance User with a result rather than a redirect', async () => {
    const { deleteIncompleteCheckAction } = await import('@/app/checks/actions')
    currentUser.role = 'FINANCE_USER'
    const check = await makeCheck({ amount: null, status: 'SIGNATURE_PENDING' })
    const result = await deleteIncompleteCheckAction(fd({ checkId: check.id, reason: REASON }))
    expect(result).toEqual({
      ok: false,
      message: 'Only a Finance Admin can delete a cheque record.',
    })
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })

  it('returns the guard message for a released cheque rather than throwing', async () => {
    const { deleteIncompleteCheckAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ amount: null, status: 'RELEASED' })
    const result = await deleteIncompleteCheckAction(fd({ checkId: check.id, reason: REASON }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('RELEASED')
    expect(await testDb.check.findUnique({ where: { id: check.id } })).not.toBeNull()
  })
})
