import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  runBillsSync, lastBillsWatermark, runScheduledBillsSync,
  BILLS_MODE, VOUCHER_LINKED_ACTION, NO_BILLS_WATERMARK_MESSAGE,
} from '@/lib/sync/bills'
import { SyncInProgressError, SYNC_OVERLAP_MINUTES } from '@/lib/sync/run'
import {
  BILLS_FEED, billsSinceFilter, billsInScopeFilter,
} from '@/lib/integrations/acumatica/bills'
import type {
  AcumaticaClient, AcumaticaRow, FetchAllOptions, PageOptions,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-10-01T18:00:00+08:00')

beforeEach(resetDb)

// The voucher read changes a cheque's data, never tells a supplier anything.
afterEach(async () => {
  expect(await testDb.portalEvent.count()).toBe(0)
})

type FeedCall = { feed: string; opts: FetchAllOptions | undefined }

/** Records what it was asked for and returns the given rows for BILLS_FEED. */
function fakeBillsFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: FeedCall[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      if (feed !== BILLS_FEED) throw new Error(`unexpected feed ${feed}`)
      return [...rows]
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('runBillsSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/** One Go-Live row of AP-PAYMENTS-WITH-BILLS. */
const billRow = (o: Record<string, unknown> = {}): AcumaticaRow => ({
  AdjgDocType: 'CHK',
  AdjgRefNbr: 'CV-ST012345',
  AdjdDocType: 'Bill',
  AdjdRefNbr: 'AP-ST000001',
  LastModifiedOn: '2026-09-29T08:15:00',
  ...o,
})

const bills = (
  rows: readonly AcumaticaRow[],
  opts: { since?: Date | null; failWith?: Error } = {},
) => {
  const { client, calls } = fakeBillsFeed(rows, opts.failWith)
  return {
    calls,
    result: runBillsSync(testDb, {
      client,
      tenant: 'GOLIVE',
      since: opts.since ?? null,
      now: NOW,
      trigger: 'MANUAL',
    }),
  }
}

async function heldCheque(paymentRef: string, extra: Parameters<typeof makeCheck>[0] = {}) {
  const c = await makeCheck(extra)
  return testDb.check.update({ where: { id: c.id }, data: { acumaticaPaymentId: paymentRef } })
}

describe('runBillsSync — linking vouchers', () => {
  it('links two vouchers to the cheque whose acumaticaPaymentId matches, sorted, with one audit row', async () => {
    const c = await heldCheque('CV-ST012345')
    const other = await heldCheque('CV-ST099999')
    const result = await bills([
      billRow({ AdjdRefNbr: 'AP-ST000002' }),
      billRow({ AdjdRefNbr: 'AP-ST000001' }),
    ]).result

    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.apvNumbers).toEqual(['AP-ST000001', 'AP-ST000002'])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).apvNumbers).toEqual([])

    const audits = await testDb.auditLog.findMany({ where: { action: VOUCHER_LINKED_ACTION } })
    expect(audits).toHaveLength(1)
    expect(audits[0].checkId).toBe(c.id)
    expect(audits[0].actorType).toBe('SYSTEM')
    expect((audits[0].details as { vouchers: string[] }).vouchers).toEqual(['AP-ST000001', 'AP-ST000002'])
    expect(result.vouchersAdded).toBe(2)
    expect(result.chequesChanged).toBe(1)
  })

  it('keeps vouchers already present and never removes one; a second identical run writes nothing', async () => {
    const c = await heldCheque('CV-ST012345', { apvNumbers: ['AP-OLD'] })
    await bills([billRow({ AdjdRefNbr: 'AP-NEW' })]).result
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-OLD', 'AP-NEW'])
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(1)

    const second = await bills([billRow({ AdjdRefNbr: 'AP-NEW' })]).result
    expect(second.vouchersAdded).toBe(0)
    expect(second.chequesChanged).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual(['AP-OLD', 'AP-NEW'])
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(1)
  })

  it('never writes status and creates no PortalEvent', async () => {
    const c = await heldCheque('CV-ST012345', { status: 'SIGNATURE_PENDING' })
    await bills([billRow()]).result
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(after.apvNumbers).toEqual(['AP-ST000001'])
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  it('ignores VCK and Debit Adj. rows, links nothing from them, but their date still advances the watermark', async () => {
    const c = await heldCheque('CV-ST012345')
    const result = await bills([
      billRow({ AdjgDocType: 'VCK', LastModifiedOn: '2026-09-30T10:00:00' }),
      billRow({ AdjdDocType: 'Debit Adj.', LastModifiedOn: '2026-09-30T12:00:00' }),
    ]).result
    expect(result.fetched).toBe(2)
    expect(result.ignored).toBe(2)
    expect(result.vouchersAdded).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).apvNumbers).toEqual([])
    expect(result.watermark).toEqual(
      new Date(new Date('2026-09-30T12:00:00Z').getTime() - SYNC_OVERLAP_MINUTES * 60_000),
    )
  })

  it('counts a payment ref this system does not hold as notHeld and writes nothing', async () => {
    const result = await bills([
      billRow({ AdjgRefNbr: 'CV-NOTHERE', AdjdRefNbr: 'AP-1' }),
      billRow({ AdjgRefNbr: 'CV-NOTHERE', AdjdRefNbr: 'AP-2' }),
    ]).result
    expect(result.notHeld).toBe(1)
    expect(result.chequesChanged).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })
})

