import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { planRepair, snapshotOf, applyRepair, RULING } from '../lib/admin/repair-cr-receipts'

/**
 * Move the register's "CR 1234" values out of `crNumber` (the bank's clearing
 * reference) into the supplier-receipt columns, on the client's ruling of
 * 2026-09-11. See `lib/admin/repair-cr-receipts.ts` for what and why.
 *
 *   npx.cmd tsx scripts/repair-cr-receipts.ts            # dry run: counts only, writes nothing
 *   npx.cmd tsx scripts/repair-cr-receipts.ts --apply    # snapshot, then repair
 *
 * `--apply` first writes `snapshots/repair-cr-receipts-<timestamp>.json` with
 * every affected row as it stands — the snapshot CLAUDE.md item 7 says must
 * precede a bulk write, done by the script rather than by hand. The folder is
 * gitignored: the file holds cheque numbers.
 *
 * Prints counts only. Never a payee, never an amount. Reads `DATABASE_URL`, so
 * it acts on whichever database that names; there is deliberately no flag to
 * point it elsewhere.
 */

const APPLY = process.argv.includes('--apply')
const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number) =>
  console.log('  ' + label.padEnd(44) + n(value).padStart(8))

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    console.log(`\n${RULING}\n`)
    const plan = await planRepair(db)
    console.log('PLAN')
    line('cheques carrying any crNumber', plan.withCrNumber)
    line('  will be repaired (CR-shaped, no receipt, no clearing)', plan.candidates.length)
    line('  skipped: not CR-shaped', plan.skipped.NOT_CR_SHAPED)
    line('  skipped: a receipt is already recorded', plan.skipped.RECEIPT_ALREADY_RECORDED)
    line('  skipped: a clearing is recorded', plan.skipped.CLEARING_RECORDED)

    if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.\n'); return }
    if (plan.candidates.length === 0) { console.log('\nNothing to repair.\n'); return }

    const takenAt = new Date()
    const dir = join(process.cwd(), 'snapshots')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `repair-cr-receipts-${takenAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(file, JSON.stringify(snapshotOf(plan, takenAt), null, 2))
    console.log(`\nSnapshot written: ${file}`)

    const out = await applyRepair(db, plan)
    console.log('\nDONE')
    line('repaired', out.repaired)
    line('skipped because the row changed since the plan', out.raced)
    console.log('')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
