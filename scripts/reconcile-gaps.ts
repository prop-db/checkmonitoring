/**
 * Fill in the amounts and payees the register never recorded, from Acumatica.
 *
 * The register leaves 298 cheques without an amount, a payee, or both — the
 * cells are simply blank, or hold the word "CANCELLED" where a figure belongs.
 * Acumatica knows most of them. This reads both tenants and updates ONLY those
 * cheques.
 *
 * Deliberately NOT a full sync. `runSync` would also create every Acumatica
 * payment absent from the register — roughly 28,000 rows, about three hours —
 * which is a different decision about what this system holds, and not one to
 * make as a side effect of filling in some blanks. Use `runSync` when you want
 * that; use this when you want the gaps closed.
 *
 * Everything goes through `upsertCheck`, so duplicate prevention, the
 * immutable-field list and the audit row all still apply.
 *
 * **This DOES change status in one case, and only one: a void.** An earlier
 * version of this comment claimed status was never touched. That was wrong.
 * Acumatica is authoritative on whether a cheque was voided — the register is
 * not — so `IMMUTABLE_ON_UPDATE` has a deliberate exception for it, and the
 * first real run moved 44 cheques to VOIDED. Every one of them had been sitting
 * in Finance's working queue as releasable (43 in READY_FOR_RELEASE, 1 in
 * SIGNATURE_PENDING) while the ERP considered them void.
 *
 * That is the point of reconciling, not a side effect to suppress. A further
 * 101 voids were recorded as `void_not_applied` because the cheque was already
 * CANCELLED — noted in the audit trail rather than forced through, since a
 * cancellation is a Finance decision with a reason attached and a void must not
 * quietly overwrite one.
 *
 * Nothing else about a Finance-owned field moves: who signed, who released,
 * pickup dates and OR numbers are all untouched.
 *
 * Usage:
 *   npx.cmd tsx scripts/reconcile-gaps.ts --dry-run
 *   npx.cmd tsx scripts/reconcile-gaps.ts
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createAcumaticaClient, PAYMENTS_FEED, PAYMENT_FIELDS } from '../lib/integrations/acumatica/client'
import { mapPayment, collapseVoidPairs } from '../lib/integrations/acumatica/map'
import { upsertCheck } from '../lib/import/upsert'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'
import type { NormalisedRow } from '../lib/normalised-row'

const DRY = process.argv.includes('--dry-run')
const db = new PrismaClient()
const key = (company: string, checkNumber: string) => `${company}|${checkNumber}`

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set.`)
  return v
}

async function tenantRows(tenant: AcumaticaTenant, baseUrl: string): Promise<NormalisedRow[]> {
  const client = createAcumaticaClient({
    baseUrl,
    user: env('ACUMATICA_ODATA_USER'),
    password: env('ACUMATICA_ODATA_PASSWORD'),
  })
  const raw = await client.fetchAll(PAYMENTS_FEED, { select: PAYMENT_FIELDS, pageSize: 2000 })
  const mapped = raw.map((r) => mapPayment(r, tenant)).filter((r): r is NormalisedRow => r !== null)
  // A void is two feed rows under one reference. Collapsing keeps the ORIGINAL,
  // whose amount is positive; without this the surviving row can be the
  // negative reversal, and a cheque would be reconciled to minus its own value.
  const collapsed = collapseVoidPairs(mapped)
  console.log(`  ${tenant.padEnd(14)} fetched ${raw.length.toLocaleString().padStart(7)}  usable ${collapsed.length.toLocaleString()}`)
  return collapsed
}

async function main() {
  const gaps = await db.check.findMany({
    where: { OR: [{ amount: null }, { payeeName: null }] },
    select: { id: true, checkNumber: true, amount: true, payeeName: true, company: { select: { code: true } } },
  })
  console.log(`\nCHEQUES WITH A GAP\n  ${gaps.length} (no amount, no payee, or neither)\n`)
  const want = new Map(gaps.map((g) => [key(g.company.code, g.checkNumber), g]))

  console.log('READING ACUMATICA')
  const rows = [
    ...await tenantRows('GOLIVE', env('ACUMATICA_ODATA_URL')),
    ...await tenantRows('MANUFACTURING', env('ACUMATICA_ODATA_URL_MFG')),
  ]

  // Only rows that correspond to a cheque we already hold AND that actually
  // supply something missing. Anything else would be a create — this script
  // never adds a cheque, which is what keeps it distinct from a full sync.
  const seen = new Set<string>()
  const useful: NormalisedRow[] = []
  let fillsAmount = 0, fillsPayee = 0
  for (const r of rows) {
    if (!r.checkNumber || !r.companyCode) continue
    const k = key(r.companyCode, r.checkNumber)
    const gap = want.get(k)
    if (!gap || seen.has(k)) continue
    const a = !gap.amount && r.amount !== null
    const p = !gap.payeeName && r.payeeName !== null
    if (!a && !p) continue
    seen.add(k)
    if (a) fillsAmount++
    if (p) fillsPayee++
    useful.push(r)
  }

  console.log(`\nWHAT ACUMATICA CAN SUPPLY`)
  console.log(`  cheques it can complete       ${useful.length}`)
  console.log(`    amounts it can fill         ${fillsAmount}`)
  console.log(`    payees it can fill          ${fillsPayee}`)
  console.log(`  no Acumatica record           ${gaps.length - useful.length}`)
  console.log(`  ─────────────────────────────────────`)
  console.log(`  total gaps                    ${gaps.length}`)

  if (DRY) { console.log('\nDRY RUN — nothing was written.\n'); return }

  const ownCompanyNames = (await db.company.findMany({ select: { legalNames: true } })).flatMap((c) => c.legalNames)
  const now = new Date()
  let updated = 0, created = 0, staged = 0, errors = 0

  for (const row of useful) {
    try {
      const res = await upsertCheck(db, { row, ownCompanyNames, now })
      if (res.outcome === 'UPDATED') updated++
      else if (res.outcome === 'CREATED') created++
      else staged++
    } catch (e) {
      errors++
      // One bad row must not abort the run. The message is printed without the
      // row, which carries a vendor name and an amount.
      console.error(`  error on a cheque: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log(`\nWRITTEN`)
  console.log(`  updated                       ${updated}`)
  console.log(`  created                       ${created}   (expected 0 — this script does not add cheques)`)
  console.log(`  staged                        ${staged}`)
  console.log(`  errors                        ${errors}`)

  const left = await db.check.count({ where: { OR: [{ amount: null }, { payeeName: null }] } })
  console.log(`\n  cheques still with a gap      ${left}  (was ${gaps.length})\n`)
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
