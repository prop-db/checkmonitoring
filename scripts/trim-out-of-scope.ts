/**
 * Remove the Acumatica-only records that a full sync imported before the scope
 * was settled.
 *
 * WHAT HAPPENED. On 2026-09-04 the SYNC NOW button ran a FULL sync of the
 * GO-LIVE tenant, which creates a cheque for every AP payment Acumatica holds,
 * not just the ones in the workbook register. Vercel killed it partway, leaving
 * 12,570 Acumatica-only records alongside the 9,247 from the register.
 *
 * THE RULING (Finance, 2026-09-04). This is a cheque monitoring system for the
 * current year's work, not an AP ledger and not an archive. Keep everything the
 * register contains — that is the document Finance actually maintains, and it
 * spans 2025-04-07 to 2026-09-17. Drop the Acumatica-only records dated before
 * 2026.
 *
 * SCOPE, precisely: `sourceSheet IS NULL` (so it came from Acumatica, never
 * from the workbook) AND `checkDate < 2026-01-01`. A register row is never
 * touched whatever its date, which is why the filter tests provenance first and
 * date second.
 *
 * Verified before writing this: of the 12,530 in scope, 0 carry a bill, 0 carry
 * a portal event, and 0 have been signed, made ready or released by anyone. One
 * staged register row had been promoted to one of them; its pointer is cleared
 * so the row returns to unpromoted rather than dangling at a cheque that no
 * longer exists.
 *
 * The audit rows detach rather than dying — 13,818 of them keep their action,
 * actor and timestamp with `checkId` blanked, which is the one mutation the
 * append-only trigger permits. One summary row records why the cheques went.
 *
 * Usage:
 *   npx.cmd tsx scripts/trim-out-of-scope.ts --dry-run
 *   npx.cmd tsx scripts/trim-out-of-scope.ts
 */

import 'dotenv/config'
import { PrismaClient, type Prisma } from '@prisma/client'
import { writeAudit } from '../lib/audit'

const DRY = process.argv.includes('--dry-run')
const db = new PrismaClient()

/**
 * The scope boundary. Named, not inlined, because it is a Finance decision
 * rather than an implementation detail — and because `lib/sync/run.ts` filters
 * on the same date so removed records cannot walk back in on the next sync.
 * Change both or neither.
 */
export const IN_SCOPE_FROM = new Date('2026-01-01T00:00:00.000Z')

// Provenance FIRST. A register row is out of scope for deletion whatever its
// date; only records Acumatica alone supplied are eligible.
const OUT_OF_SCOPE: Prisma.CheckWhereInput = {
  sourceSheet: null,
  checkDate: { lt: IN_SCOPE_FROM },
}

async function main() {
  const [total, doomed, registerRows, keptAcumatica] = await Promise.all([
    db.check.count(),
    db.check.count({ where: OUT_OF_SCOPE }),
    db.check.count({ where: { NOT: { sourceSheet: null } } }),
    db.check.count({ where: { sourceSheet: null, NOT: { checkDate: { lt: IN_SCOPE_FROM } } } }),
  ])

  console.log(`\nBEFORE`)
  console.log(`  records                       ${total.toLocaleString()}`)
  console.log(`    from the register (kept)    ${registerRows.toLocaleString()}`)
  console.log(`    Acumatica, 2026+ (kept)     ${keptAcumatica.toLocaleString()}`)
  console.log(`    Acumatica, pre-2026         ${doomed.toLocaleString()}   <- to remove`)

  // Re-assert the safety facts at run time rather than trusting the note above:
  // this deletes from production, and the measurements were taken earlier.
  const [bills, events, touched] = await Promise.all([
    db.checkBill.count({ where: { check: OUT_OF_SCOPE } }),
    db.portalEvent.count({ where: { check: OUT_OF_SCOPE } }),
    db.check.count({
      where: {
        ...OUT_OF_SCOPE,
        OR: [{ signedById: { not: null } }, { readyById: { not: null } }, { releasedById: { not: null } }],
      },
    }),
  ])
  console.log(`\nSAFETY CHECKS`)
  console.log(`  bills attached                ${bills}`)
  console.log(`  portal events                 ${events}`)
  console.log(`  touched by a Finance user     ${touched}`)

  if (events > 0 || touched > 0) {
    // Refuse rather than proceed. A portal event means a supplier was told
    // something about this cheque; a Finance actor means somebody worked on it.
    // Either makes the record history, not import residue.
    throw new Error(
      'Refusing to delete: some records carry a portal event or a Finance action. ' +
      'Those are history, not import residue. Investigate before re-running.',
    )
  }

  if (DRY) {
    console.log(`\nDRY RUN — nothing was written. ${doomed.toLocaleString()} records would go, ` +
      `leaving ${(total - doomed).toLocaleString()}.\n`)
    return
  }

  // `promotedCheckId` has no foreign key, so nothing would stop it pointing at
  // a deleted row. Clear it first: the staged row goes back to unpromoted,
  // which is true again once its cheque is gone.
  const ids = (await db.check.findMany({ where: OUT_OF_SCOPE, select: { id: true } })).map((c) => c.id)
  let unpromoted = 0
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await db.stagedCheck.updateMany({
      where: { promotedCheckId: { in: ids.slice(i, i + 1000) } },
      data: { promotedCheckId: null },
    })
    unpromoted += r.count
  }

  // One summary row, not 12,530. The per-cheque audit rows survive the delete
  // with `checkId` blanked, so the record of what happened to each is intact;
  // what is missing without this is WHY they all went at once.
  await writeAudit(db, {
    actorType: 'SYSTEM',
    action: 'bulk_removed_out_of_scope',
    details: {
      removed: doomed,
      criteria: 'sourceSheet IS NULL AND checkDate < 2026-01-01',
      reason:
        'Finance ruling 2026-09-04: this is a cheque monitoring system for current work. ' +
        'A full Acumatica sync had imported AP payment history that was never in the register.',
      stagedRowsUnpromoted: unpromoted,
    },
  })

  let deleted = 0
  for (let i = 0; i < ids.length; i += 500) {
    const r = await db.check.deleteMany({ where: { id: { in: ids.slice(i, i + 500) } } })
    deleted += r.count
    process.stdout.write(`\r  deleted ${deleted.toLocaleString()} of ${ids.length.toLocaleString()}`)
  }
  process.stdout.write('\n')

  const [after, orphanAudit] = await Promise.all([
    db.check.count(),
    db.auditLog.count({ where: { checkId: null } }),
  ])
  console.log(`\nAFTER`)
  console.log(`  records                       ${after.toLocaleString()}`)
  console.log(`  deleted                       ${deleted.toLocaleString()}`)
  console.log(`  staged rows unpromoted        ${unpromoted}`)
  console.log(`  audit rows detached, not lost ${orphanAudit.toLocaleString()}\n`)
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
