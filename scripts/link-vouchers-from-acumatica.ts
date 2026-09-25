import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PrismaClient, type CheckStatus } from '@prisma/client'
import { writeAudit } from '../lib/audit'
import { READY_FROM_LIST_ACTION, readReleaseListFile } from '../lib/admin/release-list'
import { BILL_COLUMN, PAYMENTS_WITH_BILLS_FEED, judgeLink, type AppCheque, type Application } from '../lib/admin/voucher-links'
import { createClientForTenant } from '../lib/integrations/acumatica/from-env'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'
import { canonicalCheckNumber } from '../lib/import/normalise'

/**
 * For every voucher on a FOR RELEASE list that names no cheque here, ask
 * Acumatica which cheque pays it (`lib/admin/voucher-links.ts`), then:
 *   1. add the voucher to that cheque's `apvNumbers` — one `voucher_linked_from_acumatica` row;
 *   2. move the cheque to READY_FOR_RELEASE when it sits below it — one
 *      `marked_ready_from_release_list` row, status only, as `release-list.ts` does.
 * User instruction 2026-09-25: "yes link them and move to ready for release".
 *
 *   npx.cmd tsx scripts/link-vouchers-from-acumatica.ts "FOR RELEASE 9.25.2026.xlsx"           # dry run
 *   npx.cmd tsx scripts/link-vouchers-from-acumatica.ts "FOR RELEASE 9.25.2026.xlsx" --apply   # snapshot, then write
 *
 * Acumatica is only read. Prints counts, vouchers and cheque numbers — never a
 * payee. DATABASE_URL is PRODUCTION.
 */

const LINK_ACTION = 'voucher_linked_from_acumatica'
const PROMOTABLE: readonly CheckStatus[] = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED']
const TENANTS: AcumaticaTenant[] = ['GOLIVE', 'MANUFACTURING']
const APPLY = process.argv.includes('--apply')
const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SELECT = { id: true, checkNumber: true, status: true, acumaticaStatus: true, isCheque: true } as const

