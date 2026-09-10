import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/db'
import { createClientForTenant } from '@/lib/integrations/acumatica/from-env'
import { SYNC_TENANTS } from '@/lib/admin/sync-overview'
import { runScheduledSync, type ScheduledSyncOutcome } from '@/lib/sync/scheduled'

/**
 * THE SCHEDULED SYNC. Vercel calls this once a day — `crons` in vercel.json,
 * `0 10 * * *` UTC, which is 18:00 Manila and never drifts because the
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

  const failed = outcomes.some((o) => o.outcome === 'FAILED')
  return json({ ranAt: now.toISOString(), outcomes }, failed ? 500 : 200)
}
