import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient, type CheckStatus } from '@prisma/client'
import { voidCheck } from '../lib/domain/actions'
import { LIVE_STATUSES } from '../lib/domain/check-status'

/**
 * Void every cheque Acumatica reports `Voided` that is still live — or RELEASED —
 * here. User instruction 2026-09-25: "void all 35, follow acumatica".
 *
 *   npx.cmd tsx scripts/void-acumatica-voided.ts           # dry run: lists them
 *   npx.cmd tsx scripts/void-acumatica-voided.ts --apply   # snapshot, then void each
 *
 * Each goes through `voidCheck`, the app's own path: the transition is checked,
 * `voidedAt` is set, and one audit row is written — `voided_after_release` for a
 * RELEASED cheque, whose release facts and receipt are deliberately kept. VOIDED
 * is terminal. Measured 2026-09-25: 18 SIGNED, 17 RELEASED (all imported from the
 * register at RELEASED; `6000089687` carries a supplier receipt). Prints cheque
 * numbers and amounts only. DATABASE_URL is PRODUCTION.
 */

const APPLY = process.argv.includes('--apply')
const TARGET: CheckStatus[] = [...LIVE_STATUSES, 'RELEASED']

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const rows = await db.check.findMany({
      where: { acumaticaStatus: 'Voided', status: { in: TARGET } },
      select: { id: true, checkNumber: true, status: true, amount: true, voidedAt: true, orNumber: true },
      orderBy: [{ status: 'asc' }, { checkNumber: 'asc' }],
    })
    console.log(`\nLive or RELEASED here, Voided in Acumatica: ${rows.length}`)
    for (const r of rows) {
      console.log(`  ${r.checkNumber.padEnd(12)} ${r.status.padEnd(18)} ${(r.amount?.toFixed(2) ?? 'no amount').padStart(14)}${r.orNumber ? '  receipt on file' : ''}`)
    }
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (rows.length === 0) { console.log('\nNothing to void.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `void-acumatica-voided-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify({
      takenAt: now.toISOString(),
      rows: rows.map((r) => ({ ...r, amount: r.amount?.toString() ?? null })),
    }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const by: Record<string, number> = {}
    for (const r of rows) {
      await voidCheck(db, { checkId: r.id, now, reason: `Voided in Acumatica while ${r.status} here. User instruction 2026-09-25: follow Acumatica.` })
      by[r.status] = (by[r.status] ?? 0) + 1
    }
    console.log('\nDONE  voided', by)
    const left = await db.check.count({ where: { acumaticaStatus: 'Voided', status: { in: TARGET } } })
    console.log(`  still live or RELEASED and Voided in Acumatica: ${left}\n`)
  } finally {
    await db.$disconnect()
  }
}

main()
