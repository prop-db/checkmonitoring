import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import {
  runPortalReleasesSync, lastPortalReleasesWatermark, runScheduledPortalReleases,
  RELEASED_ON_PORTAL_ACTION, PORTAL_RELEASES_FIRST_SINCE, NEEDS_LOOK_ACTION, RECEIPT_FROM_PORTAL_ACTION,
  listOpenPortalReleaseLooks, LOOK_CLOSED_ACTION, LOOK_DISMISSED_ACTION, dismissPortalReleaseLook,
} from '@/lib/sync/portal-releases'
import { queueReleasedForStale } from '@/lib/admin/portal-backlog'
import type { PortalRelease, PortalReleasesReader, PortalReleaseStatus } from '@/lib/integrations/portal/releases'

const NOW = new Date('2026-10-19T12:00:00+08:00')
beforeEach(resetDb)

const rel = (o: Partial<PortalRelease> = {}): PortalRelease => ({
  domain: 'LOCAL', releaseId: 1, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'],
  releaseDate: '2026-10-19', releasedAt: new Date('2026-10-19T02:30:00Z'), orNumber: '4852', orDate: '2026-10-19',
  releasedByName: 'LUSIE', releasedByService: false, updatedAt: new Date('2026-10-19T02:30:05Z'), ...o,
})
// The portal's current state of every release asked about: RELEASED, with rel()'s instant and OR,
// unless a test says otherwise in `portalNow` (re-review B).
const portalNow = new Map<string, Partial<PortalReleaseStatus>>()
beforeEach(() => portalNow.clear())
const statuses: NonNullable<PortalReleasesReader['statuses']> = async (ids) => ids.map((k) => ({
  ...k, status: 'RELEASED', releasedAt: new Date('2026-10-19T02:30:00Z'), orNumber: '4852', orDate: '2026-10-19',
  ...portalNow.get(`${k.domain}:${k.releaseId}`),
}))
function reader(rows: PortalRelease[], seen: Date[] = []): PortalReleasesReader {
  return { async list(since) { seen.push(since); return { rows, next: null } }, statuses }
}
const run = (rows: PortalRelease[], since: Date | null = null, seen: Date[] = []) =>
  runPortalReleasesSync(testDb, { reader: reader(rows, seen), since, now: NOW, trigger: 'MANUAL' })

