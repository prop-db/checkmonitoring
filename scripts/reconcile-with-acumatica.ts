import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { PrismaClient } from '@prisma/client'
import {
  findClosedButDeadHere, releaseClosed, planFinanceVerdicts, applyAvailable, applyStaled, parseVerdict,
  type FinanceLine,
} from '../lib/admin/acumatica-reconcile'

/**
 * The full check of 2026-10-06, settled. Two parts, both one-off:
 *
 *  1. Every cheque CANCELLED or VOIDED here with no person behind it while
 *     Acumatica holds it `Closed` -> RELEASED (user ruling: "follow acumatica").
 *  2. Finance's NEW STATUS column on `CANCELLED VS ACUMATICA` for the cheques
 *     the register cancelled that Acumatica still holds `Balanced`:
 *     AVAILABLE -> READY FOR RELEASE (the portal is told), STALED -> stays
 *     CANCELLED with the STALED tag, CANCELLED -> unchanged (void it in Acumatica).
 *
 *   npx.cmd tsx scripts/reconcile-with-acumatica.ts "<finance>.xlsx"                          # dry run
 *   npx.cmd tsx scripts/reconcile-with-acumatica.ts "<finance>.xlsx" --apply --user <email>   # snapshot, then write
 *
 * Run AFTER `scripts/sync.ts <TENANT> --full` on both tenants: part 1 reads the
 * stored Acumatica status, which the full re-read refreshes. `--user` is the
 * Finance user the AVAILABLE and STALED rows are recorded under. Prints cheque
 * numbers only. DATABASE_URL is PRODUCTION.
 */

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const userAt = args.indexOf('--user')
const userEmail = userAt >= 0 ? args[userAt + 1] : undefined
const file = args.find((a) => !a.startsWith('--') && a !== userEmail)

async function readFinanceFile(path: string): Promise<FinanceLine[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const lines: FinanceLine[] = []
  for (const ws of wb.worksheets) {
    const before = lines.length
    // The header is on row 1 or 2 (a title line may sit above it).
    let header = 0
    const col: Record<string, number> = {}
    for (const r of [1, 2, 3]) {
      ws.getRow(r).eachCell((c, i) => { col[c.text.trim().toUpperCase()] = i })
      if (col['NEW STATUS'] && col['CV'] && col['CHECK NUMBER']) { header = r; break }
      for (const k of Object.keys(col)) delete col[k]
    }
    if (!header) { console.log(`  sheet "${ws.name}": no CHECK NUMBER / CV / NEW STATUS header — skipped`); continue }
    for (let r = header + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      // `.text`, the cell as displayed: a rich-text, hyperlink or formula cell's
      // `.value` is an object and would read as "[object Object]".
      const checkNumber = row.getCell(col['CHECK NUMBER']).text.trim()
      const cv = row.getCell(col['CV']).text.trim()
      const raw = row.getCell(col['NEW STATUS']).text.trim()
      if (!checkNumber && !cv && !raw) continue
      const verdict = parseVerdict(raw)
      if (!verdict) throw new Error(`sheet "${ws.name}" row ${r}: NEW STATUS "${raw}" is not AVAILABLE, STALED or CANCELLED`)
      lines.push({ checkNumber, cv, verdict, row: r })
    }
    console.log(`  sheet "${ws.name}": ${lines.length - before} line(s)`)
  }
  return lines
}

async function main(): Promise<void> {
  if (!file) throw new Error('Usage: reconcile-with-acumatica.ts "<finance>.xlsx" [--apply --user <email>]')
  const db = new PrismaClient()
  try {
    const closed = await findClosedButDeadHere(db)
    console.log(`\n1. CANCELLED/VOIDED here, Closed in Acumatica, no person behind it: ${closed.length}`)
    for (const c of closed) console.log(`   ${c.checkNumber.padEnd(12)} ${c.acumaticaPaymentId.padEnd(16)} ${c.status.padEnd(9)} ${c.sourceSheet ?? ''}`)

    console.log(`\n2. Finance file: ${file}`)
    const plan = await planFinanceVerdicts(db, await readFinanceFile(file))
    const show = (label: string, xs: { checkNumber: string }[]) =>
      console.log(`   ${label}: ${xs.length}${xs.length ? '  ' + xs.map((x) => x.checkNumber).join(', ') : ''}`)
    show('AVAILABLE -> READY FOR RELEASE', plan.available.map((a) => a.line))
    show('STALED -> CANCELLED + STALED tag', plan.staled.map((s) => s.line))
    show('CANCELLED -> unchanged (void in Acumatica)', plan.keepCancelled)
    show('already done', plan.done)
    for (const r of plan.refused) console.log(`   REFUSED ${r.line.checkNumber} (${r.line.cv}, row ${r.line.row}): ${r.reason}`)

    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply --user <email>.\n'); return }
    if (!userEmail || userEmail.startsWith('--')) throw new Error('--apply needs --user <email> of the Finance user recording this')
    const user = await db.user.findUnique({ where: { email: userEmail }, select: { id: true, active: true } })
    if (!user || !user.active) throw new Error(`No active user ${userEmail}`)

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `reconcile-with-acumatica-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const ids = [...closed.map((c) => c.id), ...plan.available.map((a) => a.checkId), ...plan.staled.map((s) => s.checkId)]
    const before = await db.check.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, checkNumber: true, acumaticaPaymentId: true, status: true, isStale: true, cancelledAt: true,
        cancelReason: true, voidedAt: true, readyAt: true, readyById: true, availablePickupDate: true,
        portalSyncStatus: true, portalDomain: true, acumaticaStatus: true,
      },
    })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), file, rows: before }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const released = await releaseClosed(db, closed)
    const avail = await applyAvailable(db, plan.available, { userId: user.id, now })
    const staled = await applyStaled(db, plan.staled, { userId: user.id })
    console.log(`\nDONE  released ${released} of ${closed.length}; staled ${staled} of ${plan.staled.length}`)
    for (const a of avail) console.log(a.ok ? `  READY FOR RELEASE ${a.checkNumber}` : `  NOT READIED ${a.checkNumber}: ${a.reason}`)
    console.log(`  still CANCELLED/VOIDED here and Closed in Acumatica: ${(await findClosedButDeadHere(db)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
