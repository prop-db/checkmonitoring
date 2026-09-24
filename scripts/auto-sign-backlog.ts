import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { loadSettings } from '../lib/settings/read'
import { listAutoSignCandidates, runAutoSign } from '../lib/sync/auto-sign'

/**
 * The cheques already waiting when auto-sign went live (spec 2026-09-25): the
 * same rule the 18:00 run applies, run once from a terminal so the first
 * scheduled run signs one day's intake rather than the whole backlog.
 *
 *   npx.cmd tsx scripts/auto-sign-backlog.ts            # dry run: counts only
 *   npx.cmd tsx scripts/auto-sign-backlog.ts --apply    # snapshot, then sign
 *
 * `--apply` writes snapshots/auto-sign-backlog-<ts>.json first. Prints counts
 * only — never a payee, never an amount. Reads DATABASE_URL, which on the
 * developer machine is PRODUCTION. Idempotent: a second run finds nothing due.
 */

const APPLY = process.argv.includes('--apply')
const unknown = process.argv.slice(2).filter((a) => a !== '--apply')
const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number) => console.log('  ' + label.padEnd(44) + n(value).padStart(8))

async function main(): Promise<void> {
  if (unknown.length > 0) throw new Error(`Unrecognised argument(s): ${unknown.join(', ')}`)
  const db = new PrismaClient()
  try {
    const now = new Date()
    const days = (await loadSettings(db)).values['autoSign.afterDays']
    console.log(`\nAUTO-SIGN BACKLOG  (autoSign.afterDays = ${days})`)
    if (days <= 0) { console.log('  The setting is 0: auto-sign is off. Nothing to do.\n'); return }

    const due = await listAutoSignCandidates(db, now, days)
    const pending = await db.check.count({ where: { status: 'SIGNATURE_PENDING' } })
    line('at SIGNATURE_PENDING', pending)
    line('DUE — will be signed', due.length)
    line('  not yet due, or register-only, or not a cheque, or Voided', pending - due.length)

    const byMonth = new Map<string, number>()
    const byCompany = new Map<string, number>()
    for (const c of due) {
      const m = c.createdAt.toISOString().slice(0, 7)
      byMonth.set(m, (byMonth.get(m) ?? 0) + 1)
      byCompany.set(c.companyCode, (byCompany.get(c.companyCode) ?? 0) + 1)
    }
    console.log('\n  by month it reached the app')
    for (const [k, v] of [...byMonth].sort()) line(`    ${k}`, v)
    console.log('  by company')
    for (const [k, v] of [...byCompany].sort((a, b) => b[1] - a[1])) line(`    ${k}`, v)

    if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.\n'); return }
    if (due.length === 0) { console.log('\nNothing is due.\n'); return }

    const dir = join(process.cwd(), 'snapshots')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `auto-sign-backlog-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(file, JSON.stringify({
      takenAt: now.toISOString(), days,
      rows: due.map((c) => ({ id: c.id, checkNumber: c.checkNumber, companyCode: c.companyCode, createdAt: c.createdAt.toISOString(), status: 'SIGNATURE_PENDING' })),
    }, null, 2))
    console.log(`\nSnapshot written: ${file}`)

    const run = await runAutoSign(db, { now })
    console.log('\nDONE')
    console.log(`  outcome ${run.outcome}${run.error ? ` — ${run.error}` : ''}`)
    line('signed', run.signed)
    line('skipped: changed since listed', run.skipped)
    console.log('')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