async function main(): Promise<void> {
  if (!file) throw new Error('Usage: link-vouchers-from-acumatica.ts <for-release.xlsx> [--apply]')
  const list = await readReleaseListFile(file)
  const rows = new Map<string, { sheet: string; row: number }[]>()
  const stated = new Map<string, string>() // a BROKERS row states its cheque number too
  for (const e of list.entries) if (e.voucher) {
    rows.set(e.voucher, [...(rows.get(e.voucher) ?? []), { sheet: e.sheet, row: e.row }])
    if (e.checkNumber) stated.set(e.voucher, e.checkNumber)
  }

  const db = new PrismaClient()
  try {
    // Only vouchers that name nothing here; a voucher already linked is not re-judged.
    const unlinked: string[] = []
    for (const v of rows.keys()) {
      const n = await db.check.count({ where: { OR: [{ apvNumbers: { has: v } }, { bills: { some: { apvNumber: v } } }] } })
      if (n === 0) unlinked.push(v)
    }

    const clients = Object.fromEntries(TENANTS.map((t) => [t, createClientForTenant(t)]))
    const apps = new Map<string, Application[]>()
    for (const v of unlinked) {
      const found: Application[] = []
      for (const t of TENANTS) {
        const got = await clients[t].fetchPage(PAYMENTS_WITH_BILLS_FEED, { filter: `${BILL_COLUMN[t]} eq '${v.replace(/'/g, "''")}'` })
        for (const r of got) found.push({ payType: r.AdjgDocType, paymentRef: r.PaymentRef })
      }
      apps.set(v, found)
    }

    const numbers = new Set<string>()
    for (const a of apps.values()) for (const x of a) {
      const n = canonicalCheckNumber(typeof x.paymentRef === 'string' ? x.paymentRef : null)
      if (n) numbers.add(n)
    }
    const held = await db.check.findMany({ where: { checkNumber: { in: [...numbers] } }, select: SELECT })
    const byNumber = new Map<string, AppCheque[]>()
    for (const c of held) byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), c])

    const plan: { voucher: string; check: AppCheque; promote: boolean }[] = []
    const left: Record<string, string[]> = {}
    for (const v of unlinked) {
      const verdict = judgeLink(apps.get(v) ?? [], byNumber)
      const s = stated.get(v)
      // The list and Acumatica must agree on the cheque when the list names one.
      if (verdict.kind === 'LINK' && s && s !== verdict.check.checkNumber) {
        (left.LIST_NAMES_ANOTHER_CHEQUE ??= []).push(`${v} (list ${s}, Acumatica ${verdict.check.checkNumber})`)
      } else if (verdict.kind === 'LINK') plan.push({ voucher: v, check: verdict.check, promote: PROMOTABLE.includes(verdict.check.status) })
      else (left[verdict.kind] ??= []).push(v + ('checkNumbers' in verdict ? ` (${verdict.checkNumbers.join(', ')})` : ''))
    }
    const perCheque = new Map<string, number>()
    for (const p of plan) perCheque.set(p.check.id, (perCheque.get(p.check.id) ?? 0) + 1)

    console.log(`\nLIST  ${basename(file)}: ${rows.size} vouchers, ${unlinked.length} naming no cheque here`)
    console.log(`  WILL LINK                          ${plan.length} vouchers to ${perCheque.size} cheques`)
    console.log(`  WILL MOVE -> READY_FOR_RELEASE     ${new Set(plan.filter((p) => p.promote).map((p) => p.check.id)).size} cheques`)
    const from: Record<string, number> = {}
    for (const p of plan) from[p.check.status] = (from[p.check.status] ?? 0) + 1
    console.log(`  from ${JSON.stringify(from)}`)
    for (const [k, vs] of Object.entries(left)) console.log(`  LEFT ${k.padEnd(28)} ${vs.length}  ${vs.join('  ')}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (plan.length === 0) { console.log('\nNothing to do.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `link-vouchers-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const before = await db.check.findMany({ where: { id: { in: [...perCheque.keys()] } }, select: { id: true, checkNumber: true, status: true, apvNumbers: true } })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), file: basename(file), rows: before, plan: plan.map((p) => ({ voucher: p.voucher, checkId: p.check.id })) }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    let linked = 0, promoted = 0, raced = 0
    for (const p of plan) {
      await db.$transaction(async (tx) => {
        const c = await tx.check.findUniqueOrThrow({ where: { id: p.check.id }, select: { status: true, apvNumbers: true } })
        const listRows = rows.get(p.voucher) ?? []
        if (!c.apvNumbers.includes(p.voucher)) {
          await tx.check.update({ where: { id: p.check.id }, data: { apvNumbers: [...c.apvNumbers, p.voucher] } })
          await writeAudit(tx, {
            checkId: p.check.id, actorType: 'SYSTEM', action: LINK_ACTION,
            details: { voucher: p.voucher, source: PAYMENTS_WITH_BILLS_FEED, file: basename(file), listRows },
            remarks: `Acumatica (${PAYMENTS_WITH_BILLS_FEED}) shows this cheque paying ${p.voucher}. Linked on the user's instruction, 2026-09-25.`,
          })
          linked++
        }
        if (!PROMOTABLE.includes(c.status)) return
        const { count } = await tx.check.updateMany({ where: { id: p.check.id, status: c.status }, data: { status: 'READY_FOR_RELEASE' } })
        if (count === 0) { raced++; return }
        await writeAudit(tx, {
          checkId: p.check.id, actorType: 'SYSTEM', action: READY_FROM_LIST_ACTION,
          details: { from: c.status, to: 'READY_FOR_RELEASE', file: basename(file), listRows, voucherLinkedFrom: PAYMENTS_WITH_BILLS_FEED, acumaticaStatusAtTheTime: p.check.acumaticaStatus },
          remarks: `${basename(file)} lists voucher ${p.voucher}, which Acumatica shows this cheque paying. Moved on the user's instruction, 2026-09-25. No approving user, time or pickup date is recorded.`,
        })
        promoted++
      }, { timeout: 30_000, maxWait: 15_000 })
    }
    console.log(`\nDONE  vouchers linked ${linked}  cheques moved to READY_FOR_RELEASE ${promoted}  skipped (changed since plan) ${raced}\n`)
  } finally {
    await db.$disconnect()
  }
}

main()