describe('runPortalReleasesSync', () => {
  it.each(['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const)(
    'releases a %s check with the portal date and OR, one audit row, no portal event', async (status) => {
      const c = await makeCheck({ status, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
      const res = await run([rel()])
      expect(res).toMatchObject({ read: 1, released: 1, already: 0, look: [], errors: 0 })
      expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
        status: 'RELEASED', releasedAt: new Date('2026-10-19T02:30:00Z'), releasedById: null,
        orNumber: '4852', orDate: new Date('2026-10-19T00:00:00Z'), receiptType: null, crNumber: null,
      })
      const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: RELEASED_ON_PORTAL_ACTION } })
      expect(audit.details).toMatchObject({ from: status, releaseId: 1, domain: 'LOCAL', releasedByName: 'LUSIE', orNumber: '4852' })
      expect(await testDb.portalEvent.count()).toBe(0)
    })

  it('with no portal instant, records the release day as the stated release date', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await run([rel({ releasedAt: null })])
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'RELEASED', releasedAt: null, statedReleaseDate: new Date('2026-10-19T00:00:00Z'),
    })
  })

  it('keeps an existing receipt (rule 11: never overwritten)', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await testDb.check.update({ where: { id: c.id }, data: { orNumber: '1111', receiptType: 'OR' } })
    await run([rel()])
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'RELEASED', orNumber: '1111', receiptType: 'OR' })
  })

  it('already RELEASED: nothing; CANCELLED / VOIDED: listed, untouched', async () => {
    const a = await makeCheck({ status: 'RELEASED', checkNumber: '6000000001', apvNumbers: ['AP-1'] })
    const b = await makeCheck({ status: 'CANCELLED', checkNumber: '6000000002', apvNumbers: ['AP-2'] })
    const v = await makeCheck({ status: 'VOIDED', checkNumber: '6000000003', apvNumbers: ['AP-3'] })
    const res = await run([
      rel({ checkNumber: '6000000001', apvNumbers: ['AP-1'] }),
      rel({ checkNumber: '6000000002', apvNumbers: ['AP-2'] }),
      rel({ checkNumber: '6000000003', apvNumbers: ['AP-3'] }),
    ])
    expect(res).toMatchObject({ released: 0, already: 1 })
    expect(res.look.map((l) => [l.kind, l.checkNumber])).toEqual([['DEAD_HERE', '6000000002'], ['DEAD_HERE', '6000000003']])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CANCELLED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('VOIDED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
  })

  it('matches on number AND APV: a reused number with another APV is NOT_FOUND; two matches are AMBIGUOUS', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-OLD'] })
    const r1 = await run([rel({ checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })])
    expect(r1.look.map((l) => l.kind)).toEqual(['NOT_FOUND'])
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })
    const r2 = await run([rel({ checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })])
    expect(r2.look.map((l) => l.kind)).toEqual(['AMBIGUOUS'])
    expect(r2.released).toBe(0)
  })

  it('a bank-prefixed portal number matches the bare number here', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await run([rel({ checkNumber: 'BPI 6000354897' })])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('RELEASED')
  })

  it('skips its own echo', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await run([rel({ releasedByService: true })])
    expect(res).toMatchObject({ echo: 1, released: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
  })

  it('records a SyncRun, moves the watermark to the last updatedAt minus 10 minutes, and a re-run is idempotent', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const seen: Date[] = []
    const res = await run([rel()], null, seen)
    expect(seen[0]).toEqual(PORTAL_RELEASES_FIRST_SINCE)
    expect(res.watermark).toEqual(new Date('2026-10-19T02:20:05Z'))
    expect(await lastPortalReleasesWatermark(testDb)).toEqual(new Date('2026-10-19T02:20:05Z'))
    const runRow = await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })
    expect(runRow).toMatchObject({ mode: 'PORTAL_RELEASES', imported: 1, errors: 0 })
    const again = await run([rel()], res.watermark)
    expect(again).toMatchObject({ released: 0, already: 1 })
    expect(await testDb.auditLog.count({ where: { action: RELEASED_ON_PORTAL_ACTION } })).toBe(1)
  })
})

describe('runScheduledPortalReleases', () => {
  it('is SKIPPED_NOT_CONFIGURED when the reader cannot be built', async () => {
    const out = await runScheduledPortalReleases(testDb, { now: NOW, reader: () => { throw new Error('PORTAL_BASE_URL is not set') } })
    expect(out).toEqual({ outcome: 'SKIPPED_NOT_CONFIGURED' })
  })
  it('is FAILED, never throwing, when the portal errors', async () => {
    const out = await runScheduledPortalReleases(testDb, { now: NOW, reader: () => ({ async list() { throw new Error('answered 500') } }) })
    expect(out).toMatchObject({ outcome: 'FAILED' })
  })
})