describe('runBillsSync — the run record', () => {
  it('records mode BILLS, the counts, watermark = max − 120 min and finishedAt', async () => {
    await heldCheque('CV-ST012345')
    const result = await bills([
      billRow({ AdjdRefNbr: 'AP-ST000001', LastModifiedOn: '2026-09-29T08:15:00' }),
      billRow({ AdjdRefNbr: 'AP-ST000002', LastModifiedOn: '2026-09-29T09:00:00' }),
      billRow({ AdjgRefNbr: 'CV-NOTHERE', LastModifiedOn: '2026-09-29T07:00:00' }),
    ]).result

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.mode).toBe(BILLS_MODE)
    expect(run.mode).toBe('BILLS')
    expect(run.tenant).toBe('GOLIVE')
    expect(run.trigger).toBe('MANUAL')
    expect(run.startedAt).toEqual(NOW)
    expect(run.finishedAt).not.toBeNull()
    expect(run.imported).toBe(2)
    expect(run.updated).toBe(1)
    expect(run.staged).toBe(1)
    expect(run.errors).toBe(0)
    // The one payment not held here is named, so a later full re-read can link it.
    expect(run.message).toContain('CV-NOTHERE')
    expect(run.watermark).toEqual(new Date('2026-09-29T07:00:00Z'))
  })

  it('names every payment ref not held here in the message', async () => {
    const result = await bills([
      billRow({ AdjgRefNbr: 'CV-GONE001', AdjdRefNbr: 'AP-1' }),
      billRow({ AdjgRefNbr: 'CV-GONE002', AdjdRefNbr: 'AP-2' }),
    ]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('2 payment(s)')
    expect(run.message).toContain('CV-GONE001')
    expect(run.message).toContain('CV-GONE002')
    expect(run.message).toContain('--bills --full')
  })

  it('names only the first 10 not-held refs and counts the rest', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      billRow({ AdjgRefNbr: `CV-GONE${String(i).padStart(3, '0')}`, AdjdRefNbr: `AP-${i}` }))
    const result = await bills(rows).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('12 payment(s)')
    expect(run.message).toContain('CV-GONE009')
    expect(run.message).not.toContain('CV-GONE010')
    expect(run.message).toContain('and 2 more')
  })

  it('leaves message null when every payment is held and nothing failed', async () => {
    await heldCheque('CV-ST012345')
    const result = await bills([billRow()]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toBeNull()
  })

  it('one cheque whose write fails is an error; the next cheque is still linked', async () => {
    const first = await heldCheque('CV-FIRST001')
    const second = await heldCheque('CV-SECOND01')
    let calls = 0
    // The first per-cheque transaction throws; every other call is the real one.
    const flaky = new Proxy(testDb, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (...a: unknown[]) => {
            calls++
            if (calls === 1) return Promise.reject(new Error('write refused for the first cheque'))
            return (target.$transaction as (...x: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const { client } = fakeBillsFeed([
      billRow({ AdjgRefNbr: 'CV-FIRST001', AdjdRefNbr: 'AP-F' }),
      billRow({ AdjgRefNbr: 'CV-SECOND01', AdjdRefNbr: 'AP-S' }),
    ])
    const result = await runBillsSync(flaky, { client, tenant: 'GOLIVE', since: null, now: NOW, trigger: 'MANUAL' })
    expect(result.errors).toBe(1)
    expect(result.chequesChanged).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: first.id } })).apvNumbers).toEqual([])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: second.id } })).apvNumbers).toEqual(['AP-S'])
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.errors).toBe(1)
    expect(run.message).toContain('write refused for the first cheque')
    // The failing cheque is named by its payment reference.
    expect(run.message).toContain('CV-FIRST001')
    // The watermark is held, so the failed cheque's vouchers are re-read next run.
    expect(result.watermark).toBeNull()
    expect(run.watermark).toBeNull()
  })

  it('a re-read of an already fully-linked set opens no transaction, writes no audit row, and still advances the watermark', async () => {
    await heldCheque('CV-FIRST001', { apvNumbers: ['AP-F'] })
    await heldCheque('CV-SECOND01', { apvNumbers: ['AP-S2', 'AP-S1'] })
    let transactions = 0
    const counting = new Proxy(testDb, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (...a: unknown[]) => {
            transactions++
            return (target.$transaction as (...x: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const { client } = fakeBillsFeed([
      billRow({ AdjgRefNbr: 'CV-FIRST001', AdjdRefNbr: 'AP-F' }),
      billRow({ AdjgRefNbr: 'CV-SECOND01', AdjdRefNbr: 'AP-S1' }),
      billRow({ AdjgRefNbr: 'CV-SECOND01', AdjdRefNbr: 'AP-S2' }),
    ])
    const result = await runBillsSync(counting, { client, tenant: 'GOLIVE', since: null, now: NOW, trigger: 'MANUAL' })
    expect(transactions).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: VOUCHER_LINKED_ACTION } })).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.chequesChanged).toBe(0)
    // billRow's LastModifiedOn 08:15 (read as UTC) less the 120-minute overlap.
    expect(result.watermark).toEqual(new Date('2026-09-29T06:15:00Z'))
  })

  it('incremental: passes billsSinceFilter with since, billsInScopeFilter without', async () => {
    const since = new Date('2026-09-28T00:00:00Z')
    const a = bills([], { since })
    await a.result
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0].feed).toBe(BILLS_FEED)
    expect(a.calls[0].opts?.filter).toBe(billsSinceFilter('GOLIVE', since))
    expect(a.calls[0].opts?.orderby).toBe('LastModifiedOn asc')

    const b = bills([])
    await b.result
    expect(b.calls[0].opts?.filter).toBe(billsInScopeFilter('GOLIVE'))
  })

  it('a fetch failure leaves the run finished with errors 1, watermark null, and rethrows', async () => {
    const boom = new Error('feed down')
    await expect(bills([], { failWith: boom }).result).rejects.toBe(boom)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILLS' } })
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toContain('feed down')
  })
})

