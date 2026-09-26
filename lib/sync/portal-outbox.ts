import type { Prisma, PrismaClient, PortalEvent } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import {
  buildPortalEventBody, PortalPayloadError, type PortalClient, type PortalDeliveryResult,
} from '@/lib/integrations/portal/client'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * THE OUTBOX WORKER (spec 2026-09-26-check-monitoring-integration-design §2.3).
 *
 * Latest wins per cheque. The portal is told the cheque's current truth, not
 * its history: among a cheque's non-terminal events only the newest is
 * delivered and the older ones are closed as superseded. This is what makes
 * the backlog queued since 2026-09-04 safe to drain - a stale MARK_AVAILABLE
 * for a cheque since released must not email a supplier "ready for pickup"
 * seconds before "picked up".
 *
 * Claims are exclusive (a conditional updateMany), backoff is a timestamp so
 * the worker stays stateless, and PARKED is the human's queue.
 */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const
const DAILY_MS = 24 * 3_600_000
export const MAX_ATTEMPTS = 12
export const UNMATCHED_MAX_ATTEMPTS = 7
/** A claim older than this belongs to a run the platform killed. */
export const STALE_CLAIM_MS = 10 * 60_000

export type PortalOutboxOutcome = {
  delivered: number
  synced: number
  failed: number
  parked: number
  superseded: number
  stoppedAtDeadline: boolean
  error?: string
}

function backoff(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? DAILY_MS
}

const cap = (s: string) => s.slice(0, 300)

/**
 * Audit rows are written in the same transaction as the change they record
 * (global constraint). A caller already inside a transaction passes its
 * TransactionClient, which has no $transaction of its own: run inline there.
 */
async function atomically<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return '$transaction' in db ? db.$transaction((tx) => fn(tx)) : fn(db)
}

type Verdict =
  | { status: 'SYNCED'; releaseId: number | null; note?: string }
  | { status: 'FAILED'; error: string; delayMs: number; maxAttempts: number }
  | { status: 'PARKED'; error: string }

function judge(res: PortalDeliveryResult, attempts: number): Verdict {
  if (res.status === 200 && res.body) {
    // Precedence (spec §2.3 step 3): refused, then nothing matched, then synced.
    const refused = res.body.results.find((r) => r.outcome === 'refused')
    if (refused) return { status: 'PARKED', error: `refused ${refused.ref}: ${refused.reason ?? 'no reason given'}` }
    if (res.body.results.length === 0) {
      // The portal receives bills from Acumatica nightly; a cheque can precede
      // its bill, so an unmatched cheque is retried daily for a week.
      return { status: 'FAILED', error: `unmatched: ${res.body.unmatched.join(', ')}`, delayMs: DAILY_MS, maxAttempts: UNMATCHED_MAX_ATTEMPTS }
    }
    const first = res.body.results.find((r) => r.releaseId !== null)
    const note = res.body.unmatched.length ? `unmatched: ${res.body.unmatched.join(', ')}` : undefined
    return { status: 'SYNCED', releaseId: first?.releaseId ?? null, note }
  }
  if (res.status === 401) return { status: 'PARKED', error: 'portal refused the token (401): check PORTAL_TOKEN' }
  if (res.status === 400) return { status: 'PARKED', error: 'portal rejected the payload (400)' }
  return { status: 'FAILED', error: `portal answered ${res.status}`, delayMs: backoff(attempts), maxAttempts: MAX_ATTEMPTS }
}

/**
 * `flagCheck` is false when the cheque must not carry portal state: an
 * INTERNAL cheque (the database's check_internal_never_routes_to_portal
 * constraint requires portalSyncStatus = NOT_APPLICABLE) or one that no
 * longer exists. The event row and the audit are still written.
 *
 * The settle is conditional on this run still holding the claim (review fix
 * 2026-09-26): if another run reclaimed the row as stale and settled it first,
 * the event row, the cheque and the audit are left to that run's settle and
 * this returns null (counted as nothing).
 */
