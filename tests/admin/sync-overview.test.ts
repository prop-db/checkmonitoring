import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { getSyncOverview, SYNC_TENANTS } from '@/lib/admin/sync-overview'

beforeEach(resetDb)

const run = (o: {
  tenant?: string | null
  startedAt: string
  finishedAt?: string | null
  errors?: number
  imported?: number
  updated?: number
  staged?: number
}) =>
  testDb.syncRun.create({
    data: {
      mode: 'INCREMENTAL',
      tenant: o.tenant === undefined ? 'GOLIVE' : o.tenant,
      startedAt: new Date(o.startedAt),
      finishedAt: o.finishedAt === undefined ? new Date(o.startedAt) : o.finishedAt ? new Date(o.finishedAt) : null,
      errors: o.errors ?? 0,
      imported: o.imported ?? 0,
      updated: o.updated ?? 0,
      staged: o.staged ?? 0,
    },
  })

const forTenant = (o: Awaited<ReturnType<typeof getSyncOverview>>, tenant: string) =>
  o.tenants.find((t) => t.tenant === tenant)!

describe('getSyncOverview', () => {
  it('lists both tenants even when neither has ever run', async () => {
    const overview = await getSyncOverview(testDb)
    expect(overview.tenants.map((t) => t.tenant)).toEqual([...SYNC_TENANTS])
    expect(forTenant(overview, 'GOLIVE').lastAttempt).toBeNull()
    expect(forTenant(overview, 'GOLIVE').lastSuccess).toBeNull()
  })

  it('never pools the two tenants', async () => {
    // The whole reason `SyncRun.tenant` exists: the two Acumatica tenants reuse
    // branch codes for different companies, so a "last sync" across both is a
    // figure about nothing.
    await run({ tenant: 'GOLIVE', startedAt: '2026-09-04T10:45:00Z', imported: 24 })
    const overview = await getSyncOverview(testDb)
    expect(forTenant(overview, 'GOLIVE').lastAttempt?.imported).toBe(24)
    expect(forTenant(overview, 'MANUFACTURING').lastAttempt).toBeNull()
  })

  it('reports the most recent attempt whatever came of it', async () => {
    await run({ startedAt: '2026-09-04T08:00:00Z', imported: 24 })
    await run({ startedAt: '2026-09-04T10:00:00Z', errors: 3 })
    const t = forTenant(await getSyncOverview(testDb), 'GOLIVE')
    expect(t.lastAttempt?.errors).toBe(3)
    // A failed attempt must not be able to masquerade as the last good one.
    expect(t.lastSuccess?.imported).toBe(24)
  })

  it('does not count an unfinished run as a success', async () => {
    // `runSync` writes the row before it reads the feed, so a null finishedAt
    // is a run still going or one whose process died.
    await run({ startedAt: '2026-09-04T11:00:00Z', finishedAt: null })
    const t = forTenant(await getSyncOverview(testDb), 'GOLIVE')
    expect(t.lastSuccess).toBeNull()
    expect(t.inFlight).toBe(true)
  })

  it('takes the abandoned threshold as a parameter', async () => {
    await run({ startedAt: '2026-09-12T08:00:00Z', finishedAt: null })
    const now = new Date('2026-09-12T08:30:00Z')
    expect(forTenant(await getSyncOverview(testDb, now), 'GOLIVE').abandoned).toBe(false)
    expect(forTenant(await getSyncOverview(testDb, now, 20), 'GOLIVE').abandoned).toBe(true)
  })

  it('does not report a newer BILLS run as the tenant’s last attempt — that panel is the payment feed', async () => {
    await run({ startedAt: '2026-09-04T08:00:00Z', imported: 24 })
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-04T10:00:00Z'), finishedAt: new Date('2026-09-04T10:00:01Z'), imported: 7 },
    })
    const t = forTenant(await getSyncOverview(testDb), 'GOLIVE')
    expect(t.lastAttempt?.imported).toBe(24)
    expect(t.lastSuccess?.imported).toBe(24)
  })

  it('does not report a newer BILL_REFS run as the tenant’s last attempt — that panel is the payment feed', async () => {
    await run({ startedAt: '2026-09-04T08:00:00Z', imported: 24 })
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date('2026-09-04T10:00:00Z'), finishedAt: null, imported: 7 },
    })
    const t = forTenant(await getSyncOverview(testDb), 'GOLIVE')
    expect(t.lastAttempt?.imported).toBe(24)
    expect(t.lastSuccess?.imported).toBe(24)
    expect(t.inFlight).toBe(false)
  })

  it('surfaces runs recorded before the tenant column existed rather than hiding them', async () => {
    await run({ tenant: null, startedAt: '2026-09-01T10:00:00Z' })
    const overview = await getSyncOverview(testDb)
    expect(overview.untenantedRuns).toBe(1)
    expect(forTenant(overview, 'GOLIVE').lastAttempt).toBeNull()
  })
})
