import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import type { AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import {
  BILLS_FEED,
  BILL_FEED_COLUMNS,
  billFeedSelect,
  billsInScopeFilter,
  billsSinceFilter,
  mapBillApplication,
} from '@/lib/integrations/acumatica/bills'
import { naiveDate } from '@/lib/integrations/acumatica/map'
import { loadSettings } from '@/lib/settings/read'
import { SYNC_OVERLAP_MINUTES, SyncInProgressError, type SyncTrigger } from '@/lib/sync/run'

/**
 * The voucher read: which AP vouchers (APV) each cheque pays.
 *
 * Reads Acumatica's `AP-PAYMENTS-WITH-BILLS` incrementally per tenant, with its
 * own watermark on `SyncRun` rows of `mode = 'BILLS'` (the payment sync ignores
 * them, and they ignore it). Every `CHK` → `Bill` application is joined to a
 * cheque on the PAYMENT'S OWN REFERENCE — `Check.acumaticaPaymentId`, unique —
 * never on a cheque number, which repeats across companies.
 *
 * ADD-ONLY. A voucher is appended to `Check.apvNumbers` when it is missing;
 * nothing is ever removed or reordered, so what the retired register recorded
 * stays. One `voucher_linked_from_acumatica` audit row per changed cheque, in
 * the same transaction as the write.
 *
 * Never writes `status` (rule 4: an import never changes a cheque's status) and
 * never writes a `PortalEvent` — linking a voucher tells a supplier nothing.
 * Acumatica is read through `fetchAll` only (rule 3).
 *
 * A first read (no watermark) is a terminal job, never the cron.
 */

type Db = PrismaClient | Prisma.TransactionClient

export const BILLS_MODE = 'BILLS'
export const VOUCHER_LINKED_ACTION = 'voucher_linked_from_acumatica'

/** The same widened interactive-transaction limits as `lib/import/upsert.ts`. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const IN_CHUNK = 1_000
const MAX_REPORTED_PROBLEMS = 5
const MAX_PROBLEM_LENGTH = 300

export type BillsSyncArgs = {
  client: AcumaticaClient
  tenant: AcumaticaTenant
  /** The previous BILLS watermark (`lastBillsWatermark`), or null for a first read. */
  since: Date | null
  now: Date
  trigger: SyncTrigger
}

export type BillsRunResult = {
  syncRunId: string
  tenant: AcumaticaTenant
  /** Rows the feed returned. */
  fetched: number
  /** Rows that are not a CHK paying a Bill (VCK, PPM, ADR, REF, Debit Adj.). Not errors. */
  ignored: number
  vouchersAdded: number
  chequesChanged: number
  /** Distinct payment references this system holds no cheque for. */
  notHeld: number
  errors: number
  watermark: Date | null
}

async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn, TX_OPTIONS)
  }
  return fn(db as Prisma.TransactionClient)
}

