import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { runAutoSign, listAutoSignCandidates, getLastAutoSign } from '@/lib/sync/auto-sign'
import { AUTO_SIGN_RUN_ACTION } from '@/lib/domain/auto-sign'
import { markSigned, revertSignature } from '@/lib/domain/actions'

const tuesdayNoon = new Date('2026-09-29T04:00:00Z')
const wednesdayNoon = new Date('2026-09-30T04:00:00Z')

async function pendingAt(createdAt: Date, o: { acumatica?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING' })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: o.acumatica === false ? null : `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt,
    },
  })
}

beforeEach(resetDb)

describe('listAutoSignCandidates', () => {
  it('lists Monday’s Acumatica checks only, on a Tuesday', async () => {
    const monEarly = await pendingAt(new Date('2026-09-27T16:00:00Z'))       // Mon 00:00 Manila
    const monNull = await pendingAt(new Date('2026-09-28T09:00:00Z'), { acumaticaStatus: null })
    await pendingAt(new Date('2026-09-27T15:59:59Z'))                         // Sun 23:59:59 Manila
    await pendingAt(new Date('2026-09-28T16:00:00Z'))                         // Tue 00:00 Manila
    await pendingAt(new Date('2026-09-21T09:00:00Z'))                         // the Monday before
    await pendingAt(new Date('2026-09-28T09:00:00Z'), { acumaticaStatus: 'Voided' })
    await pendingAt(new Date('2026-09-28T09:00:00Z'), { acumatica: false })
    const ids = (await listAutoSignCandidates(testDb, tuesdayNoon)).map((c) => c.id).sort()
    expect(ids).toEqual([monEarly.id, monNull.id].sort())
  })

  it('leaves out a reverted check', async () => {
    const u = await makeUser()
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-09-28T10:00:00Z') })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-09-28T11:00:00Z') })
    expect(await listAutoSignCandidates(testDb, tuesdayNoon)).toEqual([])
  })

  it('lists nothing on any other day', async () => {
    await pendingAt(new Date('2026-09-28T09:00:00Z'))
    expect(await listAutoSignCandidates(testDb, wednesdayNoon)).toEqual([])
  })
})

describe('runAutoSign', () => {
  it('signs Monday’s checks on Tuesday and records one run row with no checkId', async () => {
    const a = await pendingAt(new Date('2026-09-28T01:00:00Z'))
    const b = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const tue = await pendingAt(new Date('2026-09-29T01:00:00Z'))

    const run = await runAutoSign(testDb, { now: tuesdayNoon })
    expect(run).toEqual({ outcome: 'OK', signed: 2, skipped: 0, enabled: true })
    const after = await testDb.check.findMany({ where: { id: { in: [a.id, b.id, tue.id] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(after.map((r) => [r.id, r.status]))).toEqual({
      [a.id]: 'SIGNED', [b.id]: 'SIGNED', [tue.id]: 'SIGNATURE_PENDING',
    })
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkId: null, actorType: 'SYSTEM' })
    expect(rows[0].details).toMatchObject({ outcome: 'OK', signed: 2, enabled: true })
  })

  it('is IDLE on a non-Tuesday and signs nothing', async () => {
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    expect(await runAutoSign(testDb, { now: wednesdayNoon })).toEqual({ outcome: 'IDLE', signed: 0, skipped: 0, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('is DISABLED when the setting is 0', async () => {
    await testDb.setting.create({ data: { key: 'autoSign.mondayEnabled', value: '0' } })
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    expect(await runAutoSign(testDb, { now: tuesdayNoon })).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await getLastAutoSign(testDb))?.outcome).toBe('DISABLED')
  })

  it('stops at the deadline as FAILED at 12:00, naming what is left for the 18:00 run', async () => {
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const run = await runAutoSign(testDb, { now: tuesdayNoon, deadline: new Date(0) })
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0 })
    expect(run.error).toBe('time budget reached with 1 check(s) still due; the 18:00 run continues')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({ outcome: 'FAILED' })
  })

  it('stops at the deadline at 18:00 and leaves what is left to SIGN ALL', async () => {
    await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const tuesdayEvening = new Date('2026-09-29T10:00:00Z')   // 18:00 Manila, the last run
    const run = await runAutoSign(testDb, { now: tuesdayEvening, deadline: new Date(0) })
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0 })
    expect(run.error).toBe('time budget reached with 1 check(s) still due; they wait for SIGN ALL')
  })
  it('records FAILED and returns rather than throwing', async () => {
    await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const spy = vi.spyOn(testDb.check, 'findMany').mockRejectedValueOnce(new Error('neon went away'))
    const run = await runAutoSign(testDb, { now: tuesdayNoon })
    spy.mockRestore()
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0, error: 'neon went away' })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'FAILED', error: 'neon went away' })
  })

  it('getLastAutoSign is null before any run', async () => {
    expect(await getLastAutoSign(testDb)).toBeNull()
  })

  it('skips a check deleted between listing and signing instead of failing the whole run', async () => {
    // `a` is older, so it is visited first; deleting it inside the first
    // $transaction makes autoSign's own load() throw the real NOT_FOUND.
    const a = await pendingAt(new Date('2026-09-28T01:00:00Z'))
    const b = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const real = testDb.$transaction.bind(testDb)
    const spy = vi.spyOn(testDb, '$transaction').mockImplementationOnce((async (fn: any, opts: any) => {
      await testDb.check.delete({ where: { id: a.id } })
      return real(fn, opts)
    }) as any)
    const run = await runAutoSign(testDb, { now: tuesdayNoon })
    spy.mockRestore()
    expect(run).toEqual({ outcome: 'OK', signed: 1, skipped: 1, enabled: true })
    expect((await testDb.check.findUnique({ where: { id: b.id } }))?.status).toBe('SIGNED')
    expect(await testDb.check.findUnique({ where: { id: a.id } })).toBeNull()
  })
})

describe('getLastAutoSign', () => {
  it('reads back the newest run, with enabled', async () => {
    await runAutoSign(testDb, { now: wednesdayNoon })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'IDLE', enabled: true, legacyDays: null })
  })

  it('reads a run recorded under the old days rule as legacy', async () => {
    await testDb.auditLog.create({
      data: { actorType: 'SYSTEM', action: AUTO_SIGN_RUN_ACTION, details: { outcome: 'OK', signed: 2, skipped: 0, days: 3 } },
    })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'OK', signed: 2, enabled: null, legacyDays: 3 })
  })
})
