import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { runAutoSign, listAutoSignCandidates, getLastAutoSign } from '@/lib/sync/auto-sign'
import { AUTO_SIGN_RUN_ACTION } from '@/lib/domain/auto-sign'

const DAY = 86_400_000
const now = new Date('2026-09-25T10:00:00Z')

async function pending(daysInApp: number, o: { acumatica?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING' })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: o.acumatica === false ? null : `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt: new Date(now.getTime() - daysInApp * DAY),
    },
  })
}

beforeEach(resetDb)

describe('listAutoSignCandidates', () => {
  it('lists only the due, including a null Acumatica status, excluding Voided and register-only', async () => {
    const due = await pending(4)
    const dueNullStatus = await pending(3, { acumaticaStatus: null })
    await pending(1)
    await pending(9, { acumaticaStatus: 'Voided' })
    await pending(9, { acumatica: false })
    const ids = (await listAutoSignCandidates(testDb, now, 3)).map((c) => c.id).sort()
    expect(ids).toEqual([due.id, dueNullStatus.id].sort())
  })
})

describe('runAutoSign', () => {
  it('signs the due cheques and records one run row with no checkId', async () => {
    const a = await pending(3)
    const b = await pending(10)
    await pending(1)

    const run = await runAutoSign(testDb, { now })
    expect(run).toEqual({ outcome: 'OK', signed: 2, skipped: 0, days: 3 })
    const statuses = await testDb.check.findMany({ where: { id: { in: [a.id, b.id] } }, select: { status: true } })
    expect(statuses.every((s) => s.status === 'SIGNED')).toBe(true)

    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkId: null, actorType: 'SYSTEM' })
    expect(rows[0].details).toMatchObject({ outcome: 'OK', signed: 2, skipped: 0, days: 3 })
  })

  it('records DISABLED and signs nothing when the setting is 0', async () => {
    await testDb.setting.create({ data: { key: 'autoSign.afterDays', value: '0' } })
    const c = await pending(30)
    expect(await runAutoSign(testDb, { now })).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, days: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await getLastAutoSign(testDb))?.outcome).toBe('DISABLED')
  })

  it('records FAILED and returns rather than throwing', async () => {
    await pending(5)
    const spy = vi.spyOn(testDb.check, 'findMany').mockRejectedValueOnce(new Error('neon went away'))
    const run = await runAutoSign(testDb, { now })
    spy.mockRestore()
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0, error: 'neon went away' })
    const last = await getLastAutoSign(testDb)
    expect(last).toMatchObject({ outcome: 'FAILED', error: 'neon went away' })
  })

  it('getLastAutoSign is null before any run', async () => {
    expect(await getLastAutoSign(testDb)).toBeNull()
  })

  it('records FAILED with what is left when the time budget is already spent', async () => {
    await pending(4)
    await pending(5)
    const run = await runAutoSign(testDb, { now, deadline: new Date(0) })
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0 })
    expect(run.error).toContain('2 cheque(s) still due')
    const statuses = await testDb.check.findMany({ where: { status: 'SIGNATURE_PENDING' } })
    expect(statuses).toHaveLength(2)
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({ outcome: 'FAILED' })
  })

  it('skips a cheque deleted between listing and signing instead of failing the whole run', async () => {
    // `a` is older, so listAutoSignCandidates (ordered by createdAt asc) visits
    // it first; deleting it inside the first $transaction call makes autoSign's
    // own load() throw the real DomainError('NOT_FOUND'), rather than mocking
    // the throw directly.
    const a = await pending(4)
    const b = await pending(3)

    const real = testDb.$transaction.bind(testDb)
    const spy = vi.spyOn(testDb, '$transaction').mockImplementationOnce((async (fn: any, opts: any) => {
      await testDb.check.delete({ where: { id: a.id } })
      return real(fn, opts)
    }) as any)

    const run = await runAutoSign(testDb, { now })
    spy.mockRestore()

    expect(run).toEqual({ outcome: 'OK', signed: 1, skipped: 1, days: 3 })
    expect((await testDb.check.findUnique({ where: { id: b.id } }))?.status).toBe('SIGNED')
    expect(await testDb.check.findUnique({ where: { id: a.id } })).toBeNull()
  })
})
