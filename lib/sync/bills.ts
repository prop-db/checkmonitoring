import { Prisma, type PrismaClient } from '@prisma/client'
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
/** How many not-held payment references a run's message names before it counts the rest. */
const MAX_NAMED_NOT_HELD = 10

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
  const notHeldRefs: string[] = []

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
        message: runMessage(problems, notHeldRefs, tenant),
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
  // The held cheques AND their current vouchers, in the same chunked read, so
  // a cheque already carrying everything the inquiry names costs no
  // transaction. The cron has a 60-second ceiling, and a re-read of an
  // already-linked set (every incremental run overlaps the last by 120
  // minutes) would otherwise open one transaction per cheque for nothing.
  const held = new Map<string, { id: string; apvNumbers: readonly string[] }>() // paymentRef -> cheque
  for (let i = 0; i < refs.length; i += IN_CHUNK) {
    const found = await db.check.findMany({
      where: { acumaticaPaymentId: { in: refs.slice(i, i + IN_CHUNK) } },
      select: { id: true, acumaticaPaymentId: true, apvNumbers: true },
    })
    for (const c of found) {
      if (c.acumaticaPaymentId) held.set(c.acumaticaPaymentId, { id: c.id, apvNumbers: c.apvNumbers })
    }
  }

  for (const [paymentRef, vouchers] of byRef) {
    const cheque = held.get(paymentRef)
    if (!cheque) {
      notHeld++
      notHeldRefs.push(paymentRef)
      continue
    }
    const checkId = cheque.id
    // Nothing missing on the unlocked read: no transaction. A concurrent
    // writer only ever ADDS vouchers (BILLS appends, upsertCheck writes only
    // an addition), so a voucher present now cannot be missing at commit.
    if ([...vouchers].every((v) => cheque.apvNumbers.includes(v))) continue
    try {
      const added = await inTx(db, async (tx) => {
        // Re-read inside the transaction, with the row locked, and append in
        // SQL: the row lock and the SQL-side append stop THIS run overwriting
        // a concurrent writer. The other direction is closed in upsertCheck,
        // which no longer writes `apvNumbers` unless it adds one, so the
        // payment sync cannot erase an append made here.
        const locked = await tx.$queryRaw<{ apvNumbers: string[] }[]>(Prisma.sql`
          SELECT "apvNumbers" FROM "Check" WHERE "id" = ${checkId} FOR UPDATE`)
        if (locked.length === 0) throw new Error(`Cheque ${checkId} no longer exists.`)
        const have = new Set(locked[0].apvNumbers)
        const missing = [...vouchers].filter((v) => !have.has(v)).sort()
        if (missing.length === 0) return 0
        // Append only what is missing — never a rewrite of the whole array, so
        // nothing another writer put there can be lost. `updatedAt` is set the
        // way Prisma's @updatedAt would, in UTC.
        await tx.$executeRaw(Prisma.sql`
          UPDATE "Check"
             SET "apvNumbers" = "apvNumbers" || ${missing}::text[],
                 "updatedAt" = (now() AT TIME ZONE 'UTC')
           WHERE "id" = ${checkId}`)
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
      // One cheque's failure must not cost the rest of the run. Named by its
      // payment reference, so the run message says which cheque to look at.
      errors++
      problems.push(`${paymentRef}: ${describe(error)}`)
    }
  }

  // HELD when any cheque's write failed: the previous BILLS watermark stays in
  // force, so the failed cheque's vouchers are re-read next run. Moving it
  // would skip them for good (an incremental read only looks forward). The
  // re-read is harmless for the rest: add-only, and a fully-linked cheque
  // opens no transaction.
  const watermark =
    errors > 0 || maxSeen === null
      ? null
      : new Date(maxSeen.getTime() - SYNC_OVERLAP_MINUTES * 60_000)

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

/**
 * The run's message: the payments this system does not hold, named, and any
 * errors. The watermark moves past a not-held payment, so an incremental run
 * never revisits it — naming it here is how anyone learns a full re-read is
 * owed. Bounded: at most ten references and five error texts of 300 chars.
 */
function runMessage(
  problems: readonly string[],
  notHeldRefs: readonly string[],
  tenant: AcumaticaTenant,
): string | null {
  const parts: string[] = []
  if (notHeldRefs.length > 0) {
    const named = notHeldRefs.slice(0, MAX_NAMED_NOT_HELD)
    const rest = notHeldRefs.length - named.length
    parts.push(
      `${notHeldRefs.length} payment(s) in the inquiry are not held here: ${named.join(', ')}` +
      (rest > 0 ? `, and ${rest} more` : '') +
      `. A full re-read (scripts/sync.ts ${tenant} --bills --full) links them once their cheques exist.`,
    )
  }
  if (problems.length > 0) parts.push(summarise(problems))
  return parts.length > 0 ? parts.join(' | ') : null
}

/**
 * What a scheduled voucher read says when it will not run. A first BILLS read
 * reads the whole year's applications and is a terminal job.
 */
export const NO_BILLS_WATERMARK_MESSAGE =
  'No BILLS watermark for this tenant. The first voucher read must be started by an admin — ' +
  'scripts/sync.ts <TENANT> --bills in a terminal — and is never run on a schedule.'

// See lib/sync/scheduled.ts: an OData failure can be a whole HTML page.
const MAX_OUTCOME_MESSAGE = 300

export type ScheduledBillsOutcome =
  | {
      tenant: AcumaticaTenant
      outcome: 'RAN'
      syncRunId: string
      fetched: number
      ignored: number
      vouchersAdded: number
      chequesChanged: number
      notHeld: number
      errors: number
    }
  | { tenant: AcumaticaTenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string }
  | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
  | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }
  /**
   * The cron did not run the voucher read, because this tenant's payment read
   * did not RUN (failed, refused, or already in progress). Not a failure.
   */
  | { tenant: AcumaticaTenant; outcome: 'SKIPPED_PAYMENT_NOT_RUN' }

/**
 * One tenant's scheduled voucher read, never throwing — `runScheduledSync`
 * line for line. `client` is a factory so a missing environment variable is
 * this tenant's FAILED, not an exception before the other tenant has run.
 */
export async function runScheduledBillsSync(
  db: Db,
  args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient },
): Promise<ScheduledBillsOutcome> {
  const { tenant, now } = args
  try {
    const since = await lastBillsWatermark(db, tenant)
    if (since === null) {
      const run = await db.syncRun.create({
        data: {
          mode: BILLS_MODE, tenant, trigger: 'SCHEDULED',
          startedAt: now, finishedAt: new Date(),
          errors: 1, message: NO_BILLS_WATERMARK_MESSAGE,
        },
      })
      return { tenant, outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id }
    }

    const result = await runBillsSync(db, {
      client: args.client(), tenant, since, now, trigger: 'SCHEDULED',
    })
    return {
      tenant, outcome: 'RAN', syncRunId: result.syncRunId,
      fetched: result.fetched, ignored: result.ignored, vouchersAdded: result.vouchersAdded,
      chequesChanged: result.chequesChanged, notHeld: result.notHeld, errors: result.errors,
    }
  } catch (error) {
    if (error instanceof SyncInProgressError) {
      return { tenant, outcome: 'IN_PROGRESS', message: error.message.slice(0, MAX_OUTCOME_MESSAGE) }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { tenant, outcome: 'FAILED', message: message.slice(0, MAX_OUTCOME_MESSAGE) }
  }
}
