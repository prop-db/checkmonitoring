/**
 * Record the cheques Acumatica reports as `Closed` as RELEASED.
 *
 * WHY. After the first full sync, 4,177 cheques sat at SIGNATURE_PENDING and
 * the dashboard told Finance they all needed signing. Most had left the bank
 * months ago: they came from Acumatica, the register had never recorded them,
 * and SIGNATURE_PENDING is simply the safe default for a payment no sheet
 * asserts anything about.
 *
 * WHAT "Closed" MEANS, measured rather than assumed. Across the 6,243 cheques
 * both sources know, our status against Acumatica's:
 *
 *     RELEASED           Closed      5,396
 *     SIGNED             Balanced      300
 *     CANCELLED          Voided        284
 *     VOIDED             Voided        112
 *     READY_FOR_RELEASE  Balanced       59
 *     RELEASED           Balanced        3
 *
 * `Closed` is RELEASED in 5,396 of 5,449 cases — 99%. The register itself is
 * the evidence; nobody had to describe the ERP's semantics.
 *
 * WHAT THIS WILL NOT TOUCH. Only a cheque still at SIGNATURE_PENDING moves.
 * Anything the register placed, or a Finance user has acted on, is left exactly
 * where it is — including the 42 cheques that are `Closed` in Acumatica and
 * CANCELLED here, which is the 1% the rule gets wrong and the reason it is
 * applied only to the default rung rather than everywhere.
 *
 * THE LADDER IS DELIBERATELY BYPASSED, and this is the one thing to read
 * carefully. `assertTransition` forbids SIGNATURE_PENDING -> RELEASED: a cheque
 * must be signed and made available first. That rule is right for a cheque
 * moving through THIS system, and wrong for one that was released before this
 * system existed. Walking each cheque up the ladder instead would fabricate a
 * signing and an approval that never happened here, and write three audit rows
 * asserting acts nobody performed. Recording the destination once, with an
 * audit row that says plainly it did not walk the ladder, is the honest option.
 *
 * `releasedById` stays null and the actor is SYSTEM for the same reason: no
 * user released these here, and a fabricated name on a release record is worse
 * than an absent one.
 *
 * Usage:
 *   npx.cmd tsx scripts/backfill-closed-released.ts --dry-run
 *   npx.cmd tsx scripts/backfill-closed-released.ts
 */

import 'dotenv/config'
import { PrismaClient, type Prisma } from '@prisma/client'
import { writeAudit } from '../lib/audit'

const DRY = process.argv.includes('--dry-run')
const db = new PrismaClient()

/** Acumatica's own word for a payment that has been released and applied. */
const CLOSED = 'Closed'

const WHERE: Prisma.CheckWhereInput = {
  status: 'SIGNATURE_PENDING',
  acumaticaStatus: CLOSED,
}

async function main() {
  const before = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\nBEFORE  ${before.map((g) => `${g.status}=${g._count._all}`).join('  ')}`)

  const rows = await db.check.findMany({
    where: WHERE,
    select: { id: true, checkNumber: true, sourceSheet: true, checkDate: true },
  })

  // Split by provenance for the report. A register-sourced row at
  // SIGNATURE_PENDING got there from a sheet that asserts nothing about signing
  // (the pending registers), so it is the same default as an Acumatica row —
  // but the reader should see how many of each are moving rather than take it
  // on trust.
  const fromRegister = rows.filter((r) => r.sourceSheet !== null).length

  // What is deliberately left alone, shown rather than implied.
  const [closedButPlaced, balanced] = await Promise.all([
    db.check.count({ where: { acumaticaStatus: CLOSED, status: { not: 'SIGNATURE_PENDING' } } }),
    db.check.count({ where: { status: 'SIGNATURE_PENDING', acumaticaStatus: { not: CLOSED } } }),
  ])

  console.log(`\nTO RELEASE  (SIGNATURE_PENDING and Closed in Acumatica)`)
  console.log(`  total                         ${String(rows.length).padStart(6)}`)
  console.log(`    from Acumatica only         ${String(rows.length - fromRegister).padStart(6)}`)
  console.log(`    from the register           ${String(fromRegister).padStart(6)}`)
  console.log(`\nLEFT ALONE`)
  console.log(`  Closed, but already placed    ${String(closedButPlaced).padStart(6)}  (register or Finance said otherwise)`)
  console.log(`  pending, not Closed           ${String(balanced).padStart(6)}  (genuinely awaiting release)`)

  if (DRY) { console.log('\nDRY RUN — nothing was written.\n'); return }

  let moved = 0
  for (const c of rows) {
    await db.$transaction(async (tx) => {
      await tx.check.update({
        where: { id: c.id },
        // releasedById stays null: nobody released this here.
        data: { status: 'RELEASED' },
      })
      await writeAudit(tx, {
        checkId: c.id,
        actorType: 'SYSTEM',
        action: 'backfilled_released_from_acumatica',
        details: { from: 'SIGNATURE_PENDING', to: 'RELEASED', acumaticaStatus: CLOSED },
        remarks:
          'Acumatica reports this payment as Closed, which its own register proves means released ' +
          '(5,396 of 5,449 cases). Recorded directly rather than walked up the ladder: the cheque ' +
          'was released before this system existed, and no user signed or approved it here.',
      })
    })
    moved++
    if (moved % 250 === 0) process.stdout.write(`\r  released ${moved} of ${rows.length}`)
  }
  if (moved >= 250) process.stdout.write('\n')

  const after = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\nWRITTEN`)
  console.log(`  recorded as released          ${moved}`)
  console.log(`\nAFTER   ${after.map((g) => `${g.status}=${g._count._all}`).join('  ')}\n`)
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
