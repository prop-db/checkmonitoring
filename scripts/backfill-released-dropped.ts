/**
 * Record as RELEASED the cheques that dropped off the approval-for-release list.
 *
 * THE RULE, from Finance on 2026-09-10: *"check who are present in APPROVAL FOR
 * RELEASE 9.4.2026 and not existing in APPROVAL FOR RELEASE 09.07.2026 are
 * considered release"*. The approval workbook is a snapshot of what is still
 * waiting to be handed over, so a voucher that was on the older list and is
 * absent from the newer one was released in between. Absence is the evidence.
 *
 * WHY THIS DOES NOT FOLLOW ACUMATICA, WHICH IT NORMALLY WOULD. Measured
 * 2026-09-10 across the 51 vouchers that dropped between those two files: 49 of
 * the cheques they name are still `Balanced` in Acumatica, one is Voided and one
 * the ERP has never seen. Not a single `Closed`. Read on the usual rule —
 * `Closed` means released, proven on 5,396 of 5,449 cheques — Acumatica is
 * saying these were NOT released, and that is the opposite of what this script
 * writes.
 *
 * Finance resolved it and the reasoning is sound: *"Those are not in the list of
 * course will reflect balance in acumatica because no update yet for the
 * released checks in acumatica."* The cheques were handed over; the ERP entry
 * lags the counter. That lag is the entire reason this system exists.
 *
 * So the disagreement is real and it is recorded rather than hidden: every audit
 * row states what Acumatica said at the time. If the ERP is updated later and
 * these turn `Closed`, the record will show the two agreeing in the end and this
 * script having got there first. If any of them turns out never to have been
 * released, the audit row names the basis — a voucher missing from a spreadsheet
 * — and whoever investigates can see exactly how thin that evidence was.
 *
 * WHAT IT WILL NOT TOUCH.
 *   - Anything not currently READY_FOR_RELEASE or SCHEDULED. A cheque that is
 *     RELEASED already needs nothing; one that is CANCELLED or VOIDED is past
 *     this argument. One of the 51 is voided in both sources and is left alone.
 *   - `releasedById` stays null and no portal event is queued. No user in this
 *     system released these and no supplier should be notified now, weeks late,
 *     by a backfill. The portal learns the current state when Plan 3 connects.
 *   - `releasedAt` stays null. The date is not knowable from either workbook —
 *     only that it happened between the two exports — and a fabricated
 *     timestamp on a release record is worse than an absent one.
 *
 * Usage:
 *   npx.cmd tsx scripts/backfill-released-dropped.ts "APPROVAL FOR RELEASE 9.4.2026.xlsx" "APPROVAL FOR RELEASE 09.07.2026.xlsx" --dry-run
 *   npx.cmd tsx scripts/backfill-released-dropped.ts "APPROVAL FOR RELEASE 9.4.2026.xlsx" "APPROVAL FOR RELEASE 09.07.2026.xlsx"
 *
 * Idempotent: a second run finds nothing left at READY_FOR_RELEASE and moves
 * nothing.
 */

import 'dotenv/config'
import ExcelJS from 'exceljs'
import { PrismaClient } from '@prisma/client'
import { writeAudit } from '../lib/audit'

const DRY = process.argv.includes('--dry-run')
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const db = new PrismaClient()

/** The `Reference Nbr.` column, 1-indexed as ExcelJS yields it. */
const REFERENCE_NBR = 3

/**
 * Every AP voucher a workbook names, across every sheet.
 *
 * Read from all sheets rather than a named one, for the reason
 * `lib/import/bills.ts` does: the sheet names change with every export and the
 * 4 September file's `LIST` does not exist in the 7 September one. A pivot
 * sheet contributes nothing here because its column 3 holds sums and labels,
 * never something matching `AP-`.
 */
async function vouchersIn(file: string): Promise<Set<string>> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const found = new Set<string>()
  wb.eachSheet((ws) => {
    ws.eachRow((row, n) => {
      if (n === 1) return
      const v = row.getCell(REFERENCE_NBR).value
      const text = String(
        v && typeof v === 'object' && 'text' in v ? (v as { text: unknown }).text : (v ?? ''),
      ).trim().toUpperCase()
      if (/^AP-/.test(text)) found.add(text)
    })
  })
  return found
}

