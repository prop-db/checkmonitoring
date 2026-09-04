import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'
import { importBills, parseBillRows, previewBillImport } from '../lib/import/bills'
import { detectWorkbook } from '../lib/import/detect'
import { mapParsedRow } from '../lib/import/map-row'
import { parseRows } from '../lib/import/parse'
import { previewRegisterImport, type ImportPreview } from '../lib/import/preview'
import { loadCompanyReferenceData, loadOwnCompanyNames } from '../lib/import/reference'
import { importRows } from '../lib/import/upsert'
import { readWorkbook } from '../lib/import/workbook'
import { parseArgs, type WorkbookArgs } from './workbook-args'

/**
 * The one-time historical load.
 *
 *   npx tsx scripts/import-workbook.ts <workbook.xlsx> [--dry-run]
 *
 * Three things about this script are requirements rather than conveniences.
 *
 * **It prints the full accounting, not an imported count.** 22% of the client's
 * register does not import. A run that reported "9,461 checks imported" would
 * be read as a complete load, and the 2,766 rows that are not there would be
 * discovered weeks later by somebody looking for a cheque.
 *
 * **It never logs a vendor name, a payee or an amount.** Both workbooks are
 * gitignored because they hold the client's real supplier names and figures.
 * Everything below is a count, or a sheet-and-row reference to a cell — which
 * is what a human needs in order to go and look, and is not itself data about
 * anybody. The path is taken as an argument and never hardcoded.
 *
 * **`--dry-run` writes nothing.** This is the point of the whole exercise: it
 * lets Finance see the 2,766 staged rows and correct the register *before*
 * anything lands. The dry run and the real run compute their accounting with
 * the same function, so the second cannot surprise you after the first.
 *
 * It is also re-runnable. `upsertCheck` is idempotent and `StagedCheck` is
 * unique on both of its identities, so a second run creates nothing and
 * changes no Finance-set field.
 */

const OVERRIDE = 'ALLOW_IMPORT_OVER_REAL_DATA'

type Args = WorkbookArgs

const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number | string, width = 34) =>
  console.log('  ' + label.padEnd(width) + String(typeof value === 'number' ? n(value) : value).padStart(9))
const rule = (width = 34) => console.log('  ' + '─'.repeat(width + 9))
const heading = (text: string) => console.log('\n' + text)

/**
 * The same shape of guard as `prisma/seed.ts`, and for the same reason: guessing
 * at "production" from `NODE_ENV` does not work, because a script run through
 * npm has it unset while still connecting to whatever `DATABASE_URL` names.
 *
 * The detector here is `sourceSheet IS NULL` — a cheque no register row put
 * there. Seeded fixtures and Acumatica-synced cheques both look like that, and
 * both carry Finance-set state that a twelve-thousand-row load has no business
 * running over the top of. Cheques this import itself wrote all carry their
 * sheet, which is what leaves the script freely re-runnable.
 */
async function assertSafeTarget(db: PrismaClient): Promise<void> {
  const foreign = await db.check.count({ where: { sourceSheet: null } })
  if (foreign === 0 || process.env[OVERRIDE] === 'true') return

  throw new Error(
    `Refusing to import: the target database holds ${n(foreign)} cheque(s) that did not come from a\n` +
      'register import — seeded fixtures, or cheques synced from Acumatica. This does not look like\n' +
      `a database waiting for the historical load. Set ${OVERRIDE}=true only if you are certain,\n` +
      'and never against production.',
  )
}

function reportRegisterPreview(preview: ImportPreview): void {
  heading('ACCOUNTING — every row of the workbook, imported or not')
  line('will import', preview.willImport)
  line('staged NO_COMPANY', preview.stagedByReason.NO_COMPANY)
  line('staged AMBIGUOUS_COMPANY', preview.stagedByReason.AMBIGUOUS_COMPANY)
  line('staged NO_CHECK_NUMBER', preview.stagedByReason.NO_CHECK_NUMBER)
  rule()
  line('total', preview.totalRows)

  // The 2026-09-04 scope ruling. Without this split the staged pile reads as a
  // 2,766-row cleanup project; it is about 28 cheques of live work sitting under
  // two and a half thousand that are closed history.
  heading('OF THE ROWS THAT WILL NOT IMPORT')
  line('still in the release workflow', preview.stagedLive)
  line('already released or cancelled', preview.stagedClosed)
  if (preview.stagedUnruled > 0) line('status not ruled on', preview.stagedUnruled)
  for (const s of preview.stagedByImpliedStatus) line(`  implies ${s.status}`, s.count)

  heading('RECONCILIATION')
  line('contradictory-status cheques', preview.contradictions.length)
  const rulings = new Map<string, number>()
  for (const c of preview.contradictions) {
    const key = `  ${c.implied.join('+')} → ${c.resolvedFrom}`
    rulings.set(key, (rulings.get(key) ?? 0) + 1)
  }
  for (const [key, count] of [...rulings].sort()) line(key, count)
  line('cash account vs checkbook conflicts', preview.companyConflicts.length)
  line('duplicates across sheets', preview.conflictsByKind.DUPLICATE_ACROSS_SHEETS)
  line('amount mismatches', preview.conflictsByKind.AMOUNT_MISMATCH)
  line('implausible dates', preview.conflictsByKind.IMPLAUSIBLE_DATE)

  heading('VENDOR MERGE LIST')
  line('payee spellings', preview.distinctPayees)
  line('groups that fold together', preview.vendorMerges.length)
  console.log('  Reported, never applied. Confirm merges on /admin/import.')

  if (preview.unruledClashes.length > 0) {
    heading('BLOCKED — sheet combinations Finance has not ruled on')
    for (const c of preview.unruledClashes) {
      // The cell, not the cheque. A sheet and a row number is what somebody
      // needs in order to go and look, and carries no vendor data.
      console.log(`  ${c.sheets.join(' + ')} — ${c.rows.map((r) => `${r.sheet} row ${r.row}`).join(', ')}`)
    }
  }
}

