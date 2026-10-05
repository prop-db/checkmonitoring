import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { runBillRefsSync, lastBillRefsWatermark, runScheduledBillRefsSync, recordBillRefsTimeBudgetSkip, BILL_REFS_MODE, NO_BILL_REFS_WATERMARK_MESSAGE } from '@/lib/sync/bill-refs'
import { SyncInProgressError, SYNC_OVERLAP_MINUTES } from '@/lib/sync/run'
import {
  BILL_REFS_FEED, billRefsSinceFilter, billRefsInScopeFilter,
} from '@/lib/integrations/acumatica/bill-refs'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import type {
  AcumaticaClient, AcumaticaRow, FetchAllOptions, PageOptions,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-10-05T18:00:00+08:00')

beforeEach(resetDb)

// Reference data, not a record (rule 7 untouched): no audit row, and nothing
// here may tell a supplier anything.
afterEach(async () => {
  expect(await testDb.auditLog.count()).toBe(0)
  expect(await testDb.portalEvent.count()).toBe(0)
})

type FeedCall = { feed: string; opts: FetchAllOptions | undefined }

function fakeFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: FeedCall[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      if (feed !== BILL_REFS_FEED) throw new Error(`unexpected feed ${feed}`)
      return [...rows]
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('runBillRefsSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/** One row of AP-Bills and Adjustments. */
const docRow = (o: Record<string, unknown> = {}): AcumaticaRow => ({
  Type: 'Bill',
  ReferenceNbr: 'AP-ST044591',
  Date: '2026-09-29T00:00:00',
  VendorRef: 'PO-ST-031109',
  LastModifiedOn: '2026-09-29T08:15:00',
  ...o,
})

const read = (
  rows: readonly AcumaticaRow[],
  opts: { since?: Date | null; failWith?: Error; tenant?: AcumaticaTenant; db?: typeof testDb } = {},
) => {
  const { client, calls } = fakeFeed(rows, opts.failWith)
  return {
    calls,
    result: runBillRefsSync(opts.db ?? testDb, {
      client, tenant: opts.tenant ?? 'GOLIVE', since: opts.since ?? null, now: NOW, trigger: 'MANUAL',
    }),
  }
}

const stored = () => testDb.acumaticaBill.findMany({ orderBy: { apvNumber: 'asc' } })

describe('runBillRefsSync — the table', () => {
  it('stores one row per Bill whose VendorRef names a PO, keyed by the upper-cased APV', async () => {
    const result = await read([
      docRow({ ReferenceNbr: ' ap-st044591 ', VendorRef: 'PO-A1-012345 / po-a1-012346.' }),
      docRow({ ReferenceNbr: 'AP-ST044592', VendorRef: 'PO-ST-031109', LastModifiedOn: '2026-09-29T09:00:00' }),
    ]).result
    expect((await stored()).map((b) => ({ ...b, updatedAt: undefined }))).toEqual([
      {
        apvNumber: 'AP-ST044591', tenant: 'GOLIVE', vendorRef: 'PO-A1-012345 / po-a1-012346.',
        poNumbers: ['PO-A1-012345', 'PO-A1-012346'], lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
        updatedAt: undefined,
      },
      {
        apvNumber: 'AP-ST044592', tenant: 'GOLIVE', vendorRef: 'PO-ST-031109',
        poNumbers: ['PO-ST-031109'], lastModifiedOn: new Date('2026-09-29T09:00:00Z'),
        updatedAt: undefined,
      },
    ])
    expect(result).toMatchObject({ fetched: 2, ignored: 0, withPo: 2, upserted: 2, deleted: 0, noPo: 0, errors: 0 })
  })

  it('one column map serves MANUFACTURING', async () => {
    await read([docRow({ ReferenceNbr: 'A1PP-AP-000014', VendorRef: 'A1PP-PO-000123' })], { tenant: 'MANUFACTURING' }).result
    expect(await stored()).toMatchObject([{ apvNumber: 'A1PP-AP-000014', tenant: 'MANUFACTURING', poNumbers: ['A1PP-PO-000123'] }])
  })

  it('writes nothing for a VendorRef that is not a PO and counts it; an empty VendorRef is not counted', async () => {
    const result = await read([
      docRow({ ReferenceNbr: 'AP-1', VendorRef: 'SI#1659' }),
      docRow({ ReferenceNbr: 'AP-2', VendorRef: '26X06-0267A' }),
      docRow({ ReferenceNbr: 'AP-3', VendorRef: null }),
    ]).result
    expect(await stored()).toEqual([])
    expect(result).toMatchObject({ withPo: 0, upserted: 0, noPo: 2, deleted: 0 })
  })

  it('deletes a row whose VendorRef no longer names a PO — this tenant’s rows only', async () => {
    await testDb.acumaticaBill.createMany({
      data: [
        { apvNumber: 'AP-ST044591', tenant: 'GOLIVE', vendorRef: 'PO-ST-031109', poNumbers: ['PO-ST-031109'] },
        { apvNumber: 'AP-ST044592', tenant: 'MANUFACTURING', vendorRef: 'PO-ST-031110', poNumbers: ['PO-ST-031110'] },
      ],
    })
    const result = await read([
      docRow({ ReferenceNbr: 'AP-ST044591', VendorRef: 'SI#1659' }),
      docRow({ ReferenceNbr: 'AP-ST044592', VendorRef: 'SI#1660' }),
    ]).result
    expect((await stored()).map((b) => b.apvNumber)).toEqual(['AP-ST044592'])
    expect(result.deleted).toBe(1)
  })

  it('rewrites a row whose PO changed, and a second identical read writes nothing', async () => {
    await read([docRow({ VendorRef: 'PO-ST-031109' })]).result
    const changed = await read([docRow({ VendorRef: 'PO-ST-031150', LastModifiedOn: '2026-09-30T08:00:00' })]).result
    expect(changed.upserted).toBe(1)
    expect((await stored())[0].poNumbers).toEqual(['PO-ST-031150'])

    const before = (await stored())[0].updatedAt
    const again = await read([docRow({ VendorRef: 'PO-ST-031150', LastModifiedOn: '2026-09-30T08:00:00' })]).result
    expect(again.upserted).toBe(0)
    expect((await stored())[0].updatedAt).toEqual(before)
  })

  it('the latest row of an APV in one read wins', async () => {
    const result = await read([
      docRow({ VendorRef: 'PO-ST-000001', LastModifiedOn: '2026-09-29T08:00:00' }),
      docRow({ VendorRef: 'PO-ST-000002', LastModifiedOn: '2026-09-29T09:00:00' }),
    ]).result
    expect((await stored()).map((b) => b.poNumbers)).toEqual([['PO-ST-000002']])
    expect(result.upserted).toBe(1)
  })

  it('ignores other types, pre-2026 bills and rows with no reference — but their date still advances the watermark', async () => {
    const result = await read([
      docRow({ Type: 'Debit Adj.', LastModifiedOn: '2026-09-30T12:00:00' }),
      docRow({ ReferenceNbr: 'AP-OLD', Date: '2025-12-31T00:00:00' }),
      docRow({ ReferenceNbr: '  ' }),
    ]).result
    expect(await stored()).toEqual([])
    expect(result).toMatchObject({ fetched: 3, ignored: 3, upserted: 0 })
    expect(result.watermark).toEqual(
      new Date(new Date('2026-09-30T12:00:00Z').getTime() - SYNC_OVERLAP_MINUTES * 60_000),
    )
  })
})

describe('runBillRefsSync — the run record', () => {
  it('records mode BILL_REFS, the counts, watermark = max − 120 min, finishedAt, no message', async () => {
    await testDb.acumaticaBill.create({
      data: { apvNumber: 'AP-GONE', tenant: 'GOLIVE', vendorRef: 'PO-ST-000009', poNumbers: ['PO-ST-000009'] },
    })
    const result = await read([
      docRow({ ReferenceNbr: 'AP-1', LastModifiedOn: '2026-09-29T08:15:00' }),
      docRow({ ReferenceNbr: 'AP-GONE', VendorRef: 'SI#1', LastModifiedOn: '2026-09-29T09:00:00' }),
      docRow({ ReferenceNbr: 'AP-3', VendorRef: 'free text', LastModifiedOn: '2026-09-29T07:00:00' }),
    ]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.mode).toBe(BILL_REFS_MODE)
    expect(run.mode).toBe('BILL_REFS')
    expect(run.tenant).toBe('GOLIVE')
    expect(run.trigger).toBe('MANUAL')
    expect(run.startedAt).toEqual(NOW)
    expect(run.finishedAt).not.toBeNull()
    expect(run.imported).toBe(1)
    expect(run.updated).toBe(1)
    expect(run.staged).toBe(2)
    expect(run.errors).toBe(0)
    expect(run.message).toBeNull()
    expect(run.watermark).toEqual(new Date('2026-09-29T07:00:00Z'))
  })

  it('incremental: filters on LastModifiedOn from the watermark; a first read on Date from 2026', async () => {
    const since = new Date('2026-09-28T00:00:00Z')
    const a = read([], { since })
    await a.result
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0].feed).toBe(BILL_REFS_FEED)
    expect(a.calls[0].opts?.filter).toBe(billRefsSinceFilter(since))
    expect(a.calls[0].opts?.orderby).toBe('LastModifiedOn asc')
    expect(a.calls[0].opts?.select).toEqual(['Type', 'ReferenceNbr', 'Date', 'VendorRef', 'LastModifiedOn'])

    const b = read([])
    await b.result
    expect(b.calls[0].opts?.filter).toBe(billRefsInScopeFilter())
    expect((await b.result).watermark).toBeNull()
  })

  it('a fetch failure leaves the run finished with errors 1, watermark null, and rethrows', async () => {
    const boom = new Error('inquiry down')
    await expect(read([], { failWith: boom }).result).rejects.toBe(boom)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILL_REFS' } })
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toContain('inquiry down')
  })

  it('a failed write is an error, the other writes still land, and the watermark is held', async () => {
    await testDb.acumaticaBill.create({
      data: { apvNumber: 'AP-STALE', tenant: 'GOLIVE', vendorRef: 'PO-ST-000009', poNumbers: ['PO-ST-000009'] },
    })
    let calls = 0
    // The first raw write (the upsert batch) throws; the delete batch is real.
    const flaky = new Proxy(testDb, {
      get(target, prop, receiver) {
        if (prop === '$executeRaw') {
          return (...a: unknown[]) => {
            calls++
            if (calls === 1) return Promise.reject(new Error('write refused for the first batch'))
            return (target.$executeRaw as (...x: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const result = await read([
      docRow({ ReferenceNbr: 'AP-ST044591' }),
      docRow({ ReferenceNbr: 'AP-STALE', VendorRef: 'SI#1' }),
    ], { db: flaky }).result
    expect(result.errors).toBe(1)
    expect(result.upserted).toBe(0)
    expect(result.deleted).toBe(1)
    expect(await stored()).toEqual([])
    expect(result.watermark).toBeNull()
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.watermark).toBeNull()
    expect(run.message).toContain('write refused for the first batch')
    expect(run.message).toContain('AP-ST044591')
  })
})

describe('runBillRefsSync — one run at a time', () => {
  const unfinished = (mode: string, minutesAgo: number) =>
    testDb.syncRun.create({
      data: { mode, tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - minutesAgo * 60_000), finishedAt: null },
    })

  it('refuses while a BILL_REFS run younger than the setting is unfinished', async () => {
    await unfinished('BILL_REFS', 5)
    await expect(read([docRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
    expect(await testDb.syncRun.count()).toBe(1)
  })

  it('is not blocked by an unfinished payment or BILLS run', async () => {
    await unfinished('INCREMENTAL', 5)
    await unfinished('BILLS', 5)
    const result = await read([]).result
    expect(result.errors).toBe(0)
  })
})

describe('lastBillRefsWatermark', () => {
  it('returns the newest BILL_REFS watermark and ignores payment and BILLS runs', async () => {
    const at = (mode: string, day: string) =>
      testDb.syncRun.create({
        data: {
          mode, tenant: 'GOLIVE',
          startedAt: new Date(`${day}T10:00:00Z`), finishedAt: new Date(`${day}T10:00:01Z`),
          watermark: new Date(`${day}T08:00:00Z`),
        },
      })
    await at('BILL_REFS', '2026-09-29')
    await at('BILL_REFS', '2026-09-30')
    await at('BILLS', '2026-10-01')
    await at('INCREMENTAL', '2026-10-02')
    expect(await lastBillRefsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-30T08:00:00Z'))
    expect(await lastBillRefsWatermark(testDb, 'MANUFACTURING')).toBeNull()
  })
})

describe('runScheduledBillRefsSync', () => {
  const refsWatermark = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
    testDb.syncRun.create({
      data: {
        mode: 'BILL_REFS', tenant, trigger: 'MANUAL',
        startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'),
        watermark: new Date('2026-09-29T08:00:00Z'),
      },
    })

  it('refuses without a BILL_REFS watermark and records a finished BILL_REFS row saying so', async () => {
    // Neither a payment nor a BILLS watermark is a BILL_REFS watermark.
    await testDb.syncRun.create({ data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: NOW, finishedAt: NOW, watermark: NOW } })
    await testDb.syncRun.create({ data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: NOW, finishedAt: NOW, watermark: NOW } })
    let built = 0
    const outcome = await runScheduledBillRefsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { built++; return fakeFeed([]).client },
    })
    expect(built).toBe(0)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILL_REFS' } })
    expect(outcome).toEqual({ tenant: 'GOLIVE', outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id })
    expect(run.trigger).toBe('SCHEDULED')
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toBe(NO_BILL_REFS_WATERMARK_MESSAGE)
  })

  it('a client factory that throws is FAILED, never a throw', async () => {
    await refsWatermark('GOLIVE')
    const outcome = await runScheduledBillRefsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { throw new Error('x'.repeat(400)) },
    })
    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome !== 'FAILED') throw new Error('unreachable')
    expect(outcome.message.length).toBe(300)
  })

  it('with a watermark, RAN with the counts, as SCHEDULED, from that watermark', async () => {
    await refsWatermark('GOLIVE')
    const feed = fakeFeed([docRow(), docRow({ ReferenceNbr: 'AP-2', VendorRef: 'SI#1' })])
    const outcome = await runScheduledBillRefsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })
    expect(outcome).toMatchObject({
      tenant: 'GOLIVE', outcome: 'RAN', fetched: 2, ignored: 0, upserted: 1, deleted: 0, noPo: 1, errors: 0,
    })
    expect(feed.calls[0].opts?.filter).toBe(billRefsSinceFilter(new Date('2026-09-29T08:00:00Z')))
    if (outcome.outcome !== 'RAN') throw new Error('unreachable')
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: outcome.syncRunId } })).trigger).toBe('SCHEDULED')
  })

  it('a BILL_REFS run already in progress is IN_PROGRESS, not FAILED', async () => {
    await refsWatermark('GOLIVE')
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - 60_000), finishedAt: null },
    })
    const outcome = await runScheduledBillRefsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => fakeFeed([]).client })
    expect(outcome.outcome).toBe('IN_PROGRESS')
  })
})

