/**
 * Eight cheques left at SIGNATURE_PENDING that Acumatica has already settled.
 *
 * Three are `Closed` and five are `Voided`. They were duplicates when
 * `backfill-closed-released.ts` and the sync's void handling ran, so the row
 * those passes looked at was the one the merge has since deleted; the survivor
 * kept the default rung. This is the sweep-up, not a new rule.
 *
 * Only SIGNATURE_PENDING moves — the default rung, which nobody asserted.
 * A cheque the register placed or a Finance user acted on is untouched.
 *
 * Usage:  npx.cmd tsx scripts/clear-pending-strays.ts --dry-run
 *         npx.cmd tsx scripts/clear-pending-strays.ts
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { writeAudit } from '../lib/audit'

const DRY = process.argv.includes('--dry-run')
const db = new PrismaClient()

const RULES = [
  { acumaticaStatus: 'Closed', to: 'RELEASED' as const,
    why: 'Acumatica reports this payment as Closed, which its own register proves means released.' },
  { acumaticaStatus: 'Voided', to: 'VOIDED' as const,
    why: 'Acumatica reports this payment as Voided, and Acumatica is authoritative on voids.' },
]

async function main() {
  let total = 0
  for (const rule of RULES) {
    const rows = await db.check.findMany({
      where: { status: 'SIGNATURE_PENDING', acumaticaStatus: rule.acumaticaStatus },
      select: { id: true, checkNumber: true },
    })
    console.log(`  ${rule.acumaticaStatus.padEnd(8)} -> ${rule.to.padEnd(9)} ${rows.length}`)
    if (DRY) continue
    for (const c of rows) {
      await db.$transaction(async (tx) => {
        await tx.check.update({ where: { id: c.id }, data: { status: rule.to } })
        await writeAudit(tx, {
          checkId: c.id, actorType: 'SYSTEM', action: 'backfilled_from_acumatica_status',
          details: { from: 'SIGNATURE_PENDING', to: rule.to, acumaticaStatus: rule.acumaticaStatus },
          remarks: rule.why + ' Left at the default rung because it was a duplicate when the earlier pass ran.',
        })
      })
      total++
    }
  }
  if (!DRY) console.log(`\n  moved ${total}`)
  const st = await db.check.groupBy({ by: ['status'], _count: { _all: true } })
  console.log(`\n${DRY ? 'DRY RUN — nothing written.' : 'AFTER'}  ${st.sort((a,b)=>b._count._all-a._count._all).map(g => `${g.status}=${g._count._all}`).join('  ')}`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1 })
  .finally(() => db.$disconnect())
