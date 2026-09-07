import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'
import { backfillApvNumbers, indexVouchers } from '../lib/admin/backfill-apv-numbers'
import { detectWorkbook } from '../lib/import/detect'
import { parseRows } from '../lib/import/parse'
import { readWorkbook } from '../lib/import/workbook'
import { parseArgs } from './workbook-args'

/**
 * Fill `Check.apvNumbers` from the register, for cheques that pre-date the
 * column.
 *
 *   npx tsx scripts/backfill-apv-numbers.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run
 *   npx tsx scripts/backfill-apv-numbers.ts "CHECK MONITORING 9.1.2026.xlsx"
 *
 * The register's column headed VOUCHER NUMBER has carried an AP voucher for
 * 11,552 of its 11,779 distinct cheque numbers since the first import, and the
 * parser has read them all along — there was simply no column on `Check` to put
 * them in, so 84 vouchers reached the database and all 84 came from the
 * approval-for-release workbook's 85-row snapshot.
 *
 * Four things about it are requirements rather than conveniences, and they are
 * the same four the historical import states.
 *
 * **`--dry-run` writes nothing**, and computes its numbers with the same
 * function the real run uses, so the second cannot surprise you after the
 * first.
 *
 * **It is idempotent.** The write is a union, so a second run reports 0 changed
 * and a voucher an import has since written is never removed.
 *
 * **It never prints a payee or an amount.** Everything below is a count or a
 * cheque number. Both workbooks hold the client's real supplier names and
 * figures; the path is an argument and is never hardcoded.
 *
 * **It writes ONE column.** No status moves, no amount is touched, no audit row
 * is written. A cheque number that names more than one cheque is skipped rather
 * than chosen between — see `backfillApvNumbers` for why.
 *
 * It reads `DATABASE_URL`, so it acts on whichever database that names. There is
 * deliberately no `--database` flag: a script that can be pointed at a database
 * by an argument is one that gets pointed at the wrong one.
 */

const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number | string, width = 38) =>
  console.log('  ' + label.padEnd(width) + String(typeof value === 'number' ? n(value) : value).padStart(9))
const rule = (width = 38) => console.log('  ' + '─'.repeat(width + 9))
const heading = (text: string) => console.log('\n' + text)

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(
      `${args.error}\n\n` +
        'Usage: npx tsx scripts/backfill-apv-numbers.ts <register.xlsx> [--dry-run]\n\n' +
        '  --dry-run   Read and report, write nothing.',
    )
    process.exitCode = 1
    return
  }

  const db = new PrismaClient()
  try {
    const rows = await readWorkbook(await readFile(args.path))
    const detected = detectWorkbook(rows)

    // The basename only. The path is the operator's own argument, and a full
    // path on a shared terminal is one more thing to redact.
    heading(`WORKBOOK  ${basename(args.path)}`)
    line('sheets', detected.sheets.length)
    line('data rows', detected.dataRows)
    line('recognised as', detected.kind)

    // Refused rather than tolerated. The approval-for-release workbook also
    // carries vouchers, on a different grain and in a different column, and
    // reading it here would attach one cheque's voucher to another.
    if (detected.kind !== 'REGISTER') {
      throw new Error(
        'This is not the cheque register. Vouchers are backfilled from ' +
          `CHECK MONITORING only; this file was recognised as ${detected.kind}.`,
      )
    }

    const { parsed } = parseRows(rows)
    const index = indexVouchers(parsed)

    // Read BEFORE anything is written, so the two figures below are a genuine
    // before and after rather than the same number printed twice.
    const before = await db.check.count({ where: { NOT: { apvNumbers: { isEmpty: true } } } })
    const total = await db.check.count()

    const result = await backfillApvNumbers(db, { index, dryRun: args.dryRun })

    heading('THE REGISTER')
    line('cheque numbers stating a voucher', result.checkNumbers)
    line('distinct vouchers', result.vouchers)

    heading('AGAINST THIS DATABASE')
    line('resolve to exactly one cheque', result.matched)
    line('resolve to more than one — skipped', result.ambiguous)
    line('name no cheque here', result.absent)
    rule()
    line('total', result.checkNumbers)

    heading(args.dryRun ? 'WOULD CHANGE' : 'CHANGED')
    line('cheques gaining a voucher', result.changed)
    line('already complete', result.unchanged)

    heading('CHEQUES CARRYING AT LEAST ONE VOUCHER')
    line('before', before)
    line(args.dryRun ? 'after (unchanged — dry run)' : 'after', result.chequesWithVouchers)
    line('cheques in the table', total)

    if (args.dryRun) heading('DRY RUN — nothing was written.')
    console.log('')
  } catch (e) {
    console.error('\n' + (e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

void main()