describe('recordBillRefsTimeBudgetSkip', () => {
  it('records a finished SCHEDULED BILL_REFS row with no errors and no watermark, saying how long the run had taken', async () => {
    await testDb.syncRun.create({
      data: {
        mode: 'BILL_REFS', tenant: 'GOLIVE', trigger: 'MANUAL',
        startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'),
        watermark: new Date('2026-09-29T08:00:00Z'),
      },
    })
    const outcome = await recordBillRefsTimeBudgetSkip(testDb, { tenant: 'GOLIVE', now: NOW, elapsedMs: 21_400 })
    expect(outcome.outcome).toBe('SKIPPED_TIME_BUDGET')
    if (outcome.outcome !== 'SKIPPED_TIME_BUDGET' || outcome.syncRunId === null) throw new Error('unreachable')
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: outcome.syncRunId } })
    expect(run).toMatchObject({
      mode: 'BILL_REFS', tenant: 'GOLIVE', trigger: 'SCHEDULED', startedAt: NOW, errors: 0, watermark: null,
      message: 'skipped: the run had used 21 s of its budget before the PO read; the next run catches up',
    })
    expect(run.finishedAt).not.toBeNull()
    // The skip moves nothing: the next run reads from the previous watermark.
    expect(await lastBillRefsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-29T08:00:00Z'))
  })
})