async function settle(
  db: Db, ev: PortalEvent, verdict: Verdict, now: Date, flagCheck: boolean, claimedBy: string,
): Promise<Verdict['status'] | null> {
  const attempts = ev.attempts + 1
  let status: Verdict['status'] = verdict.status
  let lastError: string | null = null
  let nextAttemptAt = ev.nextAttemptAt
  if (verdict.status === 'FAILED') {
    lastError = cap(verdict.error)
    if (attempts >= verdict.maxAttempts) status = 'PARKED'
    else nextAttemptAt = new Date(now.getTime() + verdict.delayMs)
  } else if (verdict.status === 'PARKED') {
    lastError = cap(verdict.error)
  } else if (verdict.note) {
    lastError = cap(verdict.note)
  }
  const held = await atomically(db, async (tx) => {
    const r = await tx.portalEvent.updateMany({
      where: { id: ev.id, status: 'IN_FLIGHT', claimedBy },
      data: { status, attempts, lastError, nextAttemptAt },
    })
    if (!r.count) return false
    if (!flagCheck) {
      // no cheque-level portal state to write
    } else if (status === 'SYNCED') {
      await tx.check.update({
        where: { id: ev.checkId },
        data: { portalSyncStatus: 'SYNCED', ...(verdict.status === 'SYNCED' && verdict.releaseId !== null ? { portalTradeId: verdict.releaseId } : {}) },
      })
    } else if (status === 'PARKED') {
      await tx.check.update({ where: { id: ev.checkId }, data: { portalSyncStatus: 'FAILED' } })
    }
    await writeAudit(tx, {
      checkId: ev.checkId, actorType: 'SYSTEM', action: `portal_event_${status.toLowerCase()}`,
      details: { eventId: ev.id, kind: ev.kind, attempts, lastError },
    })
    return true
  })
  return held ? status : null
}

/**
 * Drain the outbox once.
 *
 * Contract: `deadline` must be derived from the same `now` the caller passes
 * (e.g. `deadline = new Date(now.getTime() + budgetMs)`). The worker's clock
 * is `now` plus the wall time this run has spent, so a deadline taken from a
 * different clock would stop the run too early or never.
 */
