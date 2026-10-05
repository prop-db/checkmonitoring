import type { Prisma, PrismaClient, SyncRun } from '@prisma/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { DEFAULT_ABANDONED_AFTER_MINUTES } from '@/lib/settings/defaults'
import { NON_PAYMENT_MODES } from '@/lib/sync/modes'

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
  /**
   * An `inFlight` run old enough that its process is almost certainly gone.
   *
   * `runSync` records a failure in a `catch`, which assumes the process lives
   * long enough to write one. A platform kill runs no catch. On 2026-09-04 the
   * SYNC NOW button was killed by Vercel's function timeout partway through a
   * 41,998-row first sync; the row kept `finishedAt` null, and the screen said
   * SYNCING for 29 minutes while nothing at all was happening.
   *
   * So "still going" cannot be inferred from an absent `finishedAt` alone —
   * that is a claim about a process this system cannot see. Past the threshold
   * the screen stops asserting it and says the run is abandoned, which is the
   * honest reading and the one that lets somebody act.
   */
  abandoned: boolean
}

/**
 * How long a run may sit unfinished before the screen stops believing in it.
 *
 * Generous on purpose. A full first sync of GO-LIVE legitimately takes 50–60
 * minutes from a machine, so a threshold under that would libel a healthy run
 * as dead. Anything a serverless request could produce is dead long before
 * this: Vercel's own ceiling is minutes.
 */
export const ABANDONED_AFTER_MINUTES = DEFAULT_ABANDONED_AFTER_MINUTES

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

export async function getSyncOverview(
  db: Db,
  now: Date = new Date(),
  abandonedAfterMinutes: number = ABANDONED_AFTER_MINUTES,
): Promise<SyncOverview> {
  const [tenants, untenantedRuns] = await Promise.all([
    Promise.all(
      SYNC_TENANTS.map(async (tenant): Promise<TenantSync> => {
        const [lastAttempt, lastSuccess] = await Promise.all([
          // The dashboard's ACUMATICA LAST READ is the payment feed; BILLS and BILL_REFS rows are other reads (lib/sync/modes.ts).
          db.syncRun.findFirst({ where: { tenant, mode: { notIn: [...NON_PAYMENT_MODES] } }, orderBy: { startedAt: 'desc' } }),
          db.syncRun.findFirst({ where: { tenant, mode: { notIn: [...NON_PAYMENT_MODES] }, ...SUCCESS }, orderBy: { startedAt: 'desc' } }),
        ])
        const inFlight = lastAttempt !== null && lastAttempt.finishedAt === null
        return {
          tenant,
          lastAttempt,
          lastSuccess,
          inFlight,
          // Measured from startedAt, not from any progress signal: runSync reports
          // its counts only at the end, so a killed run and a working one look
          // identical until the threshold passes.
          abandoned: inFlight && now.getTime() - lastAttempt!.startedAt.getTime() > abandonedAfterMinutes * 60_000,
        }
      }),
    ),
    db.syncRun.count({ where: { tenant: null } }),
  ])

  return { tenants, untenantedRuns }
}
