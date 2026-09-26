/**
 * Dry run of the outbox backlog (spec §2.5): what latest-wins would send if
 * the worker ran right now, without sending anything. Read-only — no writes,
 * no network call to the portal. Run this before the first production
 * delivery, and review the winners list with the client.
 *
 * Usage:
 *   npx.cmd tsx scripts/portal-backlog.ts
 *
 * Prints no amounts.
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { summariseBacklog } from '../lib/admin/portal-backlog'

const db = new PrismaClient()

async function main() {
  const s = await summariseBacklog(db)
  console.log(`open events: ${s.total}  would send: ${s.winners.length}  would supersede: ${s.superseded}`)
  console.log('by kind:', s.byKind)
  console.table(s.winners.map((w) => ({
    kind: w.kind, cheque: w.checkNumber, payee: w.payeeName ?? '', status: w.checkStatus, eligibility: w.eligibility, queued: w.createdAt.toISOString().slice(0, 10),
  })))
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
