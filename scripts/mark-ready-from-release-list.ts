import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { applyReady, planReady, readReleaseListFile, snapshotOf } from '../lib/admin/release-list'

/**
 * Move the cheques a FOR RELEASE workbook lists to READY_FOR_RELEASE. See
 * `lib/admin/release-list.ts` for what it will and will not touch.
 *
 *   npx.cmd tsx scripts/mark-ready-from-release-list.ts "FOR RELEASE 9.25.2026.xlsx"          # dry run
 *   npx.cmd tsx scripts/mark-ready-from-release-list.ts "FOR RELEASE 9.25.2026.xlsx" --apply  # snapshot, then write
 *
 * Dry run by default; `--apply` writes `snapshots/ready-from-list-<ts>.json`
 * first. Prints counts and cheque/voucher references only — never a payee or an
 * amount. Reads `DATABASE_URL`, which on this machine is PRODUCTION.
 */

const APPLY = process.argv.includes('--apply')
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && a !== '--apply')
const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number) => console.log('  ' + label.padEnd(44) + n(value).padStart(8))

async function main(): Promise<void> {
  if (unknown.length > 0) throw new Error(`Unrecognised option(s): ${unknown.join(', ')}`)
  if (files.length !== 1) throw new Error('Usage: mark-ready-from-release-list.ts <for-release.xlsx> [--apply]')
  const file = basename(files[0])

  const db = new PrismaClient()
  try {
    const list = await readReleaseListFile(files[0])
    const plan = await planReady(db, file, list)

    console.log(`\nLIST  ${file}`)
    for (const s of plan.sheets) console.log(`  ${s.sheet.padEnd(30)} ${s.read ? `read, ${n(s.entries)} rows` : 'skipped (no voucher or cheque header)'}`)
    line('distinct items (vouchers / cheques)', plan.items)

    console.log('\nAGAINST THIS SYSTEM')
    line('WILL MOVE -> READY_FOR_RELEASE (cheques)', plan.toPromote.length)
    line('already READY_FOR_RELEASE or SCHEDULED', plan.counts.ALREADY_READY)
    line('RELEASED here (left)', plan.counts.RELEASED_HERE)
    line('not a cheque / Voided in Acumatica (left)', plan.counts.NOT_PROMOTABLE)
    line('names no cheque here (left)', plan.counts.NO_MATCH)
    line('names only cancelled/voided cheques (left)', plan.counts.ONLY_CANCELLED_OR_VOIDED)
    line('names more than one live cheque (left)', plan.counts.AMBIGUOUS)

    const from = new Map<string, number>()
    for (const { check } of plan.toPromote) from.set(check.status, (from.get(check.status) ?? 0) + 1)
    console.log('\n  moving from')
    for (const [k, v] of [...from].sort((a, b) => b[1] - a[1])) line(`  ${k}`, v)

    console.log('\nREADY_FOR_RELEASE BUT NOT ON THIS LIST — reported, not moved')
    line('cheques', plan.offList.length)
    for (const o of plan.offList) console.log(`     ${o.checkNumber}  Acumatica: ${o.acumaticaStatus ?? '(none)'}`)

    const shown = plan.leftAlone.filter((l) => l.kind === 'AMBIGUOUS' || l.kind === 'NOT_PROMOTABLE' || l.kind === 'RELEASED_HERE')
    if (shown.length > 0) {
      console.log('\nLEFT ALONE, for a human')
      for (const l of shown) console.log(`     ${l.item}  ${l.kind}${l.status ? `  ${l.status}` : ''}${l.acumaticaStatus ? ` / ${l.acumaticaStatus}` : ''}`)
    }

    if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.\n'); return }
    if (plan.toPromote.length === 0) { console.log('\nNothing to move.\n'); return }

    const takenAt = new Date()
    const dir = join(process.cwd(), 'snapshots')
    await mkdir(dir, { recursive: true })
    const snap = join(dir, `ready-from-list-${takenAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify(snapshotOf(plan, takenAt), null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const out = await applyReady(db, plan)
    console.log('\nDONE')
    line('moved to READY_FOR_RELEASE', out.promoted)
    line('skipped: changed since the plan', out.raced)
    console.log('')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