/** The watermark the last BILLS run for this tenant left; payment runs are not consulted. */
export async function lastBillsWatermark(db: Db, tenant: AcumaticaTenant): Promise<Date | null> {
  const run = await db.syncRun.findFirst({
    where: { tenant, mode: BILLS_MODE, watermark: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { watermark: true },
  })
  return run?.watermark ?? null
}

export async function runBillsSync(db: Db, args: BillsSyncArgs): Promise<BillsRunResult> {
  const { client, tenant, since, now, trigger } = args
  const inProgressMinutes = (await loadSettings(db)).values['sync.inProgressMinutes']

  // Only another BILLS run blocks this one; a payment run reads a different feed.
  const open = await db.syncRun.findFirst({
    where: {
      tenant,
      mode: BILLS_MODE,
      finishedAt: null,
      startedAt: { gt: new Date(now.getTime() - inProgressMinutes * 60_000) },
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (open) throw new SyncInProgressError(tenant, open.startedAt, inProgressMinutes)

  const run = await db.syncRun.create({ data: { mode: BILLS_MODE, tenant, startedAt: now, trigger } })

  let fetched = 0
  let ignored = 0
  let vouchersAdded = 0
  let chequesChanged = 0
  let notHeld = 0
  let errors = 0
  const problems: string[] = []

  const finish = async (watermark: Date | null): Promise<void> => {
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        imported: vouchersAdded,
        updated: chequesChanged,
        staged: notHeld,
        errors,
        watermark,
        message: problems.length ? summarise(problems) : null,
      },
    })
  }

  const dateColumn = BILL_FEED_COLUMNS[tenant].date
  let rows: Awaited<ReturnType<AcumaticaClient['fetchAll']>>
  try {
    rows = await client.fetchAll(BILLS_FEED, {
      select: billFeedSelect(tenant),
      filter: since ? billsSinceFilter(tenant, since) : billsInScopeFilter(tenant),
      // Ordered so `$skip` paging is stable; see the payment sync.
      orderby: `${dateColumn} asc`,
      pageSize: 2000,
    })
  } catch (error) {
    // Nothing was read, so the watermark must not move.
    errors = 1
    problems.push(describe(error))
    await finish(null)
    throw error
  }

  fetched = rows.length

  // Over EVERY row, ignored ones included: a run of VCK rows was still read,
  // and holding the watermark behind it would re-read them for ever.
  let maxSeen: Date | null = null
  const byRef = new Map<string, Set<string>>()
  for (const raw of rows) {
    const seen = naiveDate(raw[dateColumn], { dayOnly: false })
    if (seen && (maxSeen === null || seen > maxSeen)) maxSeen = seen

    const app = mapBillApplication(raw, tenant)
    if (app === null) {
      ignored++
      continue
    }
    let set = byRef.get(app.paymentRef)
    if (!set) byRef.set(app.paymentRef, (set = new Set()))
    set.add(app.voucher)
  }

  const refs = [...byRef.keys()]
  const held = new Map<string, string>() // paymentRef -> checkId
  for (let i = 0; i < refs.length; i += IN_CHUNK) {
    const found = await db.check.findMany({
      where: { acumaticaPaymentId: { in: refs.slice(i, i + IN_CHUNK) } },
      select: { id: true, acumaticaPaymentId: true },
    })
    for (const c of found) if (c.acumaticaPaymentId) held.set(c.acumaticaPaymentId, c.id)
  }

  for (const [paymentRef, vouchers] of byRef) {
    const checkId = held.get(paymentRef)
    if (!checkId) {
      notHeld++
      continue
    }
    try {
      const added = await inTx(db, async (tx) => {
        // Re-read inside the transaction: a register backfill or another run
        // may have added a voucher since the lookup above.
        const current = (await tx.check.findUniqueOrThrow({
          where: { id: checkId },
          select: { apvNumbers: true },
        })).apvNumbers
        const have = new Set(current)
        const missing = [...vouchers].filter((v) => !have.has(v)).sort()
        if (missing.length === 0) return 0
        await tx.check.update({
          where: { id: checkId },
          data: { apvNumbers: [...current, ...missing] },
        })
        await writeAudit(tx, {
          checkId,
          actorType: 'SYSTEM',
          action: VOUCHER_LINKED_ACTION,
          details: { vouchers: missing, source: BILLS_FEED, tenant, paymentRef },
          remarks: `Acumatica (AP-PAYMENTS-WITH-BILLS) shows this cheque paying ${missing.join(', ')}.`,
        })
        return missing.length
      })
      if (added > 0) {
        vouchersAdded += added
        chequesChanged++
      }
    } catch (error) {
      // One cheque's failure must not cost the rest of the run.
      errors++
      problems.push(describe(error))
    }
  }

  const watermark =
    maxSeen === null ? null : new Date(maxSeen.getTime() - SYNC_OVERLAP_MINUTES * 60_000)

  await finish(watermark)

  return {
    syncRunId: run.id, tenant,
    fetched, ignored, vouchersAdded, chequesChanged, notHeld, errors, watermark,
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH)}…` : text
}

function summarise(problems: readonly string[]): string {
  return [...new Set(problems)].slice(0, MAX_REPORTED_PROBLEMS).join(' | ')
}