describe('review round 1', () => {
  // wraps db so a hook runs once just before the release transaction, i.e. between read and write
  const raceDb = (hook: () => Promise<void>) => {
    let fired = false
    return new Proxy(testDb, {
      get(t, p, rcv) {
        if (p === '$transaction') return async (...a: unknown[]) => {
          if (!fired) { fired = true; await hook() }
          return (t.$transaction as (...x: unknown[]) => unknown)(...a)
        }
        const v = Reflect.get(t, p, rcv)
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as typeof testDb
  }
  const go = (db: typeof testDb, rows: PortalRelease[]) =>
    runPortalReleasesSync(db, { reader: reader(rows), since: null, now: NOW, trigger: 'MANUAL' })

  it('a status change between read and write still lands the release', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await go(raceDb(async () => { await testDb.check.update({ where: { id: c.id }, data: { status: 'READY_FOR_RELEASE' } }) }), [rel()])
    expect(res).toMatchObject({ released: 1, already: 0, errors: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('RELEASED')
    const a = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: RELEASED_ON_PORTAL_ACTION } })
    expect(a.details).toMatchObject({ from: 'READY_FOR_RELEASE' })
  })

  it('a check that became CANCELLED between read and write ends as DEAD_HERE', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await go(raceDb(async () => { await testDb.check.update({ where: { id: c.id }, data: { status: 'CANCELLED' } }) }), [rel()])
    expect(res.released).toBe(0)
    expect(res.look.map((l) => l.kind)).toEqual(['DEAD_HERE'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED')
  })

  it('a receipt recorded between read and write is kept, not overwritten', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await go(raceDb(async () => { await testDb.check.update({ where: { id: c.id }, data: { orNumber: '9999', receiptType: 'OR' } }) }), [rel()])
    expect(res.released).toBe(1)
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'RELEASED', orNumber: '9999', receiptType: 'OR' })
  })

  it('pages until next is null, including a page larger than the limit', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000011', apvNumbers: ['AP-11'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000012', apvNumbers: ['AP-12'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000013', apvNumbers: ['AP-13'] })
    const t1 = new Date('2026-10-19T03:00:00Z'), t2 = new Date('2026-10-19T04:00:00Z')
    const seen: Date[] = []
    const pages = [
      { rows: [rel({ checkNumber: '6000000011', apvNumbers: ['AP-11'], updatedAt: t1 }), rel({ checkNumber: '6000000012', apvNumbers: ['AP-12'], updatedAt: t1 })], next: t1 },
      { rows: [rel({ checkNumber: '6000000013', apvNumbers: ['AP-13'], updatedAt: t2 })], next: null },
    ]
    const r: PortalReleasesReader = { async list(since, limit) { seen.push(since); expect(limit).toBe(500); return pages.shift()! } }
    const res = await runPortalReleasesSync(testDb, { reader: r, since: null, now: NOW, trigger: 'MANUAL' })
    expect(res).toMatchObject({ read: 3, released: 3 })
    expect(seen).toEqual([PORTAL_RELEASES_FIRST_SINCE, t1])
  })

  it('holds the watermark after a row error and records it', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const bad = new Proxy(testDb, {
      get(t, p, rcv) {
        if (p === '$transaction') return async () => { throw new Error('boom') }
        const v = Reflect.get(t, p, rcv)
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as typeof testDb
    const res = await go(bad, [rel()])
    expect(res).toMatchObject({ errors: 1, released: 0, watermark: null })
    expect(await lastPortalReleasesWatermark(testDb)).toBeNull()
    const row = await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })
    expect(row.message).toContain('boom')
  })

  it('stores a message with the echo count and the looks', async () => {
    const res = await go(testDb, [rel({ releasedByService: true }), rel({ checkNumber: '1', apvNumbers: ['AP-X'] })])
    const row = await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })
    expect(row.message).toContain('1 echo')
    expect(row.message).toContain('NOT_FOUND 1: 1')
    const only = await go(testDb, [rel({ releasedByService: true })])
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: only.syncRunId } })).message).toContain('1 echo')
  })

  it('matches APVs ignoring case', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['ap-st045048'] })
    await run([rel({ apvNumbers: ['AP-ST045048'] })])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('RELEASED')
  })

  it('matches through CheckBill alone', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-ST045048', amount: '100.00' } })
    await run([rel()])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('RELEASED')
  })
})

