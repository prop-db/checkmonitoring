/**
 * Dry run of the outbox backlog (spec §2.5): what latest-wins would send if
 * the worker ran right now, without sending anything. Read-only — no writes,
 * no network call to the portal. Run this before the first production
 * delivery, and review the winners list with the client. The `stale` column
 * marks a winner the worker would close unsent because its kind no longer
 * matches the cheque's status (final review 2026-09-26).
 *
 * Usage:
 *   npx.cmd tsx scripts/portal-backlog.ts
 *   npx.cmd tsx scripts/portal-backlog.ts --queue-cancelled           # count only
 *   npx.cmd tsx scripts/portal-backlog.ts --queue-cancelled --apply   # writes
 *
 * --queue-cancelled: portal-routed cheques CANCELLED or VOIDED with an open
 * MARK_AVAILABLE and no CANCELLED event (cancelled before cancellations were
 * queued). With --apply, one CANCELLED event per such cheque is queued, with a
 * SYSTEM audit row, so the portal learns the cheque is gone. Idempotent.
 * Nothing is sent to the portal either way; the worker does that.
 *
 * Prints no amounts.
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { summariseBacklog, queueCancelledForStale } from '../lib/admin/portal-backlog'

const db = new PrismaClient()
const argv = process.argv.slice(2)

async function main() {
  if (argv.includes('--queue-cancelled')) {
    const apply = argv.includes('--apply')
    const r = await queueCancelledForStale(db, { now: new Date(), apply })
    console.log(`cancelled/voided cheques with an open MARK_AVAILABLE and no CANCELLED event: ${r.found}`)
    console.table(r.cheques.map((c) => ({ cheque: c.checkNumber, payee: c.payeeName ?? '', status: c.status, eligibility: c.eligibility })))
    console.log(apply ? `queued ${r.queued} CANCELLED event(s)` : 'dry run: nothing written (add --apply to queue)')
    return
  }
  if (argv.includes('--apply')) throw new Error('--apply only goes with --queue-cancelled; the default mode is read-only.')

  const s = await summariseBacklog(db)
  console.log(`open events: ${s.total}  would send: ${s.winners.length - s.stale}  would close as stale: ${s.stale}  would supersede: ${s.superseded}`)
  console.log('by kind:', s.byKind)
  console.table(s.winners.map((w) => ({
    kind: w.kind, cheque: w.checkNumber, payee: w.payeeName ?? '', status: w.checkStatus, eligibility: w.eligibility,
    stale: w.stale ? 'STALE' : '', queued: w.createdAt.toISOString().slice(0, 10),
  })))
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
