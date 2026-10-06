import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { markReadyForRelease } from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'
import { dayToDate } from '@/lib/domain/details'
import { manilaDay } from '@/lib/forecast/buckets'

type Db = PrismaClient | Prisma.TransactionClient

/** Each row is several round trips to ap-southeast-1; Prisma's 5s default would kill the run. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

export const RELEASED_FROM_CLOSED_ACTION = 'released_per_acumatica_closed'
export const REINSTATED_ACTION = 'reinstated_by_finance'
export const STALED_ACTION = 'marked_stale_by_finance'

/**
 * A cheque this system holds CANCELLED or VOIDED that Acumatica holds `Closed`
 * — paid and cleared — with no person behind the cancel or void here. Full
 * check 2026-10-06: 43 CANCELLED only because the retired register's CANCELLED
 * or CHECK FINDING sheet said so, and `1791361374`, VOIDED by the sync's
 * number-keyed void pairing (fixed the same day) while its payment is Closed.
 * User ruling 2026-10-06: "41 closed follow acumatica" (43 on recount).
 *
 * Reads the STORED `acumaticaStatus`, so run it after a full payment re-read
 * (`scripts/sync.ts <TENANT> --full`), which refreshes that column for every
 * payment in scope.
 */
export type ClosedCandidate = {
  id: string; checkNumber: string; status: 'CANCELLED' | 'VOIDED'; acumaticaPaymentId: string
  sourceSheet: string | null; cancelledAt: Date | null; cancelReason: string | null; voidedAt: Date | null
}

export async function findClosedButDeadHere(db: Db): Promise<ClosedCandidate[]> {
  const rows = await db.check.findMany({
    where: {
      status: { in: ['CANCELLED', 'VOIDED'] },
      acumaticaPaymentId: { not: null },
      acumaticaStatus: 'Closed',
      // A reversal row's own status is Closed; before the 2026-10-06 pairing fix
      // one could be stored over its voided original (`6000319193`).
      NOT: { acumaticaDocType: 'Voided Payment' },
      cancelledById: null,
      // A person's cancel or void is a decision, not a register artefact.
      auditLogs: { none: { actorType: 'USER', action: { in: ['cancelled', 'voided', 'voided_after_release'] } } },
    },
    select: {
      id: true, checkNumber: true, status: true, acumaticaPaymentId: true, sourceSheet: true,
      cancelledAt: true, cancelReason: true, voidedAt: true,
    },
    orderBy: { checkNumber: 'asc' },
  })
  return rows.map((r) => ({ ...r, status: r.status as 'CANCELLED' | 'VOIDED', acumaticaPaymentId: r.acumaticaPaymentId! }))
}

/**
 * Status only, as the earlier catch-ups: RELEASED, with `releasedAt` and
 * `releasedById` left null (nobody recorded the hand-over), the cancel/void
 * fields cleared and their old values kept on the one audit row. No portal
 * event. Conditional: a row whose status moved since it was listed is skipped.
 */
export async function releaseClosed(db: PrismaClient, rows: readonly ClosedCandidate[]): Promise<number> {
  let done = 0
  for (const r of rows) {
    const ok = await db.$transaction(async (tx) => {
      const moved = await tx.check.updateMany({
        where: { id: r.id, status: r.status, acumaticaStatus: 'Closed' },
        data: { status: 'RELEASED', cancelledAt: null, cancelReason: null, voidedAt: null },
      })
      if (!moved.count) return false
      await writeAudit(tx, {
        checkId: r.id, actorType: 'SYSTEM', action: RELEASED_FROM_CLOSED_ACTION,
        details: {
          from: r.status, to: 'RELEASED', acumaticaPaymentId: r.acumaticaPaymentId, acumaticaStatus: 'Closed',
          sourceSheet: r.sourceSheet, cancelledAt: r.cancelledAt?.toISOString() ?? null,
          cancelReason: r.cancelReason, voidedAt: r.voidedAt?.toISOString() ?? null,
        },
        remarks: `${r.status} here, Closed in Acumatica. User ruling 2026-10-06: follow Acumatica. Status only; no release date recorded.`,
      })
      return true
    }, TX_OPTIONS)
    if (ok) done += 1
  }
  return done
}

/** Finance's NEW STATUS for a cheque on `CANCELLED VS ACUMATICA` (2026-10-06). */
export type FinanceVerdict = 'AVAILABLE' | 'STALED' | 'CANCELLED'
export type FinanceLine = { checkNumber: string; cv: string; verdict: FinanceVerdict; row: number }
export type FinancePlan = {
  available: { line: FinanceLine; checkId: string }[]
  staled: { line: FinanceLine; checkId: string }[]
  keepCancelled: FinanceLine[]
  /** Already applied: AVAILABLE no longer CANCELLED, or STALED already flagged. */
  done: FinanceLine[]
  refused: { line: FinanceLine; reason: string }[]
}

const VERDICTS: readonly FinanceVerdict[] = ['AVAILABLE', 'STALED', 'CANCELLED']

