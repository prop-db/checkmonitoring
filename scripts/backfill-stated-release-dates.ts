import 'dotenv/config'
import { queueReleasedForStale } from '../lib/admin/portal-backlog'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { loadCompanyReferenceData } from '../lib/import/reference'
import { readWorkbook } from '../lib/import/workbook'
import {
  applyStatedReleaseDates, planStatedReleaseDates, snapshotOf,
} from '../lib/admin/stated-release-dates'

/**
 * Write the register's stated DATE RELEASED onto the RELEASED cheques it names,
 * into `statedReleaseDate` — never `releasedAt`. See
 * `lib/admin/stated-release-dates.ts` for what it will and will not touch.
 *
 *   npx.cmd tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx"          # dry run
 *   npx.cmd tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx" --apply  # snapshot, then write
 *
 * Dry run by default. `--apply` writes `snapshots/stated-release-dates-<ts>.json`
 * first. Prints counts and cheque numbers only — never a payee, never an amount.
 * Reads `DATABASE_URL`, which on this machine is PRODUCTION. Idempotent: a
 * second run finds every one of them ALREADY_STATED.
 */

const APPLY = process.argv.includes('--apply')
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && a !== '--apply')
const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number) => console.log('  ' + label.padEnd(48) + n(value).padStart(8))

async function main(): Promise<void> {
  if (unknown.length > 0) throw new Error(`Unrecognised option(s): ${unknown.join(', ')}`)
  if (files.length !== 1) throw new Error('Usage: backfill-stated-release-dates.ts <register.xlsx> [--apply]')
  const file = basename(files[0])

  const db = new PrismaClient()
  try {
    const raw = await readWorkbook(await readFile(files[0]))
    const ref = await loadCompanyReferenceData(db)
    const plan = await planStatedReleaseDates(db, file, raw, ref, new Date())

    console.log(`\nREGISTER  ${file}  (stated days accepted up to ${plan.latest})`)
    line('cheques the register says were picked up', plan.reading.released.length)
    line('sheet clash nobody has ruled on (left)', plan.reading.unruled.length)

    console.log('\nAGAINST THIS SYSTEM')
    line('WILL WRITE statedReleaseDate', plan.toWrite.length)
    line('already carrying that day (skipped)', plan.counts.ALREADY_STATED)
    line('carrying a DIFFERENT day (left, listed)', plan.counts.DIFFERENT_DATE_STATED)
    line('not RELEASED here (left, listed)', plan.counts.NOT_RELEASED_HERE)
    line('rows state two different days (left, listed)', plan.counts.CONFLICTING_DATES)
    line('no usable date in the file (left)', plan.counts.NO_USABLE_DATE)
    line('no cheque here (left; the sync creates cheques)', plan.counts.NOT_IN_SYSTEM)
    line('more than one cheque here (left)', plan.counts.AMBIGUOUS)

    const byDay = new Map<string, number>()
    for (const { day } of plan.toWrite) byDay.set(day, (byDay.get(day) ?? 0) + 1)
    console.log('\n  stated days about to be written (latest first, top 15)')
    for (const [k, v] of [...byDay].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 15)) line(`  ${k}`, v)

    if (plan.listed.length > 0) {
      console.log('\nLEFT ALONE, for a human')
      for (const l of plan.listed) console.log(`     ${l.checkNumber}  ${l.kind}  ${l.detail}`)
    }

    if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.\n'); return }
    if (plan.toWrite.length === 0) { console.log('\nNothing to write.\n'); return }

    const takenAt = new Date()
    const dir = join(process.cwd(), 'snapshots')
    await mkdir(dir, { recursive: true })
    const snap = join(dir, `stated-release-dates-${takenAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify(snapshotOf(plan, takenAt), null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const out = await applyStatedReleaseDates(db, plan)
    console.log('\nDONE')
    line('stated days written', out.written)
    line('skipped: changed since the plan', out.raced)
    // User report 2026-10-06: the portal must hear about releases made here.
    // Queue RELEASED for cheques the portal was told were available and was
    // never told released; the worker delivers them (lib/admin/portal-backlog.ts).
    const portal = await queueReleasedForStale(db, { now: new Date(), apply: true })
    line('portal: RELEASED events queued', portal.queued)
    if (portal.noDate.length) {
      console.log('  portal: not queued, no release day to send (for a human)')
      for (const c of portal.noDate) console.log(`     ${c.checkNumber}`)
    }
    console.log('')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
