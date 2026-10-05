// scripts/backfill-check-books.ts
/**
 * Record the cheque book of every Acumatica cheque that has none (spec §D2),
 * and move every booked Acumatica cheque to the book Acumatica names — or
 * clear it when Acumatica names an account that is not a cheque book (§G1).
 *
 *   npx.cmd tsx scripts/backfill-check-books.ts GOLIVE            # dry run
 *   npx.cmd tsx scripts/backfill-check-books.ts GOLIVE --apply    # snapshot, then fill, realign, clear; one audit row each
 *   (likewise MANUFACTURING)
 *
 * Reads Acumatica (read-only). Writes checkBookId only, never status. Prints
 * counts and codes only. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { createClientForTenant } from '../lib/integrations/acumatica/from-env'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'
import { planCheckBookBackfill, applyCheckBookBackfill, applyCheckBookRealign } from '../lib/admin/check-books'

const args = process.argv.slice(2)
const tenant = args.find((a) => !a.startsWith('--')) as AcumaticaTenant | undefined
const APPLY = args.includes('--apply')

async function main(): Promise<void> {
  if (tenant !== 'GOLIVE' && tenant !== 'MANUFACTURING') throw new Error('Name a tenant: GOLIVE or MANUFACTURING')
  const db = new PrismaClient()
  try {
    const plan = await planCheckBookBackfill(db, createClientForTenant(tenant), tenant)
    console.log(`\nTENANT ${tenant}`)
    console.log(`cheques with a payment id and no cheque book: ${plan.scanned}`)
    console.log(`  would set:              ${plan.candidates.length}`)
    const byBook: Record<string, number> = {}
    for (const c of plan.candidates) byBook[c.checkBookCode] = (byBook[c.checkBookCode] ?? 0) + 1
    for (const [code, n] of Object.entries(byBook).sort((a, b) => b[1] - a[1])) console.log(`    ${code.padEnd(14)} ${n}`)
    console.log(`  not a cheque book:      ${Object.values(plan.notABook).reduce((a, b) => a + b, 0)}`, plan.notABook)
    console.log(`  payment not in the feed: ${plan.notInFeed}`)
    // Spec §G1: booked cheques whose book differs from Acumatica's.
    console.log(`would realign: ${plan.realign.length}`)
    const byPair: Record<string, number> = {}
    for (const r of plan.realign) { const k = `${r.fromCode} -> ${r.code}`; byPair[k] = (byPair[k] ?? 0) + 1 }
    for (const [pair, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) console.log(`    ${pair.padEnd(28)} ${n}`)
    console.log(`would clear: ${plan.clear.length}`)
    const byCode: Record<string, number> = {}
    for (const r of plan.clear) byCode[r.code] = (byCode[r.code] ?? 0) + 1
    for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) console.log(`    ${code.padEnd(14)} ${n}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (plan.candidates.length + plan.realign.length + plan.clear.length === 0) { console.log('\nNothing to change.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `check-books-${tenant}-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify({
      takenAt: now.toISOString(), tenant,
      // Every candidate was selected with no book, so the prior value is null by construction; stated anyway.
      candidates: plan.candidates.map((c) => ({ ...c, priorCheckBookId: null })),
      // The prior book of each is fromCheckBookId / fromCode.
      realign: plan.realign,
      clear: plan.clear,
    }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)
    const set = await applyCheckBookBackfill(db, plan.candidates)
    console.log(`\nDONE  set ${set} of ${plan.candidates.length}`)
    const realigned = await applyCheckBookRealign(db, plan.realign)
    console.log(`DONE  realigned ${realigned} of ${plan.realign.length}`)
    const cleared = await applyCheckBookRealign(db, plan.clear)
    console.log(`DONE  cleared ${cleared} of ${plan.clear.length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
