import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient, type CheckStatus } from '@prisma/client'
import { writeAudit } from '../lib/audit'
import { readReleaseListFile } from '../lib/admin/release-list'

/**
 * Undo the `Detail1` half of the 2026-09-24 for-release promotion.
 *
 * `Detail1` of `FOR RELEASE 9.25.2026.xlsx` is the pivot's drill-down — every AP
 * bill Acumatica remarks AVAILABLE — not the release list. User ruling
 * 2026-09-25: the list is LOCAL + BROKERS (the PIVOT sheet sums only those).
 * A READY_FOR_RELEASE cheque that ONLY `Detail1` names goes back to the status
 * it held before: from the 2026-09-24 snapshot, or, for a cheque that script did
 * not move, from the `from` of its latest audit row that set READY_FOR_RELEASE.
 * No prior status found → left alone and reported.
 *
 *   npx.cmd tsx scripts/revert-detail1-ready.ts "FOR RELEASE 9.25.2026.xlsx" <ready-from-list snapshot>          # dry run
 *   npx.cmd tsx scripts/revert-detail1-ready.ts "FOR RELEASE 9.25.2026.xlsx" <ready-from-list snapshot> --apply
 *
 * Status only; one audit row each; a snapshot under snapshots/ first. Prints
 * counts, cheque numbers and totals — never a payee. DATABASE_URL is PRODUCTION.
 */

export const ACTION = 'ready_reverted_detail1_not_release_list'
const BACK: readonly CheckStatus[] = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED']
const APPLY = process.argv.includes('--apply')
const [listFile, snapFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'))

async function main(): Promise<void> {
  if (!listFile || !snapFile) throw new Error('Usage: revert-detail1-ready.ts <for-release.xlsx> <ready-from-list snapshot.json> [--apply]')
  const { entries } = await readReleaseListFile(listFile)
  const snap = JSON.parse(await readFile(snapFile, 'utf8')) as { rows: { id: string; status: CheckStatus }[] }
  const before = new Map(snap.rows.map((r) => [r.id, r.status]))

  const db = new PrismaClient()
  try {
    const ready = await db.check.findMany({
      where: { status: 'READY_FOR_RELEASE' },
      select: { id: true, checkNumber: true, amount: true, apvNumbers: true, bills: { select: { apvNumber: true } } },
    })
    const plan: { id: string; checkNumber: string; to: CheckStatus; source: string; amount: string | null; hasBill: boolean }[] = []
    const unresolved: string[] = []
    for (const c of ready) {
      const vs = new Set([...c.apvNumbers, ...c.bills.map((b) => b.apvNumber)])
      const sheets = new Set(entries.filter((e) => (e.voucher && vs.has(e.voucher)) || (e.checkNumber && e.checkNumber === c.checkNumber)).map((e) => e.sheet))
      if (!sheets.has('Detail1') || sheets.has('LOCAL') || sheets.has('BROKERS')) continue
      let to = before.get(c.id)
      let source = 'snapshot 2026-09-24'
      if (!to) {
        const rows = await db.auditLog.findMany({ where: { checkId: c.id }, orderBy: { createdAt: 'desc' }, select: { action: true, details: true } })
        const hit = rows.find((r) => (r.details as { to?: string } | null)?.to === 'READY_FOR_RELEASE')
        const from = (hit?.details as { from?: string } | null)?.from as CheckStatus | undefined
        if (from && BACK.includes(from)) { to = from; source = `audit ${hit!.action}` }
      }
      if (!to || !BACK.includes(to)) { unresolved.push(c.checkNumber); continue }
      plan.push({ id: c.id, checkNumber: c.checkNumber, to, source, amount: c.amount?.toString() ?? null, hasBill: c.bills.length > 0 })
    }

    const by = new Map<string, number>()
    for (const p of plan) by.set(`${p.to}  (${p.source})`, (by.get(`${p.to}  (${p.source})`) ?? 0) + 1)
    console.log(`\nREADY_FOR_RELEASE named only by Detail1: ${plan.length + unresolved.length}`)
    for (const [k, v] of by) console.log(`  -> ${k.padEnd(60)} ${v}`)
    console.log(`  no prior status found (left alone): ${unresolved.length} ${unresolved.join(' ')}`)
    console.log(`  carrying a CheckBill (backfill-available would re-promote): ${plan.filter((p) => p.hasBill).length}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written.\n'); return }

    const takenAt = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const out = join(process.cwd(), 'snapshots', `revert-detail1-ready-${takenAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(out, JSON.stringify({ takenAt: takenAt.toISOString(), file: listFile, rows: plan.map((p) => ({ id: p.id, checkNumber: p.checkNumber, status: 'READY_FOR_RELEASE', revertTo: p.to })) }, null, 2))
    console.log(`\nSnapshot written: ${out}`)

    let moved = 0, raced = 0
    for (const p of plan) {
      await db.$transaction(async (tx) => {
        const { count } = await tx.check.updateMany({ where: { id: p.id, status: 'READY_FOR_RELEASE' }, data: { status: p.to } })
        if (count === 0) { raced++; return }
        await writeAudit(tx, {
          checkId: p.id, actorType: 'SYSTEM', action: ACTION,
          details: { from: 'READY_FOR_RELEASE', to: p.to, priorStatusFrom: p.source, file: listFile },
          remarks: `Named only by the Detail1 sheet of ${listFile}, which is the pivot's drill-down of every bill remarked AVAILABLE, not the release list. The list is LOCAL + BROKERS (user, 2026-09-25). Returned to the status it held before.`,
        })
        moved++
      }, { timeout: 30_000, maxWait: 15_000 })
    }
    console.log(`\nDONE  moved ${moved}  skipped (changed since plan) ${raced}\n`)
  } finally {
    await db.$disconnect()
  }
}
main()
