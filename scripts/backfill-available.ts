/**
 * Correct the cheques the importer put one rung too high.
 *
 * WHAT WAS WRONG. `implied-status.ts` read the register's AVAIL. sheets as
 * READY_FOR_RELEASE. They are not. Finance, 2026-09-04, on seeing 396 where
 * they expected 85: *"checks available are signed checks but not yet ready to
 * release"*. Being on an AVAIL. sheet means the cheque is signed and physically
 * in hand. Approving it for release is a separate act, recorded in a separate
 * document — `APPROVAL FOR RELEASE 9.4.2026.xlsx` — and that list is what
 * READY_FOR_RELEASE should have meant all along.
 *
 * The failure was silent, which is why it survived an import, a reconciliation
 * and a dashboard review: every one of the 396 was a real cheque at a real rung,
 * just one rung too high. Nothing looked broken; the number was simply wrong.
 *
 * WHAT THIS DOES, in order:
 *
 *   1. Every cheque now at READY_FOR_RELEASE because of an AVAIL. sheet goes
 *      back to SIGNED.
 *   2. Every cheque on the approval-for-release list — the ones carrying a bill
 *      from that workbook — moves up to READY_FOR_RELEASE.
 *
 * WHAT IT WILL NOT TOUCH. A cheque that is RELEASED, CANCELLED or VOIDED is
 * past this argument and stays where it is; three of the approval list's 84 are
 * voided and are left alone. Nothing is ever pulled down from RELEASED — that
 * would erase the record of money already handed over.
 *
 * Usage:
 *   npx.cmd tsx scripts/backfill-available.ts --dry-run
 *   npx.cmd tsx scripts/backfill-available.ts
 */

import 'dotenv/config'
import { PrismaClient, type Prisma } from '@prisma/client'
import { writeAudit } from '../lib/audit'

const DRY = process.argv.includes('--dry-run')
const db = new PrismaClient()

/**
 * A cheque is on the approval-for-release list exactly when it carries a bill
 * from that workbook — `importBills` writes one per approved row and nothing
 * else creates a `CheckBill`. That is a stronger test than a date or a status:
 * it is the document itself saying so.
 */
const ON_APPROVAL_LIST: Prisma.CheckWhereInput = { bills: { some: {} } }

/** Past this argument. Never moved by this script in either direction. */
const SETTLED: Prisma.CheckWhereInput = { status: { in: ['RELEASED', 'CANCELLED', 'VOIDED'] } }

async function move(
  where: Prisma.CheckWhereInput,
  to: 'SIGNED' | 'READY_FOR_RELEASE',
  reason: string,
): Promise<number> {
  const rows = await db.check.findMany({ where, select: { id: true, status: true, checkNumber: true } })
  if (DRY) return rows.length

  let moved = 0
  for (const c of rows) {
    await db.$transaction(async (tx) => {
      await tx.check.update({
        where: { id: c.id },
        // readyById stays null: no user approved these here. The approval is
        // recorded in the workbook, not in this system, and inventing an actor
        // on a release approval would be a false name on the audit trail.
        data: { status: to },
      })
      await writeAudit(tx, {
        checkId: c.id,
        actorType: 'SYSTEM',
        action: 'backfilled_available_correction',
        details: { from: c.status, to },
        remarks: reason,
      })
    })
    moved++
    if (moved % 100 === 0) process.stdout.write(`\r  ${to}: ${moved} of ${rows.length}`)
  }
  if (moved >= 100) process.stdout.write('\n')
  return moved
}

async function main() {
  const before = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\nBEFORE  ${before.map((g) => `${g.status}=${g._count._all}`).join('  ')}`)

  // Step 1: nothing is READY_FOR_RELEASE unless the approval list says so.
  //
  // Stated as "not on the list" rather than "came from an AVAIL. sheet",
  // because the first version filtered on the sheet name and missed cheque
  // 1791361821 — it reached READY_FOR_RELEASE through the AVAILABLE+FINDING
  // ruling, so its `sourceSheet` reads CHECK FINDING and no name match could
  // catch it. The rule Finance gave is about the approval document, not about
  // which sheet a row happened to be filed under, and expressing it that way
  // catches every route to the wrong rung rather than the one I thought of.
  const downWhere: Prisma.CheckWhereInput = {
    status: 'READY_FOR_RELEASE',
    NOT: { ...SETTLED },
    bills: { none: {} },
  }
  // Step 2: the approval list is what READY_FOR_RELEASE means. Run AFTER step 1,
  // so a cheque that is on both an AVAIL. sheet and the approval list ends up
  // approved rather than being demoted by step 1 and left there.
  const upWhere: Prisma.CheckWhereInput = {
    ...ON_APPROVAL_LIST,
    status: { in: ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED'] },
  }

  const [downCount, upCount] = await Promise.all([
    db.check.count({ where: downWhere }),
    // Counted against the state AFTER step 1, not before it.
    //
    // 62 of the approval list are currently READY_FOR_RELEASE *because* of an
    // AVAIL. sheet, so step 1 demotes them to SIGNED and step 2 promotes them
    // straight back. Counting `upWhere` here — which excludes READY_FOR_RELEASE
    // — would report 19 and then the real run would move 81, and a dry run that
    // under-reports what the real run does is worse than no dry run: it is the
    // number someone approves the change on.
    db.check.count({ where: { ...ON_APPROVAL_LIST, NOT: SETTLED } }),
  ])
  const settledOnList = await db.check.count({ where: { ...ON_APPROVAL_LIST, ...SETTLED } })

  console.log(`\nPLAN`)
  console.log(`  not on the approval list -> SIGNED             ${String(downCount).padStart(5)}`)
  console.log(`  approval list        -> READY_FOR_RELEASE      ${String(upCount).padStart(5)}`)
  console.log(`  on the list but already settled (untouched)    ${String(settledOnList).padStart(5)}`)

  if (DRY) { console.log('\nDRY RUN — nothing was written.\n'); return }

  const down = await move(
    downWhere, 'SIGNED',
    'Finance ruling 2026-09-04: an AVAIL. sheet means signed and in hand, not approved for release.',
  )
  const up = await move(
    upWhere, 'READY_FOR_RELEASE',
    'Finance ruling 2026-09-04: the APPROVAL FOR RELEASE workbook is the release list.',
  )

  const after = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\nWRITTEN`)
  console.log(`  demoted to SIGNED             ${down}`)
  console.log(`  promoted to READY_FOR_RELEASE ${up}`)
  console.log(`\nAFTER   ${after.map((g) => `${g.status}=${g._count._all}`).join('  ')}\n`)
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
