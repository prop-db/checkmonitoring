// scripts/backfill-check-books.ts
/**
 * Record the cheque book of every Acumatica cheque that has none (spec §D2).
 *
 *   npx.cmd tsx scripts/backfill-check-books.ts GOLIVE            # dry run
 *   npx.cmd tsx scripts/backfill-check-books.ts GOLIVE --apply    # snapshot, then set checkBookId, one audit row each
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
import { planCheckBookBackfill, applyCheckBookBackfill } from '../lib/admin/check-books'

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
    console.log(`  company mismatch (left): ${plan.companyMismatch.length}`)
    for (const m of plan.companyMismatch.slice(0, 20)) console.log(`    ${m.checkNumber} -> ${m.checkBookCode}`)
    console.log(`  payment not in the feed: ${plan.notInFeed}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (plan.candidates.length === 0) { console.log('\nNothing to set.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `check-books-${tenant}-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify({
      takenAt: now.toISOString(), tenant,
      // Every candidate was selected with no book, so the prior value is null by construction; stated anyway.
      candidates: plan.candidates.map((c) => ({ ...c, priorCheckBookId: null })),
    }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)
    const set = await applyCheckBookBackfill(db, plan.candidates)
    console.log(`\nDONE  set ${set} of ${plan.candidates.length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
