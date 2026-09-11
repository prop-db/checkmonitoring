import type { Prisma, PrismaClient } from '@prisma/client'
import type { AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { lastSyncWatermark, runSync, SyncInProgressError, type SyncMode } from './run'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * What a scheduled run says when it will not run.
 *
 * Recorded on a `SyncRun` row rather than logged: the admin page reads rows,
 * and a refusal nobody can see is a cheque nobody can see. The first FULL sync
 * of GOLIVE was killed by Vercel's timeout after ~29 minutes; it is a job for
 * scripts/sync.ts from a terminal, and this route never attempts it.
 */
export const NO_WATERMARK_MESSAGE =
  'No watermark for this tenant. A FULL sync must be started by an admin — from ' +
  'scripts/sync.ts in a terminal for a first read — and is never run on a schedule.'

// `runSync` caps the message it writes onto the `SyncRun` row itself, but
// `IN_PROGRESS` and `FAILED` here carry a message this wrapper builds directly
// from `error.message` — an OData failure can hand back a whole HTML error
// page, and that would otherwise land in Vercel's cron log unbounded.
const MAX_OUTCOME_MESSAGE = 300

export type ScheduledSyncOutcome =
  | {
      tenant: AcumaticaTenant
      outcome: 'RAN'
      syncRunId: string
      mode: SyncMode
      fetched: number
      imported: number
      updated: number
      staged: number
      errors: number
    }
  | { tenant: AcumaticaTenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string }
  | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
  | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }

/**
 * One tenant's scheduled read, never throwing.
 *
 * Every outcome is a value, because the route calls this once per tenant in
 * sequence and one tenant's trouble must never skip the other. `client` is a
 * factory rather than a client so that a missing environment variable for one
 * tenant is that tenant's FAILED and not an exception before either has run.
 *
 * `IN_PROGRESS` is kept apart from `FAILED` deliberately: a sync that declined
 * to double up on a SYNC NOW somebody just pressed is not a sync that broke,
 * and the route does not answer 500 for it.
 */
export async function runScheduledSync(
  db: Db,
  args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient },
): Promise<ScheduledSyncOutcome> {
  const { tenant, now } = args
  try {
    const since = await lastSyncWatermark(db, tenant)
    if (since === null) {
      const run = await db.syncRun.create({
        data: {
          mode: 'FULL', tenant, trigger: 'SCHEDULED',
          startedAt: now, finishedAt: new Date(),
          errors: 1, message: NO_WATERMARK_MESSAGE,
        },
      })
      return { tenant, outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id }
    }

    const result = await runSync(db, { client: args.client(), tenant, since, now, trigger: 'SCHEDULED' })
    return {
      tenant, outcome: 'RAN', syncRunId: result.syncRunId, mode: result.mode,
      fetched: result.fetched, imported: result.imported, updated: result.updated,
      staged: result.staged, errors: result.errors,
    }
  } catch (error) {
    if (error instanceof SyncInProgressError) {
      return { tenant, outcome: 'IN_PROGRESS', message: error.message.slice(0, MAX_OUTCOME_MESSAGE) }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { tenant, outcome: 'FAILED', message: message.slice(0, MAX_OUTCOME_MESSAGE) }
  }
}
