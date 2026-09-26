// Last two rows of the 2026-09-26 reconciliation (see reconcile-2026-09-26.ts):
//  - 6000339264 (Stylus): imported from Acumatica before APVs were read and in
//    no register file; its APV comes from the Supplier Portal's own record of
//    this cheque. Written here, and the parked RELEASED event re-queued.
//  - 6000339204 (Multipack): VOIDED here; the CANCELLED event went out with
//    APV AP-ST041313 but the portal keys the cheque on AP-ST041395 (noop). The
//    register backfill has since added the second APV; a fresh CANCELLED event
//    is queued so the portal cancels its row.
//
//   npx.cmd tsx scripts/reconcile-2026-09-26-last-two.ts            # dry run
//   npx.cmd tsx scripts/reconcile-2026-09-26-last-two.ts --apply    # writes, then DELIVER NOW
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  const now = new Date()
  const stylus = await prisma.check.findFirst({ where: { checkNumber: '6000339264' }, select: { id: true, status: true, apvNumbers: true, portalEvents: { where: { status: 'PARKED', kind: 'RELEASED' }, select: { id: true } } } })
  const multipack = await prisma.check.findFirst({ where: { checkNumber: '6000339204' }, select: { id: true, status: true, apvNumbers: true, portalEvents: { where: { kind: 'CANCELLED', status: { in: ['PENDING', 'FAILED', 'IN_FLIGHT'] } }, select: { id: true } } } })
  console.log(`stylus: ${stylus ? `${stylus.status} apvs=${JSON.stringify(stylus.apvNumbers)} parked=${stylus.portalEvents.length}` : 'NOT FOUND'}`)
  console.log(`multipack: ${multipack ? `${multipack.status} apvs=${JSON.stringify(multipack.apvNumbers)} openCancelled=${multipack.portalEvents.length}` : 'NOT FOUND'}`)
  const stylusOk = stylus && stylus.status === 'RELEASED' && stylus.apvNumbers.length === 0 && stylus.portalEvents.length === 1
  const multipackOk = multipack && multipack.status === 'VOIDED' && multipack.apvNumbers.includes('AP-ST041395') && multipack.portalEvents.length === 0
  if (!stylusOk || !multipackOk) { console.log('refusing: expectations not met (already applied, or data moved)'); return }
  if (!APPLY) { console.log('dry run — nothing written'); return }

  await prisma.$transaction(async (tx) => {
    await tx.check.update({ where: { id: stylus!.id }, data: { apvNumbers: ['AP-ST041301'] } })
    await tx.portalEvent.update({ where: { id: stylus!.portalEvents[0].id }, data: { status: 'PENDING', nextAttemptAt: now, lastError: null } })
    await tx.auditLog.create({ data: { checkId: stylus!.id, actorType: 'SYSTEM', action: 'apv_backfilled_from_portal', details: { apvNumbers: ['AP-ST041301'], eventId: stylus!.portalEvents[0].id }, remarks: 'Reconciliation 2026-09-26: in no register file; APV AP-ST041301 taken from the Supplier Portal record of this cheque. RELEASED event re-queued.' } })
  })
  await prisma.$transaction(async (tx) => {
    await tx.check.update({ where: { id: multipack!.id }, data: { portalSyncStatus: 'PENDING', portalDomain: 'LOCAL' } })
    await tx.portalEvent.create({ data: { checkId: multipack!.id, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING', idempotencyKey: `${multipack!.id}:CANCELLED:reconcile2-${now.toISOString()}`, payload: { action: 'CANCELLED', checkNumber: '6000339204', reconcile: true } } })
    await tx.auditLog.create({ data: { checkId: multipack!.id, actorType: 'SYSTEM', action: 'portal_event_backfilled', details: { kind: 'CANCELLED', reason: 'first CANCELLED matched nothing (noop): portal keys this cheque on AP-ST041395' }, remarks: 'Reconciliation 2026-09-26: second CANCELLED queued now that both APVs are on the cheque.' } })
  })
  console.log('done: Stylus APV set + RELEASED re-queued; Multipack CANCELLED queued. Press DELIVER NOW on /admin/portal.')
}
main().finally(() => prisma.$disconnect())
