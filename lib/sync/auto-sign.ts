import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { autoSign } from '@/lib/domain/actions'
import { AUTO_SIGN_RUN_ACTION, SIGNATURE_REVERTED_ACTION, isManilaTuesday, mondayWindow } from '@/lib/domain/auto-sign'
import { DomainError } from '@/lib/domain/errors'
import { loadSettings } from '@/lib/settings/read'

/**
 * THE AUTO-SIGN RUN. Called by /api/cron/sync after both tenants' syncs, at 12:00
 * and 18:00 Manila. It signs only on a Manila Tuesday — Monday's Acumatica
 * cheques (lib/domain/auto-sign.ts); on every other day it records IDLE.
 *
 * Never throws. A failure is returned as FAILED and recorded, so the route can
 * answer 500 and /admin/sync can show it. Every run — OK, DISABLED, IDLE or FAILED —
 * leaves one `auto_sign_run` audit row with no checkId: the run's own record,
 * where an auditor looks, with no migration.
 */

/** Same override as lib/import/upsert.ts: Prisma's 5s/2s defaults are too tight across the sea. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const MAX_ERROR = 300

/**
 * The UTC hour of the LAST scheduled run of the day — vercel.json's
 * `"0 10 * * *"` entry on /api/cron/sync, 18:00 Manila. The other entry,
 * `"0 4 * * *"`, is 12:00 Manila. A Tuesday run cut off before this hour
 * is retried by the 18:00 run (same Monday window); one cut off at or after
 * it is not, because Wednesday is IDLE. Change it with vercel.json.
 */
export const LAST_RUN_UTC_HOUR = 10
const HOUR_MS = 3_600_000

/** What happens to cheques a Tuesday run left unsigned at its deadline. */
function leftoverFate(now: Date): string {
  // `mondayWindow(now).to` is 00:00 Manila on this Tuesday = 16:00 UTC Monday,
  // so 18:00 Manila (10:00 UTC) is 18 hours after it.
  const lastRun = mondayWindow(now).to.getTime() + (LAST_RUN_UTC_HOUR + 8) * HOUR_MS
  return now.getTime() < lastRun ? 'the 18:00 run continues' : 'they wait for SIGN ALL'
}

export type AutoSignRun = {
  outcome: 'OK' | 'DISABLED' | 'IDLE' | 'FAILED'
  signed: number
  /** Listed as due, then found changed inside its own transaction, or deleted before it could be signed. */
  skipped: number
  /** The setting in force; null only when it could not be read. */
  enabled: boolean | null
  error?: string
}

export type AutoSignCandidate = { id: string; checkNumber: string; createdAt: Date; companyCode: string }

/** The database form of `isDueForAutoSign`; `autoSign` re-judges each row with the pure rule. */
export async function listAutoSignCandidates(db: PrismaClient, now: Date): Promise<AutoSignCandidate[]> {
  if (!isManilaTuesday(now)) return []
  const { from, to } = mondayWindow(now)
  const rows = await db.check.findMany({
    where: {
      status: 'SIGNATURE_PENDING',
      acumaticaPaymentId: { not: null },
      isCheque: true,
      // `{ not: 'Voided' }` alone would drop the nulls: SQL's <> never matches NULL.
      OR: [{ acumaticaStatus: null }, { acumaticaStatus: { not: 'Voided' } }],
      createdAt: { gte: from, lt: to },
      auditLogs: { none: { action: SIGNATURE_REVERTED_ACTION } },
    },
    select: { id: true, checkNumber: true, createdAt: true, company: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, checkNumber: r.checkNumber, createdAt: r.createdAt, companyCode: r.company.code }))
}

export async function runAutoSign(
  db: PrismaClient, args: { now: Date; deadline?: Date },
): Promise<AutoSignRun> {
  let run: AutoSignRun = { outcome: 'OK', signed: 0, skipped: 0, enabled: null }
  try {
    const enabled = (await loadSettings(db)).values['autoSign.mondayEnabled'] === 1
    run.enabled = enabled
    if (!enabled) {
      run.outcome = 'DISABLED'
    } else if (!isManilaTuesday(args.now)) {
      run.outcome = 'IDLE'
    } else {
      const candidates = await listAutoSignCandidates(db, args.now)
      for (let i = 0; i < candidates.length; i++) {
        // Checked before each cheque. Vercel's 60s ceiling can cut a run off
        // mid-backlog; when it does, the run must still leave a record rather
        // than being killed silently — FAILED, with what is left still due and
        // whether the 18:00 run will pick it up or SIGN ALL must.
        if (args.deadline && Date.now() >= args.deadline.getTime()) {
          const left = candidates.length - i
          run.outcome = 'FAILED'
          run.error = `time budget reached with ${left} cheque(s) still due; ${leftoverFate(args.now)}`
          break
        }
        const c = candidates[i]
        try {
          const signed = await db.$transaction((tx) => autoSign(tx, { checkId: c.id, now: args.now }), TX_OPTIONS)
          if (signed) run.signed++
          else run.skipped++
        } catch (e) {
          // A cheque deleted between listing and signing must not fail the
          // whole run: it is gone, not a reason to leave the rest unsigned.
          if (e instanceof DomainError && e.code === 'NOT_FOUND') {
            run.skipped++
          } else {
            throw e
          }
        }
      }
    }
  } catch (e) {
    run = { ...run, outcome: 'FAILED', error: (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR) }
  }

  try {
    await writeAudit(db, { actorType: 'SYSTEM', action: AUTO_SIGN_RUN_ACTION, details: { ...run } as Prisma.InputJsonValue })
  } catch {
    // The record of the run could not be written; the caller still gets the outcome.
  }
  return run
}

export type LastAutoSign = AutoSignRun & {
  at: Date
  /**
   * A run recorded under the old "N days after creation" rule (before
   * 2026-10-01) stored `days` and no `enabled`. Non-null only for such a row,
   * so /admin/sync can describe it in its own terms rather than as Monday's.
   */
  legacyDays: number | null
}

export async function getLastAutoSign(db: PrismaClient): Promise<LastAutoSign | null> {
  const row = await db.auditLog.findFirst({
    where: { action: AUTO_SIGN_RUN_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!row) return null
  const d = (row.details ?? {}) as Partial<AutoSignRun> & { days?: unknown }
  const legacyDays = d.enabled === undefined && typeof d.days === 'number' ? d.days : null
  return {
    at: row.createdAt,
    legacyDays,
    outcome: d.outcome ?? 'FAILED',
    signed: d.signed ?? 0,
    skipped: d.skipped ?? 0,
    enabled: d.enabled ?? null,
    ...(d.error ? { error: d.error } : {}),
  }
}
