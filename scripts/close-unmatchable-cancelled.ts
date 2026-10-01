/**
 * Close PARKED CANCELLED portal events whose cheque has no APV — events the
 * portal can never match, queued before voidCheck/cancelCheck stopped queuing
 * them (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §A2).
 *
 *   npx.cmd tsx scripts/close-unmatchable-cancelled.ts           # dry run: lists them
 *   npx.cmd tsx scripts/close-unmatchable-cancelled.ts --apply   # snapshot, then close each
 *
 * Nothing is sent to the portal. Prints no amounts. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findUnmatchableCancelled, closeUnmatchableCancelled } from '../lib/admin/unmatchable-cancelled'

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const rows = await findUnmatchableCancelled(db)
    console.log(`\nPARKED CANCELLED events whose cheque has no APV: ${rows.length}`)
    console.table(rows.map((r) => ({ cheque: r.checkNumber, payee: r.payeeName ?? '', event: r.eventId, tries: r.attempts, lastError: r.lastError ?? '' })))
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (rows.length === 0) { console.log('\nNothing to close.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `close-unmatchable-cancelled-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const cheques = await db.check.findMany({
      where: { id: { in: rows.map((r) => r.checkId) } },
      select: { id: true, checkNumber: true, portalSyncStatus: true, portalDomain: true },
    })
    const events = await db.portalEvent.findMany({ where: { id: { in: rows.map((r) => r.eventId) } } })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), events, cheques }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const closed = await closeUnmatchableCancelled(db, rows, now)
    console.log(`\nDONE  closed ${closed} of ${rows.length}`)
    console.log(`  still parked and unmatchable: ${(await findUnmatchableCancelled(db)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
