import { Prisma, type PrismaClient } from '@prisma/client'
import type { AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import {
  BILL_REFS_FEED,
  BILL_REF_COLUMNS,
  billRefsInScopeFilter,
  billRefsSelect,
  billRefsSinceFilter,
  mapBillRef,
  type BillRef,
} from '@/lib/integrations/acumatica/bill-refs'
import { naiveDate } from '@/lib/integrations/acumatica/map'
import { loadSettings } from '@/lib/settings/read'
import { BILL_REFS_MODE } from '@/lib/sync/modes'
import { SYNC_OVERLAP_MINUTES, SyncInProgressError, type SyncTrigger } from '@/lib/sync/run'

/**
 * The PO read: which purchase orders each AP bill names.
 *
 * Reads Acumatica's `AP-Bills and Adjustments` incrementally per tenant, with
 * its own watermark on `SyncRun` rows of `mode = 'BILL_REFS'` (every other read
 * ignores them, lib/sync/modes.ts), and MIRRORS it into `AcumaticaBill`: a Bill
 * whose VendorRef yields at least one real PO (`extractPoNumbers`) is upserted
 * by APV; one that yields none has its row deleted (this tenant's only).
 *
 * Reference data, not a record: no AuditLog row per bill (rule 7 untouched);
 * the run's own SyncRun row is the trace. Never touches `Check` (rule 4) and
 * never writes a PortalEvent. Acumatica is read through `fetchAll` only (rule 3).
 *
 * Writes are set-based, one statement per batch of 500, so no interactive
 * transaction is opened. A failed batch is an error and HOLDS the watermark,
 * so the next run reads those bills again; re-writing an unchanged bill is a
 * no-op (the upsert's IS DISTINCT FROM guard).
 *
 * A first read (no watermark) is a terminal job, never the cron.
 */

type Db = PrismaClient | Prisma.TransactionClient

export { BILL_REFS_MODE }

const WRITE_BATCH = 500
const MAX_REPORTED_PROBLEMS = 5
const MAX_PROBLEM_LENGTH = 300

export type BillRefsSyncArgs = {
  client: AcumaticaClient
  tenant: AcumaticaTenant
  /** The previous BILL_REFS watermark (`lastBillRefsWatermark`), or null for a first read. */
  since: Date | null
  now: Date
  trigger: SyncTrigger
}

export type BillRefsRunResult = {
  syncRunId: string
  tenant: AcumaticaTenant
  /** Rows the feed returned. */
  fetched: number
  /** Rows that are not a 2026 Bill with a reference. Not errors. */
  ignored: number
  /** Distinct bills read whose VendorRef names at least one PO. */
  withPo: number
  /** Bill rows actually written (inserted, or changed). */
  upserted: number
  /** Rows deleted because the bill's VendorRef no longer names a PO. */
  deleted: number
  /** Distinct bills with a non-empty VendorRef that names no PO. */
  noPo: number
  errors: number
  watermark: Date | null
}

/** The watermark the last BILL_REFS run for this tenant left; no other read is consulted. */
export async function lastBillRefsWatermark(db: Db, tenant: AcumaticaTenant): Promise<Date | null> {
  const run = await db.syncRun.findFirst({
    where: { tenant, mode: BILL_REFS_MODE, watermark: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { watermark: true },
  })
  return run?.watermark ?? null
}

export async function runBillRefsSync(db: Db, args: BillRefsSyncArgs): Promise<BillRefsRunResult> {
  const { client, tenant, since, now, trigger } = args
  const inProgressMinutes = (await loadSettings(db)).values['sync.inProgressMinutes']

  // Only another BILL_REFS run blocks this one; the other reads are other feeds.
  const open = await db.syncRun.findFirst({
    where: {
      tenant,
      mode: BILL_REFS_MODE,
      finishedAt: null,
      startedAt: { gt: new Date(now.getTime() - inProgressMinutes * 60_000) },
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (open) throw new SyncInProgressError(tenant, open.startedAt, inProgressMinutes)

  const run = await db.syncRun.create({ data: { mode: BILL_REFS_MODE, tenant, startedAt: now, trigger } })

  let fetched = 0
  let ignored = 0
  let withPo = 0
  let upserted = 0
  let deleted = 0
  let noPo = 0
  let errors = 0
  const problems: string[] = []

  const finish = async (watermark: Date | null): Promise<void> => {
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        imported: upserted,
        updated: deleted,
        staged: noPo,
        errors,
        watermark,
        message: problems.length > 0 ? summarise(problems) : null,
      },
    })
  }

  let rows: Awaited<ReturnType<AcumaticaClient['fetchAll']>>
  try {
    rows = await client.fetchAll(BILL_REFS_FEED, {
      select: billRefsSelect(),
      filter: since ? billRefsSinceFilter(since) : billRefsInScopeFilter(),
      // Ordered so `$skip` paging is stable, and so the last row of an APV is its latest.
      orderby: `${BILL_REF_COLUMNS.lastModified} asc`,
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

  // Over EVERY row, ignored ones included: they were read, and holding the
  // watermark behind them would re-read them for ever.
  let maxSeen: Date | null = null
  const byApv = new Map<string, BillRef>()
  for (const raw of rows) {
    const seen = naiveDate(raw[BILL_REF_COLUMNS.lastModified], { dayOnly: false })
    if (seen && (maxSeen === null || seen > maxSeen)) maxSeen = seen
    const ref = mapBillRef(raw)
    if (ref === null) {
      ignored++
      continue
    }
    // Rows arrive oldest first, so a later row of the same APV replaces an earlier one.
    byApv.set(ref.apvNumber, ref)
  }

  const keep: BillRef[] = []
  const drop: string[] = []
  for (const ref of byApv.values()) {
    if (ref.poNumbers.length > 0) {
      keep.push(ref)
    } else {
      drop.push(ref.apvNumber)
      if (ref.vendorRef !== '') noPo++
    }
  }
  withPo = keep.length

  for (let i = 0; i < keep.length; i += WRITE_BATCH) {
    const batch = keep.slice(i, i + WRITE_BATCH)
    try {
      upserted += await upsertBatch(db, tenant, batch)
    } catch (error) {
      errors++
      problems.push(`${batch[0].apvNumber}…${batch[batch.length - 1].apvNumber}: ${describe(error)}`)
    }
  }

  for (let i = 0; i < drop.length; i += WRITE_BATCH) {
    const batch = drop.slice(i, i + WRITE_BATCH)
    try {
      // This tenant's rows only: a MANUFACTURING read must never delete a GOLIVE bill.
      deleted += await db.$executeRaw(Prisma.sql`
        DELETE FROM "AcumaticaBill"
         WHERE "tenant" = ${tenant} AND "apvNumber" = ANY(${batch}::text[])`)
    } catch (error) {
      errors++
      problems.push(`${batch[0]}…${batch[batch.length - 1]}: ${describe(error)}`)
    }
  }

  // HELD when any batch failed: the previous watermark stays, so the failed
  // bills are re-read next run (an incremental read only looks forward).
  const watermark =
    errors > 0 || maxSeen === null
      ? null
      : new Date(maxSeen.getTime() - SYNC_OVERLAP_MINUTES * 60_000)

  await finish(watermark)

  return { syncRunId: run.id, tenant, fetched, ignored, withPo, upserted, deleted, noPo, errors, watermark }
}

/**
 * One statement for up to WRITE_BATCH bills. Rows travel as one JSON parameter
 * (`poNumbers` is an array per row, which `unnest` of parallel arrays cannot
 * carry). `lastModifiedOn` arrives as an ISO string ending in Z; cast to a
 * zone-less timestamp the Z is ignored, which is how Prisma stores UTC. The
 * WHERE on DO UPDATE skips a bill whose stored values already match, so the
 * returned count is the rows actually written. `updatedAt` is set the way
 * Prisma's @updatedAt would, in UTC (as lib/sync/bills.ts does).
 */
async function upsertBatch(db: Db, tenant: AcumaticaTenant, batch: readonly BillRef[]): Promise<number> {
  const payload = JSON.stringify(batch.map((b) => ({
    apvNumber: b.apvNumber,
    tenant,
    vendorRef: b.vendorRef,
    poNumbers: b.poNumbers,
    lastModifiedOn: b.lastModifiedOn?.toISOString() ?? null,
  })))
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "AcumaticaBill" ("apvNumber", "tenant", "vendorRef", "poNumbers", "lastModifiedOn", "updatedAt")
    SELECT x."apvNumber", x."tenant", x."vendorRef",
           ARRAY(SELECT e FROM jsonb_array_elements_text(x."poNumbers") WITH ORDINALITY AS t(e, n) ORDER BY n),
           x."lastModifiedOn", (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS x("apvNumber" text, "tenant" text, "vendorRef" text, "poNumbers" jsonb, "lastModifiedOn" timestamp(3))
    ON CONFLICT ("apvNumber") DO UPDATE
       SET "tenant" = EXCLUDED."tenant",
           "vendorRef" = EXCLUDED."vendorRef",
           "poNumbers" = EXCLUDED."poNumbers",
           "lastModifiedOn" = EXCLUDED."lastModifiedOn",
           "updatedAt" = EXCLUDED."updatedAt"
     WHERE ("AcumaticaBill"."tenant", "AcumaticaBill"."vendorRef", "AcumaticaBill"."poNumbers", "AcumaticaBill"."lastModifiedOn")
           IS DISTINCT FROM (EXCLUDED."tenant", EXCLUDED."vendorRef", EXCLUDED."poNumbers", EXCLUDED."lastModifiedOn")`)
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH)}…` : text
}

function summarise(problems: readonly string[]): string {
  return [...new Set(problems)].slice(0, MAX_REPORTED_PROBLEMS).join(' | ')
}

/**
 * What a scheduled PO read says when it will not run. A first BILL_REFS read
 * reads the whole year's bills and is a terminal job.
 */
export const NO_BILL_REFS_WATERMARK_MESSAGE =
  'No BILL_REFS watermark for this tenant. The first PO read must be started by an admin — ' +
  'scripts/sync.ts <TENANT> --bill-refs in a terminal — and is never run on a schedule.'

// See lib/sync/scheduled.ts: an OData failure can be a whole HTML page.
const MAX_OUTCOME_MESSAGE = 300

export type ScheduledBillRefsOutcome =
  | {
      tenant: AcumaticaTenant
      outcome: 'RAN'
      syncRunId: string
      fetched: number
      ignored: number
      upserted: number
      deleted: number
      noPo: number
      errors: number
    }
  | { tenant: AcumaticaTenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string }
  | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
  | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }
  /** The cron did not run the PO read because this tenant's payment read did not RUN. Not a failure. */
  | { tenant: AcumaticaTenant; outcome: 'SKIPPED_PAYMENT_NOT_RUN' }
  /** The cron left the PO read for the next run: too much of its time budget was spent. Not a failure; the watermark stays. */
  | { tenant: AcumaticaTenant; outcome: 'SKIPPED_TIME_BUDGET' }

/**
 * One tenant's scheduled PO read, never throwing — `runScheduledBillsSync`
 * line for line. `client` is a factory so a missing environment variable is
 * this tenant's FAILED, not an exception before the other tenant has run.
 */
export async function runScheduledBillRefsSync(
  db: Db,
  args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient },
): Promise<ScheduledBillRefsOutcome> {
  const { tenant, now } = args
  try {
    const since = await lastBillRefsWatermark(db, tenant)
    if (since === null) {
      const run = await db.syncRun.create({
        data: {
          mode: BILL_REFS_MODE, tenant, trigger: 'SCHEDULED',
          startedAt: now, finishedAt: new Date(),
          errors: 1, message: NO_BILL_REFS_WATERMARK_MESSAGE,
        },
      })
      return { tenant, outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id }
    }

    const result = await runBillRefsSync(db, {
      client: args.client(), tenant, since, now, trigger: 'SCHEDULED',
    })
    return {
      tenant, outcome: 'RAN', syncRunId: result.syncRunId,
      fetched: result.fetched, ignored: result.ignored, upserted: result.upserted,
      deleted: result.deleted, noPo: result.noPo, errors: result.errors,
    }
  } catch (error) {
    if (error instanceof SyncInProgressError) {
      return { tenant, outcome: 'IN_PROGRESS', message: error.message.slice(0, MAX_OUTCOME_MESSAGE) }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { tenant, outcome: 'FAILED', message: message.slice(0, MAX_OUTCOME_MESSAGE) }
  }
}