describe('final review 2026-10-19', () => {
  const looks = () => testDb.auditLog.findMany({ where: { action: NEEDS_LOOK_ACTION }, orderBy: { createdAt: 'asc' } })

  it('I1: a check released by the read is never queued RELEASED by the backlog; another RELEASED check still is', async () => {
    const viaPortal = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const other = await makeCheck({ status: 'RELEASED', checkNumber: '6000354898', apvNumbers: ['AP-ST045049'], releasedAt: new Date('2026-10-10T02:00:00Z') })
    await run([rel()])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: viaPortal.id } })).status).toBe('RELEASED')
    const q = await queueReleasedForStale(testDb, { now: NOW, apply: true })
    expect(q.cheques.map((c) => c.id)).toEqual([other.id])
    expect(q.queued).toBe(1)
    expect(await testDb.portalEvent.count({ where: { checkId: viaPortal.id } })).toBe(0)
    expect(await testDb.portalEvent.count({ where: { checkId: other.id, kind: 'RELEASED' } })).toBe(1)
  })

  it('I2: each look item is one SYSTEM audit row, written once per release and kind', async () => {
    const dead = await makeCheck({ status: 'CANCELLED', checkNumber: '6000000002', apvNumbers: ['AP-2'] })
    const rows = [
      rel({ releaseId: 10, checkNumber: '6000000001', apvNumbers: ['AP-1'] }),
      rel({ releaseId: 11, domain: 'BROKER', checkNumber: '6000000002', apvNumbers: ['AP-2'] }),
    ]
    await run(rows)
    await run(rows)
    const kindOf = (x: { details: unknown }) => (x.details as { kind: string }).kind
    const xs = (await looks()).sort((p, q) => kindOf(p).localeCompare(kindOf(q)))
    expect(xs).toHaveLength(2)
    expect(xs.map((x) => [x.actorType, x.checkId, kindOf(x)])).toEqual([
      ['SYSTEM', dead.id, 'DEAD_HERE'], ['SYSTEM', null, 'NOT_FOUND'],
    ])
    expect(xs[0].details).toMatchObject({
      kind: 'DEAD_HERE', domain: 'BROKER', releaseId: 11, checkNumber: '6000000002', apvNumbers: ['AP-2'],
      releaseDate: '2026-10-19', releasedAt: '2026-10-19T02:30:00.000Z', orNumber: '4852', orDate: '2026-10-19', releasedByName: 'LUSIE',
    })
  })

  it('I2: a NOT_FOUND heals on a later run once the APV is linked, and leaves the open list', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-OTHER'] })
    const first = await run([rel()])
    expect(first.look.map((l) => l.kind)).toEqual(['NOT_FOUND'])
    expect((await listOpenPortalReleaseLooks(testDb)).map((l) => [l.kind, l.checkNumber])).toEqual([['NOT_FOUND', '6000354897']])
    await testDb.check.update({ where: { id: c.id }, data: { apvNumbers: ['AP-OTHER', 'AP-ST045048'] } })
    const second = await run([])
    expect(second).toMatchObject({ released: 1, healed: 1, errors: 0 })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'RELEASED', releasedAt: new Date('2026-10-19T02:30:00Z'), orNumber: '4852', receiptType: null, crNumber: null,
    })
    expect(await listOpenPortalReleaseLooks(testDb)).toEqual([])
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: second.syncRunId } })).message).toContain('1 earlier look item(s) released')
  })

  it('I2: the open list keeps the newest item per release, newest first, with what Finance needs', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })
    await run([rel({ releaseId: 20, checkNumber: '1791379613', apvNumbers: ['AP-NONE'] })])
    await makeCheck({ status: 'VOIDED', checkNumber: '6000000003', apvNumbers: ['AP-3'] })
    await run([rel({ releaseId: 21, checkNumber: '6000000003', apvNumbers: ['AP-3'] })])
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NONE'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NONE'] })
    await run([]) // re-evaluates release 20: now two checks pay AP-NONE
    const open = await listOpenPortalReleaseLooks(testDb)
    expect(open.map((l) => [l.kind, l.releaseId])).toEqual([['AMBIGUOUS', 20], ['DEAD_HERE', 21]])
    expect(open[0]).toMatchObject({ checkNumber: '1791379613', releaseDate: '2026-10-19', orNumber: '4852', releasedByName: 'LUSIE', domain: 'LOCAL' })
  })

  it('I3: a deadline reached after page 1 stops before page 2, watermark from page 1', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000011', apvNumbers: ['AP-11'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000013', apvNumbers: ['AP-13'] })
    const t1 = new Date('2026-10-19T03:00:00Z')
    const seen: Date[] = []
    const pages = [
      { rows: [rel({ releaseId: 1, checkNumber: '6000000011', apvNumbers: ['AP-11'], updatedAt: t1 })], next: t1 },
      { rows: [rel({ releaseId: 2, checkNumber: '6000000013', apvNumbers: ['AP-13'], updatedAt: new Date('2026-10-19T04:00:00Z') })], next: null },
    ]
    const r: PortalReleasesReader = { async list(since) { seen.push(since); return pages.shift()! } }
    const res = await runPortalReleasesSync(testDb, { reader: r, since: null, now: NOW, trigger: 'SCHEDULED', deadline: new Date(0) })
    expect(seen).toHaveLength(1)
    expect(res).toMatchObject({ read: 1, released: 1, stoppedAtDeadline: true, errors: 0, watermark: new Date('2026-10-19T02:50:00Z') })
    const row = await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })
    expect(row.message).toContain('stopped at the time budget')
    expect(row.watermark).toEqual(new Date('2026-10-19T02:50:00Z'))
  })

  it('I3: a deadline stops between rows of one page', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000011', apvNumbers: ['AP-11'] })
    const b = await makeCheck({ status: 'SIGNED', checkNumber: '6000000012', apvNumbers: ['AP-12'] })
    const res = await runPortalReleasesSync(testDb, {
      reader: reader([rel({ releaseId: 1, checkNumber: '6000000011', apvNumbers: ['AP-11'] }), rel({ releaseId: 2, checkNumber: '6000000012', apvNumbers: ['AP-12'] })]),
      since: null, now: NOW, trigger: 'SCHEDULED', deadline: new Date(0),
    })
    expect(res).toMatchObject({ read: 1, released: 1, stoppedAtDeadline: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SIGNED')
  })

  it('I4: a release from before go-live is never applied; listed BEFORE_GO_LIVE and not re-evaluated', async () => {
    const a = await makeCheck({ status: 'SIGNED', checkNumber: '6000000021', apvNumbers: ['AP-21'] })
    const b = await makeCheck({ status: 'SIGNED', checkNumber: '6000000022', apvNumbers: ['AP-22'] })
    const res = await run([
      rel({ releaseId: 1, checkNumber: '6000000021', apvNumbers: ['AP-21'], releasedAt: new Date('2026-10-18T10:00:00Z') }),
      rel({ releaseId: 2, checkNumber: '6000000022', apvNumbers: ['AP-22'], releasedAt: null, releaseDate: '2026-10-18' }),
      rel({ releaseId: 3, checkNumber: '6000000023', apvNumbers: ['AP-23'], releasedAt: new Date('2026-09-01T00:00:00Z') }),
    ])
    expect(res.released).toBe(0)
    expect(res.look.map((l) => l.kind)).toEqual(['BEFORE_GO_LIVE', 'BEFORE_GO_LIVE', 'BEFORE_GO_LIVE'])
    await run([])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SIGNED')
    expect((await looks()).map((x) => (x.details as { kind: string }).kind)).toEqual(['BEFORE_GO_LIVE', 'BEFORE_GO_LIVE', 'BEFORE_GO_LIVE'])
    // The first instant of go-live (00:00 Manila) is not before it.
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000000024', apvNumbers: ['AP-24'] })
    await run([rel({ releaseId: 4, checkNumber: '6000000024', apvNumbers: ['AP-24'], releasedAt: PORTAL_RELEASES_FIRST_SINCE })])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('RELEASED')
  })

  it('I5: an OR typed on the portal after the release reaches a RELEASED check with none, once', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await run([rel()])
    expect(res).toMatchObject({ already: 1, receipts: 1, released: 0 })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'RELEASED', orNumber: '4852', orDate: new Date('2026-10-19T00:00:00Z'), receiptType: null, crNumber: null,
    })
    const audits = await testDb.auditLog.findMany({ where: { checkId: c.id, action: RECEIPT_FROM_PORTAL_ACTION } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actorType: 'SYSTEM' })
    expect(audits[0].details).toMatchObject({ releaseId: 1, domain: 'LOCAL', orNumber: '4852' })
    const again = await run([rel({ orNumber: '9999' })])
    expect(again).toMatchObject({ already: 1, receipts: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).orNumber).toBe('4852')
    expect(await testDb.auditLog.count({ where: { action: RECEIPT_FROM_PORTAL_ACTION } })).toBe(1)
  })

  it('I5: a RELEASED check that has a receipt keeps it (rule 11)', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await testDb.check.update({ where: { id: c.id }, data: { orNumber: '1111', receiptType: 'CR' } })
    const res = await run([rel()])
    expect(res).toMatchObject({ already: 1, receipts: 0 })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ orNumber: '1111', receiptType: 'CR', crNumber: null })
    expect(await testDb.auditLog.count({ where: { action: RECEIPT_FROM_PORTAL_ACTION } })).toBe(0)
  })

  it('matching sets CANCELLED / VOIDED aside first: a live re-issue on the same number and APV is released', async () => {
    await makeCheck({ status: 'CANCELLED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const live = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await run([rel()])
    expect(res).toMatchObject({ released: 1, look: [] })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('RELEASED')
  })

  it('matching: dead + RELEASED is ALREADY; two dead are DEAD_HERE', async () => {
    await makeCheck({ status: 'VOIDED', checkNumber: '6000000031', apvNumbers: ['AP-31'] })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000031', apvNumbers: ['AP-31'] })
    await makeCheck({ status: 'VOIDED', checkNumber: '6000000032', apvNumbers: ['AP-32'] })
    await makeCheck({ status: 'CANCELLED', checkNumber: '6000000032', apvNumbers: ['AP-32'] })
    const res = await run([
      rel({ releaseId: 1, checkNumber: '6000000031', apvNumbers: ['AP-31'], orNumber: null }),
      rel({ releaseId: 2, checkNumber: '6000000032', apvNumbers: ['AP-32'] }),
    ])
    expect(res).toMatchObject({ already: 1, released: 0 })
    expect(res.look.map((l) => [l.kind, l.checkNumber])).toEqual([['DEAD_HERE', '6000000032']])
  })

  it('names rejected rows in the run message', async () => {
    const r: PortalReleasesReader = { async list() { return { rows: [], next: null, rejected: [{ releaseId: '12', domain: 'LOCAL' }] } } }
    const res = await runPortalReleasesSync(testDb, { reader: r, since: null, now: NOW, trigger: 'MANUAL' })
    expect(res.rejected).toEqual([{ releaseId: '12', domain: 'LOCAL' }])
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })).message).toContain('rejected 1: LOCAL#12')
  })

  it('runScheduledPortalReleases passes the deadline through', async () => {
    const seen: Date[] = []
    const pages = [{ rows: [rel({ checkNumber: '1', apvNumbers: ['AP-X'] })], next: new Date('2026-10-19T03:00:00Z') }, { rows: [], next: null }]
    const out = await runScheduledPortalReleases(testDb, {
      now: NOW, deadline: new Date(0), reader: () => ({ async list(since) { seen.push(since); return pages.shift()! } }),
    })
    expect(out).toMatchObject({ outcome: 'RAN' })
    expect(seen).toHaveLength(1)
  })
})

