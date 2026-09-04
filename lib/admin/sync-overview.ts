import type { Prisma, PrismaClient, SyncRun } from '@prisma/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Both tenants, always, in a fixed order — including one that has never run.
 *
 * A tenant that has never synced must appear on the admin screen saying so.
 * Listing only the tenants that have `SyncRun` rows would render an empty space
 * where "MANUFACTURING has never been read" belongs, and an empty space is not
 * a fact anybody notices.
 */
export const SYNC_TENANTS = ['GOLIVE', 'MANUFACTURING'] as const satisfies readonly AcumaticaTenant[]

export type TenantSync = {
  tenant: AcumaticaTenant
  /** The most recent run, whatever became of it. */
  lastAttempt: SyncRun | null
  /** The most recent run that finished and reported no failed rows. */
  lastSuccess: SyncRun | null
  /**
   * `runSync` writes its row BEFORE it reads the feed and sets `finishedAt` in
   * every exit path, so a latest attempt with a null `finishedAt` is a run
   * still going — or one whose process died. Those are worth telling apart from
   * a run that failed, which is why this is surfaced rather than folded into
   * "not a success".
   */
  inFlight: boolean
}

export type SyncOverview = {
  tenants: TenantSync[]
  /**
   * Runs recorded before `SyncRun.tenant` existed. Counted rather than dropped:
   * they are real runs, and a screen that silently omitted them would report a
   * shorter history than the database holds. They are deliberately NOT
   * attributed to a tenant — nothing knows which one they read, and guessing
   * would put one tenant's figures under the other's heading.
   */
  untenantedRuns: number
}

// A run "succeeded" when it finished and no row failed. A run that finished
// with three bad rows out of thirty-seven thousand is not hidden — it is the
// last ATTEMPT, with its error count showing — but it is not offered as the
// last known-good read either, because somebody has to look at those three.
const SUCCESS: Prisma.SyncRunWhereInput = { finishedAt: { not: null }, errors: 0 }

export async function getSyncOverview(db: Db): Promise<SyncOverview> {
  const [tenants, untenantedRuns] = await Promise.all([
    Promise.all(
      SYNC_TENANTS.map(async (tenant): Promise<TenantSync> => {
        const [lastAttempt, lastSuccess] = await Promise.all([
          db.syncRun.findFirst({ where: { tenant }, orderBy: { startedAt: 'desc' } }),
          db.syncRun.findFirst({ where: { tenant, ...SUCCESS }, orderBy: { startedAt: 'desc' } }),
        ])
        return {
          tenant,
          lastAttempt,
          lastSuccess,
          inFlight: lastAttempt !== null && lastAttempt.finishedAt === null,
        }
      }),
    ),
    db.syncRun.count({ where: { tenant: null } }),
  ])

  return { tenants, untenantedRuns }
}