export async function deliverPortalEvents(
  db: Db,
  args: { now: Date; deadline: Date; client: PortalClient; claimedBy?: string },
): Promise<PortalOutboxOutcome> {
  const out: PortalOutboxOutcome = { delivered: 0, synced: 0, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false }
  const claimedBy = args.claimedBy ?? `run-${args.now.toISOString()}`
  const staleBefore = new Date(args.now.getTime() - STALE_CLAIM_MS)
  // The run's clock is `now` advanced by the wall time this run has spent, so
  // the deadline is judged on the same clock as `now` (the caller passes
  // new Date() in production; a test's fixed `now` is not overtaken by the
  // real date).
  const startedWall = Date.now()
  const clock = () => args.now.getTime() + (Date.now() - startedWall)
  const pastDeadline = () => clock() > args.deadline.getTime()

  // Every non-terminal event, oldest first, so the newest per cheque is the
  // last one seen. Latest-wins runs over ALL of them, not only the ones due
  // now: a due MARK_AVAILABLE must not go out while a newer RELEASED for the
  // same cheque sits in backoff. A stale IN_FLIGHT claim is retried.
  const open = await db.portalEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED', 'IN_FLIGHT'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const isLive = (ev: PortalEvent) =>
    ev.status === 'IN_FLIGHT' && ev.claimedAt !== null && ev.claimedAt.getTime() >= staleBefore.getTime()
  // A live claim freezes its whole cheque for this run (spec §2.3 step 1;
  // review fix 2026-09-26). Protecting only the live row was not enough: a
  // newer PENDING event for the same cheque was still delivered while the
  // older one was in flight, so the portal could apply them out of order
  // (MARK_AVAILABLE after RELEASED). The cheque is reconsidered next run,
  // once the live claim has settled or gone stale.
  const frozen = new Set(open.filter(isLive).map((ev) => ev.checkId))
  const newest = new Map<string, PortalEvent>()
  for (const ev of open) if (!frozen.has(ev.checkId)) newest.set(ev.checkId, ev)

  for (const ev of open) {
    if (frozen.has(ev.checkId)) continue
    const winner = newest.get(ev.checkId)!
    if (winner.id === ev.id) continue
    if (pastDeadline()) { out.stoppedAtDeadline = true; return out }
    const lastError = `superseded by ${winner.id}`
    const closed = await atomically(db, async (tx) => {
      const r = await tx.portalEvent.updateMany({
        where: { id: ev.id, status: ev.status, claimedAt: ev.claimedAt },
        data: { status: 'SYNCED', lastError },
      })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: ev.checkId, actorType: 'SYSTEM', action: 'portal_event_synced',
        // `superseded: true` tells a row closed unsent from a delivered SYNCED.
        details: { eventId: ev.id, kind: ev.kind, attempts: ev.attempts, lastError, supersededBy: winner.id, superseded: true },
      })
      return true
    })
    if (closed) out.superseded += 1
  }

  for (const ev of newest.values()) {
    if (pastDeadline()) { out.stoppedAtDeadline = true; break }
    if (ev.status !== 'IN_FLIGHT' && ev.nextAttemptAt.getTime() > args.now.getTime()) continue

    // One bad row never aborts the run (review fix 2026-09-26): an unexpected
    // error (a DB failure, say) is recorded and the next event is tried. The
    // row is left as it stands; an IN_FLIGHT claim goes stale and is retried.
    try {
      // Exclusive claim: conditional on the row still being exactly as read
      // (status and claim), so two runs - or a run and a stale-claim retry -
      // cannot both deliver it. claimedAt is the run clock at claim time
      // (review fix 2026-09-26), so staleness is measured from the real claim.
      const claim = await db.portalEvent.updateMany({
        where: { id: ev.id, status: ev.status, claimedAt: ev.claimedAt },
        data: { status: 'IN_FLIGHT', claimedAt: new Date(clock()), claimedBy },
      })
      if (!claim.count) continue

      const check = await db.check.findUnique({
        where: { id: ev.checkId },
        include: { cashAccount: { include: { bank: true } }, checkBook: { include: { bank: true } }, bills: true },
      })
      if (!check) {
        if (await settle(db, ev, { status: 'PARKED', error: 'cheque no longer exists' }, args.now, false, claimedBy)) out.parked += 1
        continue
      }

      let verdict: Verdict
      try {
        // RULE 2 is asserted inside buildPortalEventBody; an INTERNAL cheque
        // throws before any request exists and parks below.
        const body = buildPortalEventBody({ id: ev.id, kind: ev.kind }, check)
        out.delivered += 1
        verdict = judge(await args.client.deliver(body), ev.attempts + 1)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // A payload defect (INTERNAL cheque, missing required date) never fixes
        // itself by retrying: park it for a human. Anything else thrown is a
        // delivery failure and backs off.
        verdict = e instanceof PortalPayloadError
          ? { status: 'PARKED', error: message }
          : { status: 'FAILED', error: message, delayMs: backoff(ev.attempts + 1), maxAttempts: MAX_ATTEMPTS }
      }
      // null: another run reclaimed the row and settled it first - count nothing.
      const status = await settle(db, ev, verdict, args.now, check.eligibility !== 'INTERNAL', claimedBy)
      if (status === 'SYNCED') out.synced += 1
      else if (status === 'FAILED') out.failed += 1
      else if (status === 'PARKED') out.parked += 1
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`portal outbox: event ${ev.id} (cheque ${ev.checkId}) failed unexpectedly: ${message}`)
      out.error ??= cap(`event ${ev.id}: ${message}`)
    }
  }
  return out
}
