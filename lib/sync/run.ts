import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { upsertCheck } from '@/lib/import/upsert'
import {
  PAYMENTS_FEED,
  PAYMENT_FIELDS,
  type AcumaticaClient,
  type AcumaticaRow,
} from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { mapPayment } from '@/lib/integrations/acumatica/map'

type Db = PrismaClient | Prisma.TransactionClient

// The same shape `lib/import/upsert.ts` uses, for the one place here that must
// write two rows or neither.
async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn)
  }
  return fn(db as Prisma.TransactionClient)
}

/**
 * How far back of the feed's own modification timeline every incremental run
 * re-reads.
 *
 * A row committed *during* a run can carry a `LastModifiedOn` below the maximum
 * that run observed: Acumatica stamps the row when the transaction starts, the
 * feed only shows it once it commits, and the two are not the same instant. A
 * watermark set to the bare maximum would step straight over such a row and it
 * would never be picked up again — a payment silently absent from a cheque
 * register, which is the one failure this system exists to prevent.
 *
 * 120 minutes comes from the Supplier Portal's integration against this same
 * instance; it is that system's measured setting, not a guess. Re-reading two
 * hours costs nothing, because every row goes through `upsertCheck`, which
 * updates rather than duplicates. Do not "optimise" this to zero.
 */
export const SYNC_OVERLAP_MINUTES = 120

/**
 * Only the bounded head of the problem list reaches `SyncRun.message`. The AP
 * feed runs to roughly 37,000 rows; if a schema change broke every one of them,
 * 37,000 sentences in a text column is not a diagnosis, it is a denial of
 * service on the admin page. Distinct messages, capped, with the rest counted.
 */
const MAX_REPORTED_PROBLEMS = 5
const MAX_PROBLEM_LENGTH = 300

export type SyncMode = 'FULL' | 'INCREMENTAL'

export type SyncArgs = {
  client: AcumaticaClient
  /**
   * Explicit, never inferred and never defaulted. The two tenants reuse branch
   * codes for different companies — Go-Live `ST` is Starkson Packaging,
   * MANUFACTURING `ST` is Starkson Paper and Plastic — so a run that guessed
   * would file cheques under the wrong legal entity while looking correct.
   */
  tenant: AcumaticaTenant
  /** The previous run's watermark, or null for a full read. See `lastSyncWatermark`. */
  since: Date | null
  now: Date
}

export type SyncRunResult = {
  syncRunId: string
  tenant: AcumaticaTenant
  mode: SyncMode
  /** Rows the feed returned. */
  fetched: number
  /** Rows `mapPayment` declined: Prepayment, Debit Adj., Refund. Not errors. */
  skipped: number
  imported: number
  updated: number
  errors: number
  /** Staged register rows this run linked to a cheque. */
  promoted: number
  /**
   * Where the next incremental run should start. Null when this run took
   * responsibility for no rows, which leaves the previous watermark standing.
   */
  watermark: Date | null
}

/**
 * The `$filter` literal Acumatica accepts for this instance, measured read-only
 * against the live feed on 2026-09-04: the OData v3 `datetime'...'` form is the
 * ONLY one that works. A bare `2026-09-03T20:00:00`, the same with a trailing
 * `Z`, and `datetimeoffset'2026-09-03T20:00:00Z'` each returned **HTTP 500**.
 * A `2099` cutoff returned zero rows, so the filter genuinely excludes rather
 * than being quietly ignored.
 *
 * `toISOString().slice(0, 19)` reproduces exactly the naive string the feed
 * sent, which is what `map.ts` pins the `Z` suffix for. Do not add a zone here:
 * the feed's timestamps carry none and appending one is a 500.
 */
export function paymentsSinceFilter(since: Date): string {
  return `LastModifiedOn ge datetime'${since.toISOString().slice(0, 19)}'`
}

/**
 * The watermark the last run for this tenant left. Per tenant, because the two
 * are separate feeds on separate base URLs whose progress has nothing to do
 * with each other — a single shared watermark would let a Go-Live run advance
 * MANUFACTURING past rows nobody had read.
 */
