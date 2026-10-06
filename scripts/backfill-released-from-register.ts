import 'dotenv/config'
import { queueReleasedForStale } from '../lib/admin/portal-backlog'
import { kickPortalDelivery } from '../lib/sync/portal-kick'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { loadCompanyReferenceData } from '../lib/import/reference'
import { readWorkbook } from '../lib/import/workbook'
import {
  applyRegisterReleases, planRegisterReleases, snapshotOf,
} from '../lib/admin/register-releases'

/**
 * Record as RELEASED the cheques a newer register shows picked up. See
 * `lib/admin/register-releases.ts` for what it will and will not touch.
 *
 *   npx.cmd tsx scripts/backfill-released-from-register.ts "CHECK MONITORING 9.24.2026.xlsx"          # dry run
 *   npx.cmd tsx scripts/backfill-released-from-register.ts "CHECK MONITORING 9.24.2026.xlsx" --apply  # snapshot, then write
 *
 * Dry run by default. `--apply` writes `snapshots/released-from-register-<ts>.json`
 * first. Prints counts and cheque numbers only — never a payee, never an amount.
 * Reads `DATABASE_URL`, which on this machine is PRODUCTION. Idempotent: a
 * second run finds every one of them already RELEASED.
 */

const APPLY = process.argv.includes('--apply')
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && a !== '--apply')
const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number) => console.log('  ' + label.padEnd(44) + n(value).padStart(8))

async function main(): Promise<void> {
  if (unknown.length > 0) throw new Error(`Unrecognised option(s): ${unknown.join(', ')}`)
  if (files.length !== 1) throw new Error('Usage: backfill-released-from-register.ts <register.xlsx> [--apply]')
  const file = basename(files[0])

  const db = new PrismaClient()
  try {
    const raw = await readWorkbook(await readFile(files[0]))
    const ref = await loadCompanyReferenceData(db)
    const plan = await planRegisterReleases(db, file, raw, ref)
    const r = plan.reading

    console.log(`\nREGISTER  ${file}`)
    line('cheques the register says were picked up', r.released.length)
    line('on a RELEASED sheet, ruled otherwise', r.overruled)
    line('sheet clash nobody has ruled on (left)', r.unruled.length)
    for (const u of r.unruled) console.log(`     ${u.checkNumber}  ${u.sheets.join(' + ')}`)

    console.log('\nAGAINST THIS SYSTEM')
    line('WILL MOVE -> RELEASED', plan.toRelease.length)
    line('already RELEASED', plan.counts.ALREADY_RELEASED)
    line('CANCELLED or VOIDED here (left)', plan.counts.CANCELLED_OR_VOIDED_HERE)
    line('Voided in Acumatica (left)', plan.counts.VOIDED_IN_ACUMATICA)
    line('no cheque here (left; the sync creates cheques)', plan.counts.NOT_IN_SYSTEM)
    line('more than one cheque here (left)', plan.counts.AMBIGUOUS)

    const from = new Map<string, number>()
    const acu = new Map<string, number>()
    for (const { check } of plan.toRelease) {
      from.set(check.status, (from.get(check.status) ?? 0) + 1)
      const k = check.acumaticaStatus ?? '(not in Acumatica)'
      acu.set(k, (acu.get(k) ?? 0) + 1)
    }
    console.log('\n  moving from')
    for (const [k, v] of [...from].sort((a, b) => b[1] - a[1])) line(`  ${k}`, v)
    console.log('  Acumatica says, for those')
    for (const [k, v] of [...acu].sort((a, b) => b[1] - a[1])) line(`  ${k}`, v)

    if (plan.leftAlone.some((l) => l.kind !== 'NOT_IN_SYSTEM')) {
      console.log('\nLEFT ALONE, for a human')
      for (const l of plan.leftAlone.filter((x) => x.kind !== 'NOT_IN_SYSTEM')) {
        console.log(`     ${l.checkNumber}  ${l.kind}${l.status ? `  ${l.status}` : ''}${l.acumaticaStatus ? ` / ${l.acumaticaStatus}` : ''}`)
      }
    }

    if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.\n'); return }
    if (plan.toRelease.length === 0) { console.log('\nNothing to release.\n'); return }

    const takenAt = new Date()
    const dir = join(process.cwd(), 'snapshots')
    await mkdir(dir, { recursive: true })
    const snap = join(dir, `released-from-register-${takenAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify(snapshotOf(plan, takenAt), null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const out = await applyRegisterReleases(db, plan)
    console.log('\nDONE')
    line('recorded as released', out.released)
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
    // Send now rather than at the next cron (user demand 2026-10-06: "this
    // should be always the trigger"). Without PORTAL_BASE_URL/PORTAL_TOKEN in
    // .env the events wait, and the next delivery anywhere sends them.
    const sent = await kickPortalDelivery(db, { budgetMs: 120_000 })
    if ('skipped' in sent) console.log(`  portal: NOT sent now (${sent.skipped}); the next delivery (any action in the app, Deliver now, or the cron) sends them`)
    else line('portal: delivered now', sent.synced)
    console.log('')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