async function importRegister(db: PrismaClient, rows: Awaited<ReturnType<typeof readWorkbook>>, args: Args) {
  const ref = await loadCompanyReferenceData(db)
  const { parsed, review } = parseRows(rows)
  const preview = previewRegisterImport({ parsed, review, ref, today: new Date() })

  heading('SHEETS')
  for (const s of preview.sheets) line(s.sheet, s.rows)

  reportRegisterPreview(preview)

  if (preview.unruledClashes.length > 0) {
    throw new Error(
      `${preview.unruledClashes.length} cheque(s) appear on a combination of sheets Finance has not ` +
        'ruled on. The importer will not choose a status for them; a human has to. Nothing was written.',
    )
  }

  if (args.dryRun) {
    heading('DRY RUN — nothing was written.')
    return
  }

  await assertSafeTarget(db)

  const ownCompanyNames = await loadOwnCompanyNames(db)
  // Rows that could not be keyed travel with the rest, so that
  // `rows === created + updated + staged` covers the whole workbook and
  // "nothing is silently dropped" is a checkable claim rather than a promise.
  const normalised = [
    ...parsed.map((p) => mapParsedRow(p, ref)),
    ...review.map((r) => mapParsedRow(r.unkeyed, ref)),
  ]
  const summary = await importRows(db, { rows: normalised, ownCompanyNames, now: new Date() })

  heading('WRITTEN')
  line('created', summary.created)
  line('updated', summary.updated)
  line('staged NO_COMPANY', summary.stagedByReason.NO_COMPANY)
  line('staged AMBIGUOUS_COMPANY', summary.stagedByReason.AMBIGUOUS_COMPANY)
  line('staged NO_CHECK_NUMBER', summary.stagedByReason.NO_CHECK_NUMBER)
  rule()
  line('total', summary.rows)

  // Stated out loud rather than trusted. A second run is expected to report
  // zero created and the same staged counts; anything else means the import is
  // not idempotent and the numbers above are not a load, they are a guess.
  const accounted = summary.created + summary.updated + summary.staged
  if (accounted !== summary.rows || summary.rows !== preview.totalRows) {
    throw new Error(
      `Accounting mismatch: ${n(summary.rows)} rows in, ${n(accounted)} accounted for, ` +
        `${n(preview.totalRows)} previewed. Some rows were neither written nor staged.`,
    )
  }
}

async function importBillDetail(db: PrismaClient, rows: Awaited<ReturnType<typeof readWorkbook>>, args: Args) {
  const { bills, review } = parseBillRows(rows)
  const preview = await previewBillImport(db, { bills, review })

  heading('ACCOUNTING — every row of the LIST sheet')
  line('bills read', preview.bills)
  line('  of which match a cheque', preview.willImport)
  line('  of which need review', preview.unmatched.length)
  line('rows that are not a usable bill', preview.review.length)
  rule()
  line('total', preview.totalRows)

  if (preview.unmatched.length > 0) {
    heading('BILLS WHOSE CHEQUE IS NOT HERE')
    const byReason = new Map<string, number>()
    for (const u of preview.unmatched) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1)
    for (const [reason, count] of byReason) line(`  ${reason}`, count)
    console.log('  Not an error, and not dropped: the cheque may be staged for want of a company,')
    console.log('  or simply absent from the register. Review these on /admin/import.')
  }

  if (args.dryRun) {
    heading('DRY RUN — nothing was written.')
    return
  }

  // No target guard here, deliberately. This path writes only `CheckBill` rows,
  // keyed on `(checkId, apvNumber)`; it creates no cheque, changes no status,
  // and matches nothing it did not find already in the database.
  const summary = await importBills(db, { bills, now: new Date() })

  heading('WRITTEN')
  line('bills created', summary.created)
  line('bills updated', summary.updated)
  line('left for review', summary.unmatched.length)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(
      `${args.error}\n\n` +
        'Usage: npx tsx scripts/import-workbook.ts <workbook.xlsx> [--dry-run]\n\n' +
        '  --dry-run   Read and report, write nothing.\n\n' +
        `  ${OVERRIDE}=true  Import even though the database already holds cheques\n` +
        '                                that did not come from a register import.',
    )
    process.exitCode = 1
    return
  }

  const db = new PrismaClient()
  try {
    const buffer = await readFile(args.path)
    const rows = await readWorkbook(buffer)
    const detected = detectWorkbook(rows)

    // The basename only. The path is the operator's own argument, and a full
    // path on a shared terminal is one more thing to redact.
    heading(`WORKBOOK  ${basename(args.path)}`)
    line('sheets', detected.sheets.length)
    line('data rows', detected.dataRows)
    line('recognised as', detected.kind)

    if (detected.kind === 'UNKNOWN') {
      throw new Error(`This is neither of the two workbooks. ${detected.reason}`)
    }

    if (detected.kind === 'BILLS') await importBillDetail(db, rows, args)
    else await importRegister(db, rows, args)

    console.log('')
  } catch (e) {
    console.error('\n' + (e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

void main()
