import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  runBillsSync, lastBillsWatermark, BILLS_MODE, VOUCHER_LINKED_ACTION,
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
    expect(run.message).toBeNull()
    expect(run.watermark).toEqual(new Date('2026-09-29T07:00:00Z'))
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