describe('final re-review 2026-10-19 (round 2)', () => {
  const closes = () => testDb.auditLog.findMany({ where: { action: LOOK_CLOSED_ACTION }, orderBy: { createdAt: 'asc' } })
  // A NOT_FOUND item for rel(): the check exists, paying another APV.
  async function notFound() {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-OTHER'] })
    const r = await run([rel()])
    expect(r.look.map((l) => l.kind)).toEqual(['NOT_FOUND'])
    const [item] = await listOpenPortalReleaseLooks(testDb)
    return { c, item }
  }
  const link = (id: string, data: object = {}) =>
    testDb.check.update({ where: { id }, data: { apvNumbers: ['AP-OTHER', 'AP-ST045048'], ...data } })

  it('A: a re-evaluated item already RELEASED here closes, with the check, and is not re-evaluated again', async () => {
    const { c } = await notFound()
    await link(c.id, { status: 'RELEASED', orNumber: '1111', receiptType: 'OR' })
    const second = await run([])
    expect(second).toMatchObject({ closed: 1, released: 0, errors: 0 })
    const [row] = await closes()
    expect(row).toMatchObject({ actorType: 'SYSTEM', checkId: c.id })
    expect(row.details).toMatchObject({ domain: 'LOCAL', releaseId: 1, outcome: 'ALREADY' })
    expect(await listOpenPortalReleaseLooks(testDb)).toEqual([])
    expect(await run([])).toMatchObject({ closed: 0 })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ orNumber: '1111', receiptType: 'OR' })
  })

  it('A: RECEIPT closes too (the portal OR taken onto a check released here with none)', async () => {
    const { c } = await notFound()
    await link(c.id, { status: 'RELEASED' })
    expect(await run([])).toMatchObject({ closed: 1, receipts: 1 })
    expect((await closes())[0].details).toMatchObject({ outcome: 'RECEIPT' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).orNumber).toBe('4852')
  })

  it('A: a dismissed item is neither listed nor re-evaluated, nor listed again by a re-read', async () => {
    const { c, item } = await notFound()
    const admin = await makeUser('FINANCE_ADMIN')
    expect(await dismissPortalReleaseLook(testDb, { lookId: item.id, reason: '  ', userId: admin.id })).toMatchObject({ ok: false })
    expect(await dismissPortalReleaseLook(testDb, { lookId: item.id, reason: 'paid by another check', userId: admin.id })).toEqual({ ok: true })
    const d = await testDb.auditLog.findFirstOrThrow({ where: { action: LOOK_DISMISSED_ACTION } })
    expect(d).toMatchObject({ actorType: 'USER', userId: admin.id })
    expect(d.details).toMatchObject({ domain: 'LOCAL', releaseId: 1, kind: 'NOT_FOUND', reason: 'paid by another check' })
    expect(await listOpenPortalReleaseLooks(testDb)).toEqual([])
    await link(c.id)
    expect(await run([])).toMatchObject({ released: 0, closed: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
    // The same release read again cannot reopen it: it would release now, but dismissal is about the list.
    await testDb.check.update({ where: { id: c.id }, data: { apvNumbers: ['AP-OTHER'] } })
    await run([rel()])
    expect(await testDb.auditLog.count({ where: { action: NEEDS_LOOK_ACTION } })).toBe(1)
    expect(await listOpenPortalReleaseLooks(testDb)).toEqual([])
    expect(await dismissPortalReleaseLook(testDb, { lookId: item.id, reason: 'again', userId: admin.id })).toMatchObject({ ok: false, message: 'That item is no longer open.' })
  })

  it('B: a portal release undone since it was listed is closed, not released', async () => {
    const { c } = await notFound()
    await link(c.id)
    portalNow.set('LOCAL:1', { status: 'AVAILABLE_FOR_RELEASE', releasedAt: null, orNumber: null })
    const r = await run([])
    expect(r).toMatchObject({ released: 0, closed: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
    expect((await closes())[0].details).toMatchObject({ outcome: 'NO_LONGER_RELEASED_ON_PORTAL', portalStatus: 'AVAILABLE_FOR_RELEASE' })
    expect(await listOpenPortalReleaseLooks(testDb)).toEqual([])
  })

  it('B: a release the portal no longer holds (status null) is closed too', async () => {
    const { c } = await notFound()
    await link(c.id)
    portalNow.set('LOCAL:1', { status: null })
    expect(await run([])).toMatchObject({ released: 0, closed: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
  })

  it('B: the release uses the portal CURRENT instant and OR, not the stored copy', async () => {
    const { c } = await notFound()
    await link(c.id)
    portalNow.set('LOCAL:1', { releasedAt: new Date('2026-10-20T03:00:00Z'), orNumber: '7777', orDate: '2026-10-20' })
    expect(await run([])).toMatchObject({ released: 1, healed: 1 })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'RELEASED', releasedAt: new Date('2026-10-20T03:00:00Z'), orNumber: '7777', orDate: new Date('2026-10-20T00:00:00Z'), crNumber: null,
    })
  })

  it('B: a failed status read skips re-evaluation, is not an error, and the watermark still moves', async () => {
    const { c } = await notFound()
    await link(c.id)
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000041', apvNumbers: ['AP-41'] })
    const r: PortalReleasesReader = {
      async list() { return { rows: [rel({ releaseId: 2, checkNumber: '6000000041', apvNumbers: ['AP-41'] })], next: null } },
      async statuses() { throw new Error('The Supplier Portal answered 502 to the releases status read: bad gateway') },
    }
    const res = await runPortalReleasesSync(testDb, { reader: r, since: null, now: NOW, trigger: 'MANUAL' })
    expect(res).toMatchObject({ released: 1, errors: 0, reevalErrors: 0, watermark: new Date('2026-10-19T02:20:05Z') })
    expect(res.reevalSkipped).toContain('status read failed')
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })).message).toContain('re-evaluation skipped: the portal status read failed')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
    expect(await listOpenPortalReleaseLooks(testDb)).toHaveLength(1)
  })

  it('a failure while re-evaluating is counted apart, named in the message, and never holds the watermark', async () => {
    const { c } = await notFound()
    await link(c.id)
    const k = await makeCheck({ status: 'RELEASED', checkNumber: '6000000042', apvNumbers: ['AP-42'] })
    await testDb.check.update({ where: { id: k.id }, data: { orNumber: '1', receiptType: 'OR' } })
    // Every transaction fails: only the re-evaluated release needs one (the page row is ALREADY).
    const bad = new Proxy(testDb, {
      get(t, p, rcv) {
        if (p === '$transaction') return async () => { throw new Error('boom') }
        const v = Reflect.get(t, p, rcv)
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as typeof testDb
    const res = await runPortalReleasesSync(bad, {
      reader: { ...reader([rel({ releaseId: 3, checkNumber: '6000000042', apvNumbers: ['AP-42'] })]) }, since: null, now: NOW, trigger: 'MANUAL',
    })
    expect(res).toMatchObject({ errors: 0, reevalErrors: 1, already: 1, watermark: new Date('2026-10-19T02:20:05Z') })
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })).message).toContain('re-evaluation errors 1')
  })

  it('timeouts: min(15 s, time left); no new page and no status call within 5 s of the deadline', async () => {
    const asked: (number | undefined)[] = []
    let statusCalls = 0
    await notFound()
    const t1 = new Date('2026-10-19T03:00:00Z')
    const r: PortalReleasesReader = {
      async list(_s, _l, o) { asked.push(o?.timeoutMs); return { rows: [rel({ releaseId: 9, checkNumber: '9', apvNumbers: ['AP-9'], updatedAt: t1 })], next: t1 } },
      async statuses() { statusCalls++; return [] },
    }
    const res = await runPortalReleasesSync(testDb, { reader: r, since: null, now: NOW, trigger: 'SCHEDULED', deadline: new Date(Date.now() + 3_000) })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toBeLessThanOrEqual(3_000)
    expect(res.stoppedAtDeadline).toBe(true)
    expect(statusCalls).toBe(0)
    const free = await runPortalReleasesSync(testDb, {
      reader: { ...r, async list(_s, _l, o) { asked.push(o?.timeoutMs); return { rows: [], next: null } } }, since: null, now: NOW, trigger: 'MANUAL',
    })
    expect(asked[1]).toBe(15_000)
    expect(free.reevalSkipped).toBeNull()
    expect(statusCalls).toBe(1)
  })
})
