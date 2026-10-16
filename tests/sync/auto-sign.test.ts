import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { runAutoSign, listAutoSignCandidates, getLastAutoSign } from '@/lib/sync/auto-sign'
import { AUTO_SIGN_RUN_ACTION } from '@/lib/domain/auto-sign'
import { markSigned, revertSignature } from '@/lib/domain/actions'

// Monday 12 Oct 2026 and Tuesday 13 Oct 2026, Manila (UTC+8).
const mondayNoon = new Date('2026-10-12T04:00:00Z')
const mondayEvening = new Date('2026-10-12T10:00:00Z')   // 18:00 Manila, the day's last run
const tuesdayNoon = new Date('2026-10-13T04:00:00Z')
const tuesdayEvening = new Date('2026-10-13T10:00:00Z')
const wednesdayNoon = new Date('2026-10-14T04:00:00Z')

const backlog = new Date('2026-09-29T02:00:00Z')         // Tue 29 Sep, the old backlog
const lastThursday = new Date('2026-10-08T02:00:00Z')    // Thu 8 Oct
const sundayLast = new Date('2026-10-11T15:59:59Z')      // Sun 23:59:59 Manila
const mondayFirst = new Date('2026-10-11T16:00:00Z')     // Mon 00:00 Manila
const mondayLate = new Date('2026-10-12T15:59:59Z')      // Mon 23:59:59 Manila
const tuesdayFirst = new Date('2026-10-12T16:00:00Z')    // Tue 00:00 Manila

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
  it('on a Monday lists every Acumatica check first read before that Monday, oldest first', async () => {
    const old = await pendingAt(backlog)
    const thu = await pendingAt(lastThursday)
    const sun = await pendingAt(sundayLast, { acumaticaStatus: null })
    await pendingAt(mondayFirst)                                   // Monday's own: waits for Tuesday
    await pendingAt(lastThursday, { acumaticaStatus: 'Voided' })
    await pendingAt(lastThursday, { acumatica: false })
    const ids = (await listAutoSignCandidates(testDb, mondayNoon)).map((c) => c.id)
    expect(ids).toEqual([old.id, thu.id, sun.id])
  })

  it('on a Tuesday lists Monday’s checks and any leftover, not Tuesday’s', async () => {
    const leftover = await pendingAt(lastThursday)
    const mon = await pendingAt(mondayFirst)
    const monLate = await pendingAt(mondayLate)
    await pendingAt(tuesdayFirst)
    const ids = (await listAutoSignCandidates(testDb, tuesdayNoon)).map((c) => c.id)
    expect(ids).toEqual([leftover.id, mon.id, monLate.id])
  })

  it('leaves out a reverted check', async () => {
    const u = await makeUser()
    const c = await pendingAt(lastThursday)
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-10-08T03:00:00Z') })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-10-08T04:00:00Z') })
    expect(await listAutoSignCandidates(testDb, mondayNoon)).toEqual([])
  })

  it('lists nothing Wednesday to Sunday', async () => {
    await pendingAt(lastThursday)
    expect(await listAutoSignCandidates(testDb, wednesdayNoon)).toEqual([])
  })
})

describe('runAutoSign', () => {
  it('signs last week’s and older checks on Monday, leaves Monday’s, and records one run row', async () => {
    const old = await pendingAt(backlog)
    const thu = await pendingAt(lastThursday)
    const mon = await pendingAt(mondayFirst)

    const run = await runAutoSign(testDb, { now: mondayNoon })
    expect(run).toEqual({ outcome: 'OK', signed: 2, skipped: 0, enabled: true })
    const after = await testDb.check.findMany({ where: { id: { in: [old.id, thu.id, mon.id] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(after.map((r) => [r.id, r.status]))).toEqual({
      [old.id]: 'SIGNED', [thu.id]: 'SIGNED', [mon.id]: 'SIGNATURE_PENDING',
    })
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkId: null, actorType: 'SYSTEM' })
    expect(rows[0].details).toMatchObject({ outcome: 'OK', signed: 2, enabled: true })
  })

  it('signs Monday’s checks on Tuesday and leaves Tuesday’s', async () => {
    const mon = await pendingAt(mondayFirst)
    const tue = await pendingAt(tuesdayFirst)
    expect(await runAutoSign(testDb, { now: tuesdayNoon })).toEqual({ outcome: 'OK', signed: 1, skipped: 0, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: mon.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: tue.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('is IDLE on a Wednesday and signs nothing', async () => {
    const c = await pendingAt(lastThursday)
    expect(await runAutoSign(testDb, { now: wednesdayNoon })).toEqual({ outcome: 'IDLE', signed: 0, skipped: 0, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('is DISABLED when the setting is 0', async () => {
    await testDb.setting.create({ data: { key: 'autoSign.mondayEnabled', value: '0' } })
    const c = await pendingAt(lastThursday)
    expect(await runAutoSign(testDb, { now: mondayNoon })).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await getLastAutoSign(testDb))?.outcome).toBe('DISABLED')
  })

  it.each([
    ['Monday 12:00', mondayNoon, 'the 18:00 run continues'],
    ['Monday 18:00', mondayEvening, "Tuesday's run continues"],
    ['Tuesday 12:00', tuesdayNoon, 'the 18:00 run continues'],
    ['Tuesday 18:00', tuesdayEvening, "next Monday's run continues"],
  ] as const)('stops at the deadline on %s as FAILED, naming the run that continues', async (_label, now, fate) => {
    const c = await pendingAt(lastThursday)
    const run = await runAutoSign(testDb, { now, deadline: new Date(0) })
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0 })
    expect(run.error).toBe(`time budget reached with 1 check(s) still due; ${fate}`)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({ outcome: 'FAILED' })
  })

  it('records FAILED and returns rather than throwing', async () => {
    await pendingAt(lastThursday)
    const spy = vi.spyOn(testDb.check, 'findMany').mockRejectedValueOnce(new Error('neon went away'))
    const run = await runAutoSign(testDb, { now: mondayNoon })
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
    const a = await pendingAt(backlog)
    const b = await pendingAt(lastThursday)
    const real = testDb.$transaction.bind(testDb)
    const spy = vi.spyOn(testDb, '$transaction').mockImplementationOnce((async (fn: any, opts: any) => {
      await testDb.check.delete({ where: { id: a.id } })
      return real(fn, opts)
    }) as any)
    const run = await runAutoSign(testDb, { now: mondayNoon })
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
