import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'
import { portalApvs } from '@/lib/integrations/portal/apvs'

type Db = PrismaClient | Prisma.TransactionClient

/** Each row is several round trips to ap-southeast-1; Prisma's 5s default would kill the run. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

/** The same action the 2026-10-07 reconcile wrote for a Closed payment released here. */
export const RELEASED_FROM_CLOSED_ACTION = 'released_per_acumatica_closed'

/**
 * A check still SIGNED or READY FOR RELEASE here whose payment Acumatica holds
 * `Closed` — paid. Found 2026-10-16 on /aging: `1791259546` (IND, FCRCM HOLDINGS,
 * PHP 26,767,200.00), PAID on the 10.05 register's FT & MC sheet and Closed in
 * Acumatica, still SIGNED here; 729 such checks in all (668 SIGNED, 61 READY FOR
 * RELEASE). The sync never writes status (rule 4), and the register catch-ups
 * read only the RELEASED sheets, so nothing moved them. User ruling 2026-10-16:
 * "mark all 729 checks that Acumatica says are Closed as RELEASED (status only,
 * snapshot first, one audit row each, portal told). They are paid."
 *
 * Same population as /aging (a real check with a recorded amount). Reads the
 * STORED `acumaticaStatus`; a payment the LIVE feed shows with any void
 * (`voidedRefs`, see `voidedReferences` in lib/admin/acumatica-reconcile.ts —
 * a pending void leaves the original `Closed`, 2026-10-07) is never released.
 */
export type LiveClosedCandidate = {
  id: string
  checkNumber: string
  status: 'SIGNED' | 'READY_FOR_RELEASE'
  acumaticaPaymentId: string
  amount: string
  eligibility: Eligibility
  /** The portal was told this check is available (a MARK_AVAILABLE event exists). */
  announced: boolean
  /** A RELEASED event will be queued: routed, with an APV, and announced. */
  tellPortal: boolean
}

export async function findClosedStillLive(db: Db, voidedRefs: ReadonlySet<string> = new Set()): Promise<LiveClosedCandidate[]> {
  const rows = await db.check.findMany({
    where: {
      status: { in: ['SIGNED', 'READY_FOR_RELEASE'] },
      isCheque: true,
      amount: { not: null },
      acumaticaPaymentId: { not: null },
      acumaticaStatus: 'Closed',
      // A reversal row's own status is Closed (2026-10-06).
      NOT: { acumaticaDocType: 'Voided Payment' },
    },
    select: {
      id: true, checkNumber: true, status: true, acumaticaPaymentId: true, amount: true, eligibility: true,
      apvNumbers: true, bills: { select: { apvNumber: true } },
      portalEvents: { where: { kind: 'MARK_AVAILABLE' }, select: { id: true }, take: 1 },
    },
    orderBy: { checkNumber: 'asc' },
  })
  return rows
    .filter((r) => !voidedRefs.has(r.acumaticaPaymentId!))
    .map((r) => {
      const eligibility = r.eligibility as Eligibility
      const announced = r.portalEvents.length > 0
      return {
        id: r.id,
        checkNumber: r.checkNumber,
        status: r.status as 'SIGNED' | 'READY_FOR_RELEASE',
        acumaticaPaymentId: r.acumaticaPaymentId!,
        amount: r.amount!.toString(),
        eligibility,
        announced,
        tellPortal: announced && portalRoute(eligibility) !== null && portalApvs(r).length > 0,
      }
    })
}

/**
 * Status only, as the earlier catch-ups: RELEASED, with `releasedAt` and
 * `releasedById` left null (nobody recorded the hand-over here) — a fabricated
 * timestamp on a release record is worse than none. One audit row per check.
 * Conditional: a row whose status moved since it was listed is skipped.
 *
 * The portal is told only about a check it was told was available
 * (`tellPortal`): one RELEASED outbox event, PENDING and due now, the shape
 * `queueReleasedForStale` writes — which itself never sends a release with no
 * day, so it would not reach these. A check the portal never heard of gets none.
 */
export async function releaseClosedStillLive(
  db: PrismaClient,
  rows: readonly LiveClosedCandidate[],
  now: Date,
): Promise<{ released: number; portalQueued: number }> {
  let released = 0
  let portalQueued = 0
  const runIso = now.toISOString()
  for (const r of rows) {
    const out = await db.$transaction(async (tx) => {
      const moved = await tx.check.updateMany({
        where: { id: r.id, status: r.status, acumaticaStatus: 'Closed' },
        data: { status: 'RELEASED' },
      })
      if (!moved.count) return { ok: false, queued: false }
      let eventId: string | null = null
      if (r.tellPortal) {
        const ev = await tx.portalEvent.create({
          data: {
            checkId: r.id, direction: 'OUT', kind: 'RELEASED', status: 'PENDING',
            idempotencyKey: `${r.id}:RELEASED:acumatica-closed-${runIso}`,
            payload: { action: 'RELEASED', checkNumber: r.checkNumber },
            nextAttemptAt: now,
          },
        })
        await tx.check.update({
          where: { id: r.id },
          data: { portalSyncStatus: 'PENDING', portalDomain: portalRoute(r.eligibility) },
        })
        eventId = ev.id
      }
      await writeAudit(tx, {
        checkId: r.id, actorType: 'SYSTEM', action: RELEASED_FROM_CLOSED_ACTION,
        details: {
          from: r.status, to: 'RELEASED', acumaticaPaymentId: r.acumaticaPaymentId, acumaticaStatus: 'Closed',
          amount: r.amount, portalNotified: eventId !== null, portalEventId: eventId,
        },
        remarks: `${r.status} here, Closed (paid) in Acumatica. User ruling 2026-10-16: mark Closed as RELEASED. Status only; no release date recorded.`,
      })
      return { ok: true, queued: eventId !== null }
    }, TX_OPTIONS)
    if (out.ok) released += 1
    if (out.queued) portalQueued += 1
  }
  return { released, portalQueued }
}
