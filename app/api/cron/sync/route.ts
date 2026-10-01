import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/db'
import { createClientForTenant } from '@/lib/integrations/acumatica/from-env'
import { SYNC_TENANTS } from '@/lib/admin/sync-overview'
import { runScheduledSync, type ScheduledSyncOutcome } from '@/lib/sync/scheduled'
import { runAutoSign } from '@/lib/sync/auto-sign'
import { kickPortalDelivery } from '@/lib/sync/portal-kick'

/**
 * THE SCHEDULED SYNC. Vercel calls this twice a day — `crons` in vercel.json,
 * `0 4 * * *` and `0 10 * * *` UTC, 12:00 and 18:00 Manila, and never drifts because the
 * Philippines has no daylight saving.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` DOES NOT RUN in this project. A route handler has nothing in
 * front of it, so this one authenticates on its first line: Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` when that environment variable exists,
 * and nothing else is allowed to trigger a read of the ERP.
 *
 * An UNSET secret refuses (500) rather than opening. The alternative — "no
 * secret configured, so anyone may run it" — is exactly the default that gets
 * shipped by accident.
 *
 * No session, no user. The run records itself as SCHEDULED.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Both tenants, in order, each inside `runScheduledSync`'s own try/catch, so
 * one tenant's trouble never skips the other. 500 if any tenant FAILED, so
 * Vercel's cron log shows the failure; a refusal for want of a watermark or a
 * run already in progress is recorded and is not a failure of the cron.
 *
 * Then AUTO-SIGN (lib/sync/auto-sign.ts): on a Manila Tuesday, the Acumatica
 * cheques first read on the Monday become SIGNED; on any other day the run
 * records IDLE. It runs even when a tenant failed, and its own failure also
 * turns the response 500.
 */

// ExcelJS is not involved, but the Prisma client is Node-only all the same.
export const runtime = 'nodejs'
// Never cached, never prerendered.
export const dynamic = 'force-dynamic'
/**
 * Hobby honours 60 with or without Fluid Compute. An incremental run is
 * seconds; the FULL path that would need more is refused by design.
 */
export const maxDuration = 60

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Constant-time on equal lengths; a length mismatch is refused outright. */
function bearerMatches(request: Request, secret: string): boolean {
  const presented = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

export async function GET(request: Request): Promise<Response> {
  // Read at request time, not module load, so a test can vary it and a
  // deployment that sets it later does not need a rebuild.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return json({ error: 'CRON_SECRET is not set. The scheduled sync refuses to run open.' }, 500)
  }
  if (!bearerMatches(request, secret)) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const now = new Date()
  const outcomes: ScheduledSyncOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    outcomes.push(
      await runScheduledSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }),
    )
  }

  // After both tenants, whether or not either failed: cheques already in the
  // app keep ageing, and a failed read delays new cheques, not old ones.
  // A 50s budget, inside the route's 60s ceiling: it leaves room for the
  // response to be written and stops the run cleanly, as FAILED with a
  // record of what is left, rather than being killed by the platform with
  // nothing written at all.
  const autoSign = await runAutoSign(prisma, { now, deadline: new Date(now.getTime() + 50_000) })

  // The outbox: retries and the backlog. Whatever budget is left inside the
  // route's 60s ceiling, minus room for the response.
  const remaining = 55_000 - (Date.now() - now.getTime())
  const portal = await kickPortalDelivery(prisma, { budgetMs: Math.max(remaining, 5_000) })

  // Delivery failures do not turn the cron 500 (they are recorded per event).
  const failed = outcomes.some((o) => o.outcome === 'FAILED') || autoSign.outcome === 'FAILED'
  return json({ ranAt: now.toISOString(), outcomes, autoSign, portal }, failed ? 500 : 200)
}