/** A verdict as typed in the NEW STATUS cell, or null when it is none of the three. */
export function parseVerdict(cell: string): FinanceVerdict | null {
  const v = cell.trim().toUpperCase()
  return (VERDICTS as readonly string[]).includes(v) ? (v as FinanceVerdict) : null
}

/**
 * Each line must name exactly the cheque it says: the CV is the payment
 * reference and the number must agree. Anything else is refused, never guessed.
 */
export async function planFinanceVerdicts(db: Db, lines: readonly FinanceLine[]): Promise<FinancePlan> {
  const plan: FinancePlan = { available: [], staled: [], keepCancelled: [], done: [], refused: [] }
  for (const line of lines) {
    if (line.verdict === 'CANCELLED') { plan.keepCancelled.push(line); continue }
    const check = await db.check.findUnique({
      where: { acumaticaPaymentId: line.cv },
      select: { id: true, checkNumber: true, status: true, isStale: true },
    })
    if (!check) { plan.refused.push({ line, reason: `no cheque here holds payment ${line.cv}` }); continue }
    if (check.checkNumber !== line.checkNumber) {
      plan.refused.push({ line, reason: `${line.cv} is cheque ${check.checkNumber} here, not ${line.checkNumber}` }); continue
    }
    if (line.verdict === 'STALED') {
      if (check.isStale) plan.done.push(line)
      else if (check.status !== 'CANCELLED') plan.refused.push({ line, reason: `it is ${check.status} here, not CANCELLED` })
      else plan.staled.push({ line, checkId: check.id })
      continue
    }
    if (check.status !== 'CANCELLED') {
      if (check.status === 'READY_FOR_RELEASE') plan.done.push(line)
      else plan.refused.push({ line, reason: `it is ${check.status} here, not CANCELLED` })
      continue
    }
    plan.available.push({ line, checkId: check.id })
  }
  return plan
}

export type AvailableOutcome = { checkNumber: string; ok: true } | { checkNumber: string; ok: false; reason: string }

/**
 * AVAILABLE: back to SIGNED (status only, one `reinstated_by_finance` row),
 * then READY FOR RELEASE through `markReadyForRelease` — the app's own path, so
 * the guard runs and a portal-routed cheque queues MARK_AVAILABLE exactly as a
 * tick on screen would (user ruling 2026-10-06: tell the portal). Both steps in
 * one transaction: a cheque the guard refuses (no amount, no account) stays
 * CANCELLED and is reported. The pickup date is the run's Manila day.
 */
export async function applyAvailable(
  db: PrismaClient, items: FinancePlan['available'], args: { userId: string; now: Date },
): Promise<AvailableOutcome[]> {
  const pickup = dayToDate(manilaDay(args.now))
  const out: AvailableOutcome[] = []
  for (const { line, checkId } of items) {
    try {
      await db.$transaction(async (tx) => {
        const before = await tx.check.findUniqueOrThrow({
          where: { id: checkId }, select: { status: true, cancelledAt: true, cancelReason: true },
        })
        if (before.status !== 'CANCELLED') throw new DomainError('MOVED', `it is ${before.status} now`)
        await tx.check.update({ where: { id: checkId }, data: { status: 'SIGNED', cancelledAt: null, cancelReason: null } })
        await writeAudit(tx, {
          checkId, actorType: 'USER', userId: args.userId, action: REINSTATED_ACTION,
          details: {
            from: 'CANCELLED', to: 'SIGNED', verdict: 'AVAILABLE', sheetRow: line.row,
            cancelledAt: before.cancelledAt?.toISOString() ?? null, cancelReason: before.cancelReason,
          },
          remarks: 'Finance: AVAILABLE (CANCELLED VS ACUMATICA 2026-10-06). Cancelled only by the retired register; live in Acumatica.',
        })
        await markReadyForRelease(tx, { checkId, userId: args.userId, availablePickupDate: pickup, now: args.now })
      }, TX_OPTIONS)
      out.push({ checkNumber: line.checkNumber, ok: true })
    } catch (e) {
      out.push({ checkNumber: line.checkNumber, ok: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** STALED: stays CANCELLED, `isStale` set, one row. Conditional on still CANCELLED and not flagged. */
export async function applyStaled(
  db: PrismaClient, items: FinancePlan['staled'], args: { userId: string },
): Promise<number> {
  let done = 0
  for (const { line, checkId } of items) {
    const ok = await db.$transaction(async (tx) => {
      const moved = await tx.check.updateMany({ where: { id: checkId, status: 'CANCELLED', isStale: false }, data: { isStale: true } })
      if (!moved.count) return false
      await writeAudit(tx, {
        checkId, actorType: 'USER', userId: args.userId, action: STALED_ACTION,
        details: { verdict: 'STALED', sheetRow: line.row },
        remarks: 'Finance: STALED (CANCELLED VS ACUMATICA 2026-10-06). Stays CANCELLED; shown with a STALED tag.',
      })
      return true
    }, TX_OPTIONS)
    if (ok) done += 1
  }
  return done
}
