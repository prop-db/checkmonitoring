import { PrismaClient } from '@prisma/client'
import { backfillIncompleteFlags } from '../lib/admin/backfill-incomplete'

/**
 * Sets `Check.isIncomplete` on rows that pre-date the column.
 *
 *   npx tsx scripts/backfill-incomplete.ts [--dry-run]
 *
 * Measured against production on 2026-09-04: 129 of the 9,247 register-derived
 * cheques carry no amount. Migration `20260905000000_check_is_incomplete` runs
 * the same UPDATE, so a database migrated after this shipped is already
 * correct; this is the version to run again afterwards — after a re-import,
 * after a sync, or whenever the count on the dashboard looks wrong.
 *
 * It is idempotent: a second run reports 0 flagged and 0 unflagged. It prints
 * counts only — never a payee, never an amount, never a connection string.
 *
 * It reads `DATABASE_URL`, so it acts on whichever database that names. There
 * is deliberately no `--database` flag: a script that can be pointed at a
 * database by an argument is one that gets pointed at the wrong one.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const prisma = new PrismaClient()

  try {
    if (dryRun) {
      // The same two filters the backfill uses, counted rather than applied, so
      // the dry run cannot report a different number from the run that follows
      // it.
      const [toFlag, toUnflag, incomplete, total] = await Promise.all([
        prisma.check.count({ where: { amount: null, isIncomplete: false } }),
        prisma.check.count({ where: { amount: { not: null }, isIncomplete: true } }),
        prisma.check.count({ where: { isIncomplete: true } }),
        prisma.check.count(),
      ])
      console.log('DRY RUN — nothing written.')
      console.log(`  cheques:                       ${total}`)
      console.log(`  already flagged incomplete:    ${incomplete}`)
      console.log(`  would be flagged:              ${toFlag}`)
      console.log(`  would have the flag cleared:   ${toUnflag}`)
      return
    }

    const result = await backfillIncompleteFlags(prisma)
    console.log(`  cheques:                       ${result.total}`)
    console.log(`  flagged by this run:           ${result.flagged}`)
    console.log(`  flag cleared by this run:      ${result.unflagged}`)
    console.log(`  flagged incomplete in total:   ${result.incomplete}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
