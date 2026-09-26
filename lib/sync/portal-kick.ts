import type { Prisma, PrismaClient } from '@prisma/client'
import { after as nextAfter } from 'next/server'
import { createPortalClientFromEnv } from '@/lib/integrations/portal/from-env'
import type { PortalClient } from '@/lib/integrations/portal/client'
import { deliverPortalEvents, type PortalOutboxOutcome } from './portal-outbox'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Best-effort delivery within a time budget: from a server action (after the
 * response, via next/server `after`), from the cron, from the admin button.
 * Never throws - a portal outage must never fail a Finance action, and an
 * unconfigured portal is a skip that says which setting is missing (the
 * message names the setting, never a value).
 */
export async function kickPortalDelivery(
  db: Db, args: { budgetMs: number; client?: PortalClient; now?: Date },
): Promise<PortalOutboxOutcome | { skipped: string }> {
  const now = args.now ?? new Date()
  let client = args.client
  if (!client) {
    try { client = createPortalClientFromEnv() }
    catch (e) { return { skipped: (e instanceof Error ? e.message : String(e)).split(',')[0] } }
  }
  try {
    return await deliverPortalEvents(db, { now, deadline: new Date(now.getTime() + args.budgetMs), client })
  } catch (e) {
    console.error('portal delivery failed:', e instanceof Error ? e.message : e)
    return { delivered: 0, synced: 0, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Schedules `fn` to run after the response is sent, via next/server `after`
 * (or an injected `afterImpl` for tests) - so a Finance user is never made
 * to wait on the portal.
 *
 * OUTSIDE A REQUEST SCOPE (this repo's own tests call server actions
 * directly, not through Next's request pipeline) `after` throws rather than
 * scheduling anything. There is no response to wait for in that case, and no
 * need to kick the portal here either: the daily cron and the admin button
 * already cover delivery (spec 2026-09-26-check-monitoring-integration-design
 * §2.4). That specific error is swallowed; anything else is a real bug and
 * must propagate.
 */
export function afterResponse(
  fn: () => Promise<unknown>,
  afterImpl: (fn: () => Promise<unknown>) => void = nextAfter,
): void {
  try {
    afterImpl(fn)
  } catch (e) {
    if (e instanceof Error && /outside a request scope/i.test(e.message)) return
    throw e
  }
}
