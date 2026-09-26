// One-off reconciliation (user request 2026-09-26 "Reconcile it").
//
// The Supplier Portal showed 33 checks available from Excel uploads that this
// system holds as RELEASED (15) or VOIDED (1); one real supplier's cheque
// (Digiprint) is SIGNED here but was announced on the portal on 2026-08-24 and
// the supplier confirmed a pickup. Five other "available" rows belong to
// simulation logins and are left alone.
//
// Release dates come from the register workbooks' DATE RELEASED column and
// are cited per cheque in the audit row. 6000339264 appears in no register
// file (released per Acumatica "Closed"); its hand-over date is unknown and
// the reconciliation date is used, stated as such.
//
//   npx.cmd tsx scripts/reconcile-2026-09-26.ts            # dry run, no writes
//   npx.cmd tsx scripts/reconcile-2026-09-26.ts --apply    # writes, then press DELIVER NOW on /admin/portal
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
// A Manila calendar day as an instant (midnight Asia/Manila = 16:00Z the day before).
const manila = (mdy: string) => { const [m, d, y] = mdy.split('/').map(Number); return new Date(Date.UTC(y, m - 1, d, -8)) }

const RELEASED: Record<string, { date: string; source: string }> = {
  '6000330476': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000339485': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000330477': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000339483': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000330495': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000330496': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000339487': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000339486': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000339484': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000339608': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '1791363603': { date: '8/7/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / MBTC RELEASED' },
  '6000330478': { date: '8/18/2026', source: 'CHECK MONITORING 9.1.2026.xlsx / BPI RELEASED' },
  '6000349360': { date: '9/22/2026', source: 'CHECK MONITORING 9.25.2026.xlsx / STK P&P RELEASED row 1085' },
  '6000353991': { date: '9/24/2026', source: 'CHECK MONITORING 9.25.2026.xlsx / STK P&P RELEASED row 1158' },
  '6000339264': { date: '9/26/2026', source: 'no register row; released per Acumatica Closed status; hand-over date unknown, reconciliation date used' },
}
const VOIDED = ['6000339204']
const DIGIPRINT = { checkNumber: '1791405389', pickup: '8/24/2026' }

async function main() {
  const now = new Date()
  const key = (id: string, kind: string) => `${id}:${kind}:reconcile-${now.toISOString()}`
  const rel = await prisma.check.findMany({ where: { checkNumber: { in: Object.keys(RELEASED) } }, select: { id: true, checkNumber: true, status: true, eligibility: true } })
  const voi = await prisma.check.findMany({ where: { checkNumber: { in: VOIDED } }, select: { id: true, checkNumber: true, status: true, eligibility: true } })
  const dig = await prisma.check.findFirst({ where: { checkNumber: DIGIPRINT.checkNumber }, select: { id: true, status: true, eligibility: true } })
  const bad = [...rel.filter(r => r.status !== 'RELEASED' || r.eligibility === 'INTERNAL'), ...voi.filter(v => v.status !== 'VOIDED' || v.eligibility === 'INTERNAL')]
  console.log(`released: ${rel.length}/${Object.keys(RELEASED).length} found; voided: ${voi.length}/${VOIDED.length}; digiprint: ${dig ? dig.status : 'NOT FOUND'}; mismatches: ${bad.length}`)
  if (bad.length || rel.length !== 15 || voi.length !== 1 || !dig || dig.status !== 'SIGNED') { console.log('refusing: expectations not met (already applied, or data moved)'); return }
  if (!APPLY) { console.log('dry run — nothing written'); return }

  for (const r of rel) {
    const { date, source } = RELEASED[r.checkNumber]
    await prisma.$transaction(async (tx) => {
      await tx.check.update({ where: { id: r.id }, data: { releasedAt: manila(date), portalSyncStatus: 'PENDING', portalDomain: 'LOCAL' } })
      await tx.portalEvent.create({ data: { checkId: r.id, direction: 'OUT', kind: 'RELEASED', status: 'PENDING', idempotencyKey: key(r.id, 'RELEASED'), payload: { action: 'RELEASED', checkNumber: r.checkNumber, reconcile: true } } })
      await tx.auditLog.create({ data: { checkId: r.id, actorType: 'SYSTEM', action: 'portal_event_backfilled', details: { kind: 'RELEASED', releasedAtSet: manila(date).toISOString(), source }, remarks: `Reconciliation 2026-09-26: the portal still showed this cheque available; release date ${date} from ${source}. RELEASED queued for the portal.` } })
    })
  }
  for (const v of voi) {
    await prisma.$transaction(async (tx) => {
      await tx.check.update({ where: { id: v.id }, data: { portalSyncStatus: 'PENDING', portalDomain: 'LOCAL' } })
      await tx.portalEvent.create({ data: { checkId: v.id, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING', idempotencyKey: key(v.id, 'CANCELLED'), payload: { action: 'CANCELLED', checkNumber: v.checkNumber, reconcile: true } } })
      await tx.auditLog.create({ data: { checkId: v.id, actorType: 'SYSTEM', action: 'portal_event_backfilled', details: { kind: 'CANCELLED' }, remarks: 'Reconciliation 2026-09-26: voided here, still available on the portal. CANCELLED queued for the portal.' } })
    })
  }
  await prisma.$transaction(async (tx) => {
    await tx.check.update({ where: { id: dig.id }, data: { status: 'READY_FOR_RELEASE', readyAt: manila(DIGIPRINT.pickup), availablePickupDate: manila(DIGIPRINT.pickup), portalSyncStatus: 'SYNCED', portalDomain: 'LOCAL' } })
    await tx.auditLog.create({ data: { checkId: dig.id, actorType: 'SYSTEM', action: 'backfilled_ready_from_portal', details: { from: 'SIGNED', to: 'READY_FOR_RELEASE', availablePickupDate: manila(DIGIPRINT.pickup).toISOString() }, remarks: 'Reconciliation 2026-09-26: the Supplier Portal announced this cheque available on 2026-08-24 (ap_trisha) and the supplier confirmed a pickup; recorded READY here to match. No portal event: the portal already has it.' } })
  })
  console.log(`queued ${rel.length} RELEASED + ${voi.length} CANCELLED; Digiprint set READY (pickup ${DIGIPRINT.pickup}). Now press DELIVER NOW on /admin/portal.`)
}
main().finally(() => prisma.$disconnect())
