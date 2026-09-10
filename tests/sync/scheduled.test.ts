import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { runScheduledSync, NO_WATERMARK_MESSAGE } from '@/lib/sync/scheduled'
import {
  PAYMENTS_FEED, type AcumaticaClient, type AcumaticaRow,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-09-11T10:00:00Z')

beforeEach(resetDb)

// The schedule is the path most likely to grow a portal call by accident: it
// runs unattended. Asserted after every test, as tests/sync/run.test.ts does.
afterEach(async () => {
  expect(await testDb.portalEvent.count()).toBe(0)
})

/** A client that records whether it was asked for anything. */
function fakeClient(rows: readonly AcumaticaRow[] = [], failWith?: Error) {
  const calls: string[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed) {
      calls.push(feed)
      if (failWith) throw failWith
      return [...rows]
    },
    async fetchPage() {
      throw new Error('not used')
    },
  }
  return { client, calls }
}

const watermarked = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
  testDb.syncRun.create({
    data: {
      mode: 'INCREMENTAL', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })

describe('runScheduledSync', () => {
  /**
   * The first FULL sync of GOLIVE was killed by Vercel's timeout after ~29
   * minutes. A schedule must never take that path: no watermark means record
   * the refusal where an admin will see it and call nothing.
   */
  it('refuses to run FULL: no watermark means a recorded refusal and no fetch', async () => {
    const feed = fakeClient()
    const outcome = await runScheduledSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })

    expect(outcome.outcome).toBe('REFUSED_NO_WATERMARK')
    expect(feed.calls).toEqual([])

    const rows = await testDb.syncRun.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].tenant).toBe('GOLIVE')
    expect(rows[0].trigger).toBe('SCHEDULED')
    expect(rows[0].errors).toBe(1)
    expect(rows[0].finishedAt).not.toBeNull()
    expect(rows[0].message).toBe(NO_WATERMARK_MESSAGE)
  })

  it('runs an incremental read, recorded as SCHEDULED, when a watermark exists', async () => {
    await watermarked('GOLIVE')
    const feed = fakeClient()
    const outcome = await runScheduledSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })

    expect(outcome.outcome).toBe('RAN')
    expect(feed.calls).toEqual([PAYMENTS_FEED])

    const run = await testDb.syncRun.findFirstOrThrow({ where: { startedAt: NOW } })
    expect(run.mode).toBe('INCREMENTAL')
    expect(run.trigger).toBe('SCHEDULED')
  })

  it('reports a feed failure as FAILED and leaves the recorded row behind', async () => {
    await watermarked('MANUFACTURING')
    const feed = fakeClient([], new Error('HTTP 503 from the feed'))
    const outcome = await runScheduledSync(testDb, { tenant: 'MANUFACTURING', now: NOW, client: () => feed.client })

    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome === 'FAILED') expect(outcome.message).toContain('503')
    const run = await testDb.syncRun.findFirstOrThrow({ where: { startedAt: NOW } })
    expect(run.errors).toBe(1)
    expect(run.finishedAt).not.toBeNull()
  })

  it('reports a run already in progress as IN_PROGRESS, not as a failure', async () => {
    await watermarked('GOLIVE')
    await testDb.syncRun.create({
      data: {
        mode: 'INCREMENTAL', tenant: 'GOLIVE', trigger: 'MANUAL',
        startedAt: new Date(NOW.getTime() - 2 * 60_000), finishedAt: null,
      },
    })
    const feed = fakeClient()
    const outcome = await runScheduledSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })
    expect(outcome.outcome).toBe('IN_PROGRESS')
    expect(feed.calls).toEqual([])
  })

  it('turns a client that cannot be built into that tenant FAILED', async () => {
    await watermarked('GOLIVE')
    const outcome = await runScheduledSync(testDb, {
      tenant: 'GOLIVE', now: NOW,
      client: () => { throw new Error('ACUMATICA_ODATA_URL is not set') },
    })
    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome === 'FAILED') expect(outcome.message).toContain('ACUMATICA_ODATA_URL')
  })
})