describe('runBillsSync — one run at a time', () => {
  const unfinished = (mode: string, minutesAgo: number) =>
    testDb.syncRun.create({
      data: { mode, tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - minutesAgo * 60_000), finishedAt: null },
    })

  it('refuses while a BILLS run younger than the setting is unfinished', async () => {
    await unfinished('BILLS', 5)
    await expect(bills([billRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
    expect(await testDb.syncRun.count()).toBe(1)
  })

  it('is not blocked by an unfinished payment run', async () => {
    await unfinished('INCREMENTAL', 5)
    const result = await bills([]).result
    expect(result.errors).toBe(0)
  })

  it('is not blocked by an unfinished BILL_REFS run', async () => {
    await unfinished('BILL_REFS', 5)
    const result = await bills([]).result
    expect(result.errors).toBe(0)
  })
})

describe('lastBillsWatermark', () => {
  it('returns the newest BILLS watermark and ignores payment runs', async () => {
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'), watermark: new Date('2026-09-29T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-30T10:00:00Z'), finishedAt: new Date('2026-09-30T10:00:01Z'), watermark: new Date('2026-09-30T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: new Date('2026-10-01T10:00:00Z'), finishedAt: new Date('2026-10-01T10:00:01Z'), watermark: new Date('2026-10-01T08:00:00Z') },
    })
    expect(await lastBillsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-30T08:00:00Z'))
    expect(await lastBillsWatermark(testDb, 'MANUFACTURING')).toBeNull()
  })
})

