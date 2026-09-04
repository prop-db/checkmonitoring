/**
 * One-time backfill: cheques dated August and September 2026 that are still
 * awaiting a signature are already signed in reality.
 *
 * THE RULING (Finance, 2026-09-04). The workbook register records where each
 * cheque got to, but it was never maintained as a signature log — so cheques
 * the team signed weeks ago still import as SIGNATURE_PENDING. Everything dated
 * August 2026 or later has in fact been signed and is waiting for the READY FOR
 * RELEASE tick. From here on the encoder ticks signatures in the app and this
 * script is never needed again.
 *
 * WHAT IT WILL NOT DO. Only a cheque still at SIGNATURE_PENDING moves. A cheque
 * the register says is RELEASED, CANCELLED, VOIDED or already READY_FOR_RELEASE
 * is further along, and the register knows better than a date rule does —
 * 324 of August's 1,063 cheques are released, and dragging those back to SIGNED
 * would overwrite the record of money that has already been handed over. That
 * is what "consider the records in the Excel" means, and it is the whole reason
 * this filters on status rather than on date alone.
 *
 * WHY THE ACTOR IS SYSTEM. `markSigned` requires a `userId`, because normally a
 * named person ticked the box. Nobody ticked these. Attributing 730 signatures
 * to whichever admin happened to run the script would put a false name on the
 * audit trail of who signed real cheques, so the audit row says SYSTEM and
 * carries this ruling as its reason.
 *
 * This is NOT a second write path. It validates the move with the domain's own
 * `assertTransition` and writes the update and its audit row in one transaction,
 * exactly as `lib/domain/actions.ts` does. Every status change from here goes
 * through that module; this is a migration of historical fact, run once.
 *
 * Usage:
 *   npx.cmd tsx scripts/backfill-signed.ts --dry-run
 *   npx.cmd tsx scripts/backfill-signed.ts
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { writeAudit } from '../lib/audit'
import { assertTransition, type CheckStatus } from '../lib/domain/check-status'

const DRY = process.argv.includes('--dry-run')
const db = new PrismaClient()

/** Cheques dated on or after this are taken to have been signed already. */
const SIGNED_FROM = new Date('2026-08-01T00:00:00.000Z')

async function main() {
  const candidates = await db.check.findMany({
    where: {
      status: 'SIGNATURE_PENDING',
      checkDate: { gte: SIGNED_FROM },
      // A payment with no physical document cannot be signed. One record in
      // production is not a cheque; `assertReleasable` would refuse it, so it
      // is excluded here rather than counted as an error later.
      isCheque: true,
    },
    select: { id: true, checkNumber: true, status: true, checkDate: true },
    orderBy: { checkDate: 'asc' },
  })

  const byMonth = new Map<string, number>()
  for (const c of candidates) {
    const k = c.checkDate?.toISOString().slice(0, 7) ?? '(no date)'
    byMonth.set(k, (byMonth.get(k) ?? 0) + 1)
  }

  // What is deliberately being left alone, shown rather than implied — the
  // reader should be able to see that the released cheques are untouched.
  const protectedRows = await db.check.groupBy({
    by: ['status'],
    _count: { _all: true },
    where: { checkDate: { gte: SIGNED_FROM }, status: { not: 'SIGNATURE_PENDING' } },
  })

  console.log(`\nTO SIGN  (still SIGNATURE_PENDING, dated ${SIGNED_FROM.toISOString().slice(0, 10)} or later)`)
  for (const [m, n] of [...byMonth].sort()) console.log(`  ${m}                       ${String(n).padStart(5)}`)
  console.log(`  ─────────────────────────────────────`)
  console.log(`  total                         ${String(candidates.length).padStart(5)}`)

  console.log(`\nLEFT ALONE  (the register says they are further along)`)
  for (const g of protectedRows.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${g.status.padEnd(28)} ${String(g._count._all).padStart(5)}`)
  }

  if (DRY) { console.log('\nDRY RUN — nothing was written.\n'); return }

  let signed = 0, refused = 0
  for (const c of candidates) {
    try {
      // The domain decides whether the move is legal, not this script.
      assertTransition(c.status as CheckStatus, 'SIGNED')
      await db.$transaction(async (tx) => {
        await tx.check.update({
          where: { id: c.id },
          // signedById stays null on purpose: no user signed these, and a
          // fabricated actor is worse than an absent one on a signature record.
          data: { status: 'SIGNED' },
        })
        await writeAudit(tx, {
          checkId: c.id,
          actorType: 'SYSTEM',
          action: 'backfilled_signed',
          details: { from: c.status, to: 'SIGNED', checkDate: c.checkDate?.toISOString() ?? null },
          remarks:
            'Finance ruling 2026-09-04: cheques dated August 2026 or later were signed before ' +
            'this system existed. No user is recorded because none ticked it here.',
        })
      })
      signed++
      if (signed % 100 === 0) process.stdout.write(`\r  signed ${signed} of ${candidates.length}`)
    } catch (e) {
      refused++
      console.error(`\n  refused ${c.checkNumber}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  process.stdout.write('\n')

  const after = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\nWRITTEN`)
  console.log(`  signed                        ${signed}`)
  console.log(`  refused                       ${refused}`)
  console.log(`\n  statuses now: ${after.map((g) => `${g.status}=${g._count._all}`).join('  ')}\n`)
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