async function main() {
  if (files.length !== 2) {
    throw new Error(
      'Usage: backfill-released-dropped.ts <older approval workbook> <newer approval workbook> [--dry-run]',
    )
  }
  const [olderFile, newerFile] = files
  const [older, newer] = await Promise.all([vouchersIn(olderFile), vouchersIn(newerFile)])
  const dropped = [...older].filter((v) => !newer.has(v))

  console.log(`\nOLDER  ${olderFile}`)
  console.log(`  vouchers                      ${String(older.size).padStart(6)}`)
  console.log(`NEWER  ${newerFile}`)
  console.log(`  vouchers                      ${String(newer.size).padStart(6)}`)
  console.log(`\nDROPPED OFF THE LIST            ${String(dropped.length).padStart(6)}  => considered released`)

  if (dropped.length === 0) {
    console.log('\nNothing dropped between these two files.\n')
    return
  }

  const bills = await db.checkBill.findMany({
    where: { apvNumber: { in: dropped } },
    select: {
      apvNumber: true,
      check: {
        select: { id: true, checkNumber: true, status: true, acumaticaStatus: true },
      },
    },
  })

  // A cheque can settle several of the dropped vouchers; move it once.
  const byCheck = new Map<string, (typeof bills)[number]['check'] & { vouchers: string[] }>()
  for (const b of bills) {
    const existing = byCheck.get(b.check.id)
    if (existing) existing.vouchers.push(b.apvNumber)
    else byCheck.set(b.check.id, { ...b.check, vouchers: [b.apvNumber] })
  }

  const movable = [...byCheck.values()].filter(
    (c) => c.status === 'READY_FOR_RELEASE' || c.status === 'SCHEDULED',
  )
  const untouched = [...byCheck.values()].filter(
    (c) => c.status !== 'READY_FOR_RELEASE' && c.status !== 'SCHEDULED',
  )

  console.log(`  cheques they name             ${String(byCheck.size).padStart(6)}`)
  console.log(`  WILL MOVE -> RELEASED         ${String(movable.length).padStart(6)}`)
  console.log(`  left alone (already settled)  ${String(untouched.length).padStart(6)}`)
  for (const c of untouched) console.log(`     ${c.checkNumber ?? c.id}  ${c.status}`)

  // Stated, never silently accepted: this script writes RELEASED over an ERP
  // that is still saying otherwise, and the reader should see how many.
  const acu = new Map<string, number>()
  for (const c of movable) {
    const k = c.acumaticaStatus ?? '(not in Acumatica)'
    acu.set(k, (acu.get(k) ?? 0) + 1)
  }
  console.log(`\n  ACUMATICA STILL SAYS, for the ones about to move:`)
  for (const [k, n] of [...acu].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${k.padEnd(22)} ${String(n).padStart(5)}`)
  }
  console.log(
    '  Expected. Finance 2026-09-10: the ERP entry lags the counter, and these\n' +
      '  were handed over before it was posted. Recorded on every audit row.',
  )

  if (DRY) {
    console.log('\nDRY RUN — nothing was written.\n')
    return
  }

  let moved = 0
  for (const c of movable) {
    await db.$transaction(
      async (tx) => {
        await tx.check.update({
          where: { id: c.id },
          // releasedById and releasedAt stay null: nobody released this here and
          // the date is not knowable from either workbook.
          data: { status: 'RELEASED' },
        })
        await writeAudit(tx, {
          checkId: c.id,
          actorType: 'SYSTEM',
          action: 'backfilled_released_dropped_from_approval_list',
          details: {
            from: c.status,
            to: 'RELEASED',
            vouchers: c.vouchers,
            olderFile,
            newerFile,
            acumaticaStatusAtTheTime: c.acumaticaStatus,
          },
          remarks:
            `This cheque's voucher was on ${olderFile} and is absent from ${newerFile}. Finance ` +
            'ruled on 2026-09-10 that dropping off the approval-for-release list means the cheque ' +
            `was handed over. Acumatica said "${c.acumaticaStatus ?? 'nothing — no record'}" at the ` +
            'time, which normally would mean NOT released; Finance explained the ERP entry lags ' +
            'the counter. Recorded here so the disagreement is visible rather than hidden. No ' +
            'release date and no releasing user: neither is knowable from the workbooks.',
        })
      },
      { timeout: 30_000, maxWait: 15_000 },
    )
    moved++
    if (moved % 25 === 0) process.stdout.write(`\r  released ${moved} of ${movable.length}`)
  }
  if (moved >= 25) process.stdout.write('\n')

  const after = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\nWRITTEN`)
  console.log(`  recorded as released          ${String(moved).padStart(6)}`)
  console.log(`\nAFTER   ${after.map((g) => `${g.status}=${g._count._all}`).join('  ')}\n`)
}

main()
  .catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