export async function lastSyncWatermark(db: Db, tenant: AcumaticaTenant): Promise<Date | null> {
  const run = await db.syncRun.findFirst({
    where: { tenant, watermark: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { watermark: true },
  })
  return run?.watermark ?? null
}

/**
 * One incremental read of one Acumatica tenant, through the one write path.
 *
 * Everything goes through `upsertCheck`. Duplicate prevention lives there and
 * nowhere else — this function does no matching of its own, so the sync and the
 * workbook importer can never end up disagreeing about what counts as the same
 * cheque.
 *
 * Writes no `PortalEvent`, ever. A sync changes a cheque's *data*; telling a
 * supplier that money is waiting is a Finance action. `tests/sync/run.test.ts`
 * asserts the count is unchanged after every single test in the file.
 */
export async function runSync(db: Db, args: SyncArgs): Promise<SyncRunResult> {
  const { client, tenant, since, now } = args
  const mode: SyncMode = since ? 'INCREMENTAL' : 'FULL'

  // Written BEFORE the feed is read, and finished in every exit path below. A
  // run with `finishedAt` null is therefore one that is still going or whose
  // process died — which is what makes a hung sync distinguishable from a
  // failed one on the admin screen.
  const run = await db.syncRun.create({ data: { mode, tenant, startedAt: now } })

  let fetched = 0
  let skipped = 0
  let imported = 0
  let updated = 0
  let errors = 0
  let promoted = 0
  const problems: string[] = []

  const finish = async (watermark: Date | null): Promise<void> => {
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: now,
        imported,
        updated,
        errors,
        watermark,
        message: problems.length ? summarise(problems, errors) : null,
      },
    })
  }

  let rows: AcumaticaRow[]
  try {
    rows = await client.fetchAll(PAYMENTS_FEED, {
      select: PAYMENT_FIELDS,
      filter: since ? paymentsSinceFilter(since) : undefined,
      // Not cosmetic. `fetchAll` pages with `$skip`, and `$skip` over an
      // unordered result set is not stable: rows can shift between pages and be
      // read twice (harmless, the upsert absorbs it) or skipped entirely (a
      // payment silently missing). Measured against the live instance on
      // 2026-09-04: an ordered 2,000-row page came back in 847ms versus 989ms
      // unordered, so the guarantee is free.
      orderby: 'LastModifiedOn asc',
    })
  } catch (error) {
    // The feed is unreachable, unauthorised, or answering with an error page.
    // Nothing was read, so the watermark must not move — advancing it here
    // would step over every row this run failed to see.
    errors = 1
    problems.push(describe(error))
    await finish(null)
    throw error
  }

  fetched = rows.length

  // `classifyEligibility` needs the client's own legal names to tell an
  // inter-company cheque from a supplier one. Read once per run rather than per
  // row: it is reference data, and 37,000 identical queries is not free.
  const ownCompanyNames = (await db.company.findMany({ select: { legalNames: true } }))
    .flatMap((c) => c.legalNames)

  let maxSeen: Date | null = null

  for (const raw of rows) {
    // Null is "not our business" — a Prepayment, Debit Adj. or Refund — not an
    // error. 80 of 400 live rows were Debit Adj.; counting those as failures
    // would make a healthy sync look broken.
    const row = mapPayment(raw, tenant)
    if (row === null) {
      skipped++
      continue
    }

    // The maximum over rows this run took responsibility for, which deliberately
    // excludes the document types above: advancing past a Debit Adj. we never
    // import could carry the watermark over a Payment committed just behind it.
    // Conservative in the only direction that is safe — re-reading costs a
    // no-op update, missing a row costs a cheque.
    if (row.lastModifiedOn && (maxSeen === null || row.lastModifiedOn > maxSeen)) {
      maxSeen = row.lastModifiedOn
    }

    try {
      const result = await upsertCheck(db, { row, ownCompanyNames, now })

      if (result.outcome === 'STAGED') {
        // Unreachable by construction: staging is keyed on `(sourceSheet,
        // sourceRow)` and an Acumatica row carries neither, so `upsertCheck`
        // throws CANNOT_STAGE rather than returning this. Kept as a loud
        // failure instead of a silent fall-through, because reaching it would
        // mean a row was neither written nor counted.
        throw new DomainError(
          'UNEXPECTED_STAGING',
          `An ACUMATICA row was staged (${result.reason}), which cannot happen: ` +
            'a feed row has no sheet or row number to key a staged row on.',
        )
      }

      if (result.outcome === 'CREATED') imported++
      else updated++

      promoted += await promoteStagedRows(db, {
        checkId: result.checkId,
        checkNumber: row.checkNumber,
        companyCode: row.companyCode,
      })
    } catch (error) {
      // One bad row must not cost a 37,000-row sync. The row is counted, its
      // problem recorded on the run, and the loop carries on — an abort here
      // would discard every row after the first surprise in the feed.
      errors++
      problems.push(describe(error))
    }
  }

  // THE 120-MINUTE OVERLAP. The maximum seen is the wrong answer on its own;
  // see SYNC_OVERLAP_MINUTES for why. Null stays null so the previous run's
  // watermark stands rather than being reset to two hours before nothing.
  const watermark =
    maxSeen === null ? null : new Date(maxSeen.getTime() - SYNC_OVERLAP_MINUTES * 60_000)

  await finish(watermark)

  return { syncRunId: run.id, tenant, mode, fetched, skipped, imported, updated, errors, promoted, watermark }
}

