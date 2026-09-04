/**
 * Run an Acumatica sync from a machine, not from the browser.
 *
 * WHY THIS EXISTS. The SYNC NOW button calls the same `runSync`, but inside a
 * Vercel serverless request — and a first FULL sync of the GO-LIVE tenant reads
 * 41,998 rows. Vercel kills the function at its timeout, so on 2026-09-04 that
 * button got about 12,500 rows in, wrote 12,570 cheques, and was terminated. A
 * platform kill runs no `catch`, so the `SyncRun` row sat with `finishedAt`
 * null and the button spun forever.
 *
 * The rows already written are committed and correct — the sync is idempotent,
 * exactly like the register import — so the fix is to finish it from here,
 * where nothing imposes a request timeout.
 *
 * Once a tenant has a watermark, INCREMENTAL runs are small (a day's payments,
 * not 42,000) and the button is fine. This script is for the first run, and for
 * any catch-up after a long outage.
 *
 * Usage:
 *   npx.cmd tsx scripts/sync.ts GOLIVE --dry-run
 *   npx.cmd tsx scripts/sync.ts GOLIVE
 *   npx.cmd tsx scripts/sync.ts MANUFACTURING
 *   npx.cmd tsx scripts/sync.ts GOLIVE --full     # ignore the watermark
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createAcumaticaClient, PAYMENTS_FEED, PAYMENT_FIELDS } from '../lib/integrations/acumatica/client'
import { runSync, lastSyncWatermark } from '../lib/sync/run'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'

const TENANTS: Record<AcumaticaTenant, string> = {
  GOLIVE: 'ACUMATICA_ODATA_URL',
  MANUFACTURING: 'ACUMATICA_ODATA_URL_MFG',
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const FORCE_FULL = args.includes('--full')
const tenant = args.find((a) => !a.startsWith('--')) as AcumaticaTenant | undefined

const db = new PrismaClient()

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set.`)
  return v
}

async function main() {
  if (!tenant || !(tenant in TENANTS)) {
    throw new Error(`Name a tenant: ${Object.keys(TENANTS).join(' or ')}`)
  }

  const watermark = FORCE_FULL ? null : await lastSyncWatermark(db, tenant)
  const before = await db.check.count()

  console.log(`\nTENANT      ${tenant}`)
  console.log(`MODE        ${watermark ? `INCREMENTAL since ${watermark.toISOString()}` : 'FULL (no watermark)'}`)
  console.log(`CHEQUES     ${before.toLocaleString()} before this run`)

  if (!watermark) {
    console.log(
      `\n  NOTE: a full sync CREATES a cheque for every Acumatica payment not already held.\n` +
      `  On GO-LIVE that is roughly 28,000 records beyond the workbook register. This is a\n` +
      `  decision about what this system contains, not a refresh. Use --dry-run first.`,
    )
  }

  if (DRY) {
    // Read the feed but write nothing, so the size of the job is known before
    // committing to it. `runSync` has no dry mode of its own — deliberately, so
    // that nothing can half-write — hence the separate read here.
    const client = createAcumaticaClient({
      baseUrl: env(TENANTS[tenant]),
      user: env('ACUMATICA_ODATA_USER'),
      password: env('ACUMATICA_ODATA_PASSWORD'),
    })
    const rows = await client.fetchAll(PAYMENTS_FEED, {
      select: PAYMENT_FIELDS,
      pageSize: 2000,
      ...(watermark ? { filter: `LastModifiedOn ge datetime'${watermark.toISOString().slice(0, 19)}'` } : {}),
    })
    console.log(`\nDRY RUN — the feed returns ${rows.length.toLocaleString()} rows. Nothing was written.\n`)
    return
  }

  const started = Date.now()
  const res = await runSync(db, {
    client: createAcumaticaClient({
      baseUrl: env(TENANTS[tenant]),
      user: env('ACUMATICA_ODATA_USER'),
      password: env('ACUMATICA_ODATA_PASSWORD'),
    }),
    tenant,
    since: watermark,
    now: new Date(),
  })

  const after = await db.check.count()
  console.log(`\nRESULT  (${((Date.now() - started) / 60000).toFixed(1)} min)`)
  console.log(`  fetched                       ${res.fetched.toLocaleString()}`)
  console.log(`  skipped (not payments)        ${res.skipped.toLocaleString()}`)
  console.log(`  void pairs folded             ${res.collapsed.toLocaleString()}`)
  console.log(`  imported                      ${res.imported.toLocaleString()}`)
  console.log(`  updated                       ${res.updated.toLocaleString()}`)
  console.log(`  staged                        ${res.staged.toLocaleString()}`)
  console.log(`  errors                        ${res.errors.toLocaleString()}`)
  console.log(`  staged rows promoted          ${res.promoted.toLocaleString()}`)
  console.log(`  ─────────────────────────────────────`)
  // The invariant that makes "nothing was silently dropped" checkable.
  const accounted = res.skipped + res.collapsed + res.imported + res.updated + res.staged + res.errors
  console.log(`  accounted for                 ${accounted.toLocaleString()} of ${res.fetched.toLocaleString()}` +
    (accounted === res.fetched ? '  ✓' : '  <-- MISMATCH, investigate'))
  console.log(`\n  cheques ${before.toLocaleString()} -> ${after.toLocaleString()}`)
  console.log(`  next watermark                ${res.watermark ? res.watermark.toISOString() : '(unchanged)'}\n`)
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
