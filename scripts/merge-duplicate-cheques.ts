import { PrismaClient } from '@prisma/client'
import { mergeDuplicateCheques, type MergeRefusalReason } from '../lib/admin/merge-duplicates'

/**
 * Merges the cheques that were stored twice, one row per source.
 *
 *   npx tsx scripts/merge-duplicate-cheques.ts --dry-run
 *   npx tsx scripts/merge-duplicate-cheques.ts
 *
 * 1,865 physical cheques exist as two rows: one from the register, whose
 * company came from the cheque book, and one from the Acumatica sync, whose
 * company came from the payment's `Branch`. Duplicate prevention keyed on
 * `(companyId, checkNumber)`, so the disagreement read as two cheques.
 * `upsertCheck` no longer creates them; this removes the ones already there.
 *
 * The register row survives with its status, sheet, bills and audit history
 * intact and only its company corrected — the client's ruling of 2026-09-06,
 * "FOLLOW ACUMATICA SINCE IT IS ALREADY DEPOSITED". The Acumatica-only row is
 * deleted; its audit rows detach rather than dying.
 *
 * Idempotent: a second run reports 0 duplicates and merges nothing.
 *
 * It prints counts and cheque numbers only — never a payee, never an amount,
 * never a connection string. It reads `DATABASE_URL`, so it acts on whichever
 * database that names; there is deliberately no `--database` flag, for the same
 * reason `backfill-incomplete.ts` has none.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const prisma = new PrismaClient()

  try {
    const summary = await mergeDuplicateCheques(prisma, { dryRun, now: new Date() })

    if (dryRun) console.log('DRY RUN — nothing written.')
    const line = (label: string, value: number) =>
      console.log(`  ${label.padEnd(34)} ${value}`)

    line('duplicate cheque numbers:', summary.duplicateNumbersBefore)
    line(dryRun ? 'would merge:' : 'merged:', summary.merged)
    line('refused:', summary.refused.length)
    line(dryRun ? 'would remain duplicated:' : 'still duplicated:', summary.duplicateNumbersAfter)
    // A count, never the figures. The register's amount survives the merge
    // untouched; a non-zero here is a separate question for Finance.
    line('pairs whose amounts differ:', summary.amountsDiffer)

    if (summary.refused.length > 0) {
      console.log('\nRefused, and why:')
      const reasons = Object.entries(summary.refusedByReason)
        .filter(([, count]) => count > 0) as [MergeRefusalReason, number][]
      for (const [reason, count] of reasons) console.log(`  ${reason}: ${count}`)

      console.log('\nCheque numbers (first 50):')
      for (const r of summary.refused.slice(0, 50)) {
        console.log(`  ${r.checkNumber}  ${r.reason}  ${r.detail}`)
      }
      if (summary.refused.length > 50) {
        console.log(`  ...and ${summary.refused.length - 50} more.`)
      }
    }

    if (!dryRun && summary.duplicateNumbersAfter > 0) {
      console.log(
        '\nDuplicates remain. Every one of them is listed above with the reason it was not ' +
          'merged; each needs a human.',
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
