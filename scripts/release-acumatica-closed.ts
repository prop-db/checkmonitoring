import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findClosedStillLive, releaseClosedStillLive } from '../lib/admin/release-acumatica-closed'
import { voidedReferences } from '../lib/admin/acumatica-reconcile'
import { createClientForTenant } from '../lib/integrations/acumatica/from-env'
import { PAYMENTS_FEED } from '../lib/integrations/acumatica/client'
import { paymentsInScopeFilter } from '../lib/sync/run'
import { amountToCentavos } from '../lib/transmittal'

/**
 * Checks still SIGNED or READY FOR RELEASE here that Acumatica holds `Closed`
 * (paid) -> RELEASED. User ruling 2026-10-16 (found on /aging, 729 checks):
 * status only, snapshot first, one audit row each, the portal told about every
 * check it was told was available. See lib/admin/release-acumatica-closed.ts.
 *
 *   npx.cmd tsx scripts/release-acumatica-closed.ts            # dry run: reads, writes nothing
 *   npx.cmd tsx scripts/release-acumatica-closed.ts --apply    # snapshot, then release
 *
 * Reads the LIVE Acumatica feed of both tenants first (read-only) so a payment
 * with a pending void is never released. Prints check numbers only.
 * DATABASE_URL is PRODUCTION.
 */

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const voidedRefs = new Set<string>()
    for (const t of ['GOLIVE', 'MANUFACTURING'] as const) {
      const raw = await createClientForTenant(t).fetchAll(PAYMENTS_FEED, {
        select: ['Type', 'ReferenceNbr', 'Status'], filter: paymentsInScopeFilter(), orderby: 'ReferenceNbr asc', pageSize: 5000,
      })
      for (const ref of voidedReferences(raw)) voidedRefs.add(ref)
    }
    console.log(`\nAcumatica (live): ${voidedRefs.size} payment references carry a void`)

    const all = await findClosedStillLive(db)
    const rows = await findClosedStillLive(db, voidedRefs)
    const skippedForVoid = all.filter((a) => !rows.some((r) => r.id === a.id))
    const cents = (xs: typeof rows) => xs.reduce((s, r) => s + (amountToCentavos(r.amount) ?? BigInt(0)), BigInt(0))
    const peso = (c: bigint) => `${(c / BigInt(100)).toLocaleString('en-US')}.${(c % BigInt(100)).toString().padStart(2, '0')}`
    const signed = rows.filter((r) => r.status === 'SIGNED')
    const ready = rows.filter((r) => r.status === 'READY_FOR_RELEASE')
    console.log(`\nClosed in Acumatica, still live here: ${rows.length}  (PHP ${peso(cents(rows))})`)
    console.log(`  SIGNED             ${signed.length}`)
    console.log(`  READY FOR RELEASE  ${ready.length}`)
    console.log(`  portal will be told (announced available, routed, with an APV): ${rows.filter((r) => r.tellPortal).length}`)
    console.log(`  skipped, a void is pending in Acumatica: ${skippedForVoid.length}${skippedForVoid.length ? '  ' + skippedForVoid.map((s) => s.checkNumber).join(', ') : ''}`)
    console.log(`  first 15: ${rows.slice(0, 15).map((r) => r.checkNumber).join(', ')}`)

    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `release-acumatica-closed-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const before = await db.check.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: {
        id: true, checkNumber: true, acumaticaPaymentId: true, acumaticaStatus: true, status: true, amount: true,
        releasedAt: true, releasedById: true, readyAt: true, readyById: true, availablePickupDate: true,
        portalSyncStatus: true, portalDomain: true,
      },
    })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), rows: before }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
    console.log(`\nSnapshot written: ${snap} (${before.length} checks)`)

    const res = await releaseClosedStillLive(db, rows, now)
    console.log(`\nDONE  released ${res.released} of ${rows.length}; portal RELEASED events queued ${res.portalQueued}`)
    console.log(`  still SIGNED/READY here and Closed in Acumatica: ${(await findClosedStillLive(db, voidedRefs)).length}`)
    console.log('  The queued events go out on the next delivery (Deliver now on /admin/portal, or the 12:00/18:00 cron).\n')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