describe('lastBillsWatermark — other feeds', () => {
  it('ignores a newer BILL_REFS watermark', async () => {
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'), watermark: new Date('2026-09-29T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date('2026-09-30T10:00:00Z'), finishedAt: new Date('2026-09-30T10:00:01Z'), watermark: new Date('2026-09-30T08:00:00Z') },
    })
    expect(await lastBillsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-29T08:00:00Z'))
  })
})

describe('runScheduledBillsSync', () => {
  const billsWatermark = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
    testDb.syncRun.create({
      data: {
        mode: 'BILLS', tenant, trigger: 'MANUAL',
        startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'),
        watermark: new Date('2026-09-29T08:00:00Z'),
      },
    })

  it('refuses without a BILLS watermark and records a finished BILLS row saying so', async () => {
    // A payment watermark is not a BILLS watermark.
    await testDb.syncRun.create({
      data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: NOW, finishedAt: NOW, watermark: NOW },
    })
    let built = 0
    const outcome = await runScheduledBillsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { built++; return fakeBillsFeed([]).client },
    })
    expect(built).toBe(0)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILLS' } })
    expect(outcome).toEqual({ tenant: 'GOLIVE', outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id })
    expect(run.trigger).toBe('SCHEDULED')
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toBe(NO_BILLS_WATERMARK_MESSAGE)
  })

  it('a client factory that throws is FAILED, never a throw', async () => {
    await billsWatermark('GOLIVE')
    const outcome = await runScheduledBillsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { throw new Error('x'.repeat(400)) },
    })
    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome !== 'FAILED') throw new Error('unreachable')
    expect(outcome.message.length).toBe(300)
  })

  it('with a watermark, RAN with the counts, as SCHEDULED, from that watermark', async () => {
    await billsWatermark('GOLIVE')
    await heldCheque('CV-ST012345')
    const feed = fakeBillsFeed([billRow(), billRow({ AdjgRefNbr: 'CV-NOTHERE' })])
    const outcome = await runScheduledBillsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })
    expect(outcome).toMatchObject({
      tenant: 'GOLIVE', outcome: 'RAN',
      fetched: 2, ignored: 0, vouchersAdded: 1, chequesChanged: 1, notHeld: 1, errors: 0,
    })
    expect(feed.calls[0].opts?.filter).toBe(billsSinceFilter('GOLIVE', new Date('2026-09-29T08:00:00Z')))
    if (outcome.outcome !== 'RAN') throw new Error('unreachable')
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: outcome.syncRunId } })
    expect(run.trigger).toBe('SCHEDULED')
  })

  it('a BILLS run already in progress is IN_PROGRESS, not FAILED', async () => {
    await billsWatermark('GOLIVE')
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - 60_000), finishedAt: null },
    })
    const outcome = await runScheduledBillsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => fakeBillsFeed([]).client,
    })
    expect(outcome.outcome).toBe('IN_PROGRESS')
  })
})
