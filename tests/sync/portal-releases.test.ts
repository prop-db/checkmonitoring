import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  runPortalReleasesSync, lastPortalReleasesWatermark, runScheduledPortalReleases,
  RELEASED_ON_PORTAL_ACTION, PORTAL_RELEASES_FIRST_SINCE,
} from '@/lib/sync/portal-releases'
import type { PortalRelease, PortalReleasesReader } from '@/lib/integrations/portal/releases'

const NOW = new Date('2026-10-19T12:00:00+08:00')
beforeEach(resetDb)

const rel = (o: Partial<PortalRelease> = {}): PortalRelease => ({
  domain: 'LOCAL', releaseId: 1, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'],
  releaseDate: '2026-10-19', releasedAt: new Date('2026-10-19T02:30:00Z'), orNumber: '4852', orDate: '2026-10-19',
  releasedByName: 'LUSIE', releasedByService: false, updatedAt: new Date('2026-10-19T02:30:05Z'), ...o,
})
function reader(rows: PortalRelease[], seen: Date[] = []): PortalReleasesReader {
  return { async list(since) { seen.push(since); return { rows, next: null } } }
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
