import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { autoSign } from '@/lib/domain/actions'
import { AUTO_SIGN_RUN_ACTION, dueBefore } from '@/lib/domain/auto-sign'
import { DomainError } from '@/lib/domain/errors'
import { loadSettings } from '@/lib/settings/read'

/**
 * THE DAILY AUTO-SIGN RUN. Called by /api/cron/sync after both tenants' syncs,
 * whether or not a sync failed — cheques already here keep ageing — and once,
 * by scripts/auto-sign-backlog.ts, for the cheques already waiting when the
 * rule went live. One code path for both.
 *
 * Never throws. A failure is returned as FAILED and recorded, so the route can
 * answer 500 and /admin/sync can show it. Every run — OK, DISABLED or FAILED —
 * leaves one `auto_sign_run` audit row with no checkId: the run's own record,
 * where an auditor looks, with no migration.
 */

/** Same override as lib/import/upsert.ts: Prisma's 5s/2s defaults are too tight across the sea. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const MAX_ERROR = 300

export type AutoSignRun = {
  outcome: 'OK' | 'DISABLED' | 'FAILED'
  signed: number
  /** Listed as due, then found changed inside its own transaction. */
  skipped: number
  /** The setting in force; null only when it could not be read. */
  days: number | null
  error?: string
}

export type AutoSignCandidate = { id: string; checkNumber: string; createdAt: Date; companyCode: string }

/** The database form of `isDueForAutoSign`; `autoSign` re-judges each row with the pure rule. */
export async function listAutoSignCandidates(db: PrismaClient, now: Date, days: number): Promise<AutoSignCandidate[]> {
  if (days <= 0) return []
  const rows = await db.check.findMany({
    where: {
      status: 'SIGNATURE_PENDING',
      acumaticaPaymentId: { not: null },
      isCheque: true,
      // `{ not: 'Voided' }` alone would drop the nulls: SQL's <> never matches NULL.
      OR: [{ acumaticaStatus: null }, { acumaticaStatus: { not: 'Voided' } }],
      createdAt: { lte: dueBefore(now, days) },
    },
    select: { id: true, checkNumber: true, createdAt: true, company: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, checkNumber: r.checkNumber, createdAt: r.createdAt, companyCode: r.company.code }))
}

export async function runAutoSign(db: PrismaClient, args: { now: Date }): Promise<AutoSignRun> {
  let run: AutoSignRun = { outcome: 'OK', signed: 0, skipped: 0, days: null }
  try {
    const days = (await loadSettings(db)).values['autoSign.afterDays']
    run.days = days
    if (days <= 0) {
      run.outcome = 'DISABLED'
    } else {
      for (const c of await listAutoSignCandidates(db, args.now, days)) {
        try {
          const signed = await db.$transaction((tx) => autoSign(tx, { checkId: c.id, now: args.now, days }), TX_OPTIONS)
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

export type LastAutoSign = AutoSignRun & { at: Date }

export async function getLastAutoSign(db: PrismaClient): Promise<LastAutoSign | null> {
  const row = await db.auditLog.findFirst({
    where: { action: AUTO_SIGN_RUN_ACTION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!row) return null
  const d = (row.details ?? {}) as Partial<AutoSignRun>
  return {
    at: row.createdAt,
    outcome: d.outcome ?? 'FAILED',
    signed: d.signed ?? 0,
    skipped: d.skipped ?? 0,
    days: d.days ?? null,
    ...(d.error ? { error: d.error } : {}),
  }
}