/**
 * Links the register rows that were staged for want of a company to the cheque
 * the sync has just resolved one for.
 *
 * **The match is `(companyCode, checkNumber)`, never the cheque number alone.**
 * A cheque number is unique only per company, so `findFirst({ checkNumber })`
 * would happily link the register's evidence to a sibling company's cheque of
 * the same number. `checkId` here is not a number lookup: it is what
 * `upsertCheck` resolved through the `(companyId, checkNumber)` unique key,
 * with the company coming from Acumatica's own `Branch`. That is the whole
 * reason Task 7 left `promotedCheckId` unwritten and this is where it becomes
 * safe. Do not replace this with a lookup by number.
 *
 * Only `NO_COMPANY` rows. **`AMBIGUOUS_COMPANY` rows are deliberately left
 * alone** — 61 rows across 27 cheque numbers, of which 25 are one physical
 * cheque entered twice, which Finance ruled on 2026-09-03 must each be settled
 * by a human. Acumatica supplying a company says which company the cheque
 * belongs to; it does not say which of two contradicting register rows was the
 * right one, and promoting one of them would resolve by accident the exact
 * question Finance asked to decide. `NO_CHECK_NUMBER` rows carry no number to
 * match at all.
 *
 * The staged row is linked, never deleted: it is the evidence of why the cheque
 * was held, and deleting it destroys the only record of that.
 *
 * Idempotent by the `promotedCheckId: null` filter, so a re-read of the same
 * payment on the next run promotes nothing and writes no second audit row.
 */
async function promoteStagedRows(
  db: Db,
  args: { checkId: string; checkNumber: string | null; companyCode: string | null },
): Promise<number> {
  const { checkId, checkNumber, companyCode } = args
  // Both are non-null for any row that reached a written check, but stated
  // rather than asserted: a null here must promote nothing, not everything.
  if (checkNumber === null || companyCode === null) return 0

  const staged = await db.stagedCheck.findMany({
    where: { reason: 'NO_COMPANY', checkNumber, promotedCheckId: null },
    select: { id: true, sourceSheet: true, sourceRow: true },
  })
  if (staged.length === 0) return 0

  for (const s of staged) {
    await inTx(db, async (tx) => {
      await tx.stagedCheck.update({ where: { id: s.id }, data: { promotedCheckId: checkId } })
      await writeAudit(tx, {
        checkId,
        actorType: 'SYSTEM',
        action: 'staged_row_promoted',
        details: {
          stagedCheckId: s.id,
          sourceSheet: s.sourceSheet,
          sourceRow: s.sourceRow,
          reason: 'NO_COMPANY',
          checkNumber,
          companyCode,
        },
        remarks:
          `Register row ${s.sourceSheet} ${s.sourceRow} was staged because nothing said which ` +
          `company cheque ${checkNumber} belonged to. Acumatica states ${companyCode}, so it is ` +
          'linked to this cheque. The staged row is kept as the record of why it was held.',
      })
    })
  }
  return staged.length
}

/**
 * A message safe to store on a `SyncRun` and paste into a ticket. Truncated
 * because a driver-level failure can carry a very long payload, and this column
 * is read by a human, not a parser.
 */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH)}…` : text
}

function summarise(problems: readonly string[], errors: number): string {
  const distinct = [...new Set(problems)]
  const shown = distinct.slice(0, MAX_REPORTED_PROBLEMS)
  const rest = distinct.length - shown.length
  return (
    `${errors} row(s) failed. ` +
    shown.join(' | ') +
    (rest > 0 ? ` | and ${rest} further distinct problem(s)` : '')
  )
}
