import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { backfillApvNumbers, indexVouchers, type VoucherIndex } from '@/lib/admin/backfill-apv-numbers'
import { parseRows } from '@/lib/import/parse'

beforeEach(resetDb)

// A register row shaped as the real BPI RELEASED sheet is: the cheque number in
// column 3, the CV in the column headed CHECKS APV (4), the payee in E, the AP
// voucher in the column headed VOUCHER NUMBER (8), and the amount in J.
// Restated here rather than imported, so this file pins the layout against the
// workbook instead of agreeing with whatever the parser happens to believe.
const registerRow = (row: number, checkNumber: string, voucher: string | null) => ({
  sheet: 'BPI RELEASED',
  row,
  cells: [
    null, null, checkNumber, 'CV-ST019517', 'STARKSON PACKAGING INC.',
    'SUPPLIES', 'LOCAL SUPPLIER', voucher, 46247, 12345.67,
  ],
})

const index = (...rows: ReturnType<typeof registerRow>[]): VoucherIndex =>
  indexVouchers(parseRows(rows).parsed)

const run = (i: VoucherIndex, dryRun = false) => backfillApvNumbers(testDb, { index: i, dryRun })

describe('indexVouchers', () => {
  it('groups every voucher the register states under its cheque number', () => {
    const i = index(
      registerRow(2, '6000353106', 'AP-ST042652'),
      registerRow(3, '6000353107', 'AP-ST042653'),
    )
    expect(i.get('6000353106')).toEqual(['AP-ST042652'])
    expect(i.get('6000353107')).toEqual(['AP-ST042653'])
  })

  it('collects both vouchers when one cheque sits on two sheets', () => {
    // Measured 2026-09-07: 360 cheque numbers appear on more than one parsed
    // row and 11 of them state a different voucher on each. Keeping only the
    // last row's is how a voucher goes missing, which is the defect this whole
    // change exists for.
    const i = index(
      registerRow(2, '6000353106', 'AP-ST042652'),
      { ...registerRow(9, '6000353106', 'AP-ST042999'), sheet: 'CANCELLED' },
    )
    expect(i.get('6000353106')).toEqual(['AP-ST042652', 'AP-ST042999'])
  })

  it('skips a row that states no voucher rather than keying an empty list', () => {
    // 227 of the register's cheque numbers carry none. An empty entry would be
    // counted as a cheque number to reconcile and reported as work to do.
    const i = index(registerRow(2, '6000353106', null))
    expect(i.size).toBe(0)
  })

  it('canonicalises the cheque number through the shared rule', () => {
    // `ParsedRow.checkNumber` is what the register STATED; `mapParsedRow` runs
    // it through `canonicalCheckNumber` before the importer stores it. So the
    // index has to key on the canonical form or it looks up a number the
    // database does not hold.
    //
    // Built by hand rather than through `parseRows`, because `sniff` refuses a
    // bank-prefixed cell outright — the register writes its numbers bare and
    // this is the belt to the importer's braces, not a case the register
    // produces.
    const i = indexVouchers([{
      sheet: 'BPI RELEASED', row: 2, checkNumber: 'BPI 6000353106', cvNumber: null,
      apvNumbers: ['AP-ST042652'], poNumbers: [], checkBook: null, cashAccountLabel: null,
      category: null, clearingRef: null, checkDate: null, amount: null, currency: null,
      payee: null, unclassified: [],
    }])
    expect([...i.keys()]).toEqual(['6000353106'])
  })
})

describe('backfillApvNumbers', () => {
  it('writes the register\'s vouchers onto a cheque that has none', async () => {
    // The state every one of production's 9,247 register-derived cheques is in:
    // written before the column existed, so the register's voucher is in the
    // workbook and nowhere else.
    const check = await makeCheck({ checkNumber: '6000353106' })
    const result = await run(index(registerRow(2, '6000353106', 'AP-ST042652')))

    expect(result).toMatchObject({ matched: 1, changed: 1, unchanged: 0, absent: 0, ambiguous: 0 })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.apvNumbers).toEqual(['AP-ST042652'])
  })

  it('is idempotent', async () => {
    await makeCheck({ checkNumber: '6000353106' })
    const i = index(registerRow(2, '6000353106', 'AP-ST042652'))
    await run(i)
    const second = await run(i)
    expect(second).toMatchObject({ changed: 0, unchanged: 1 })
  })

  it('adds to what a cheque already carries and never replaces it', async () => {
    // A voucher an import has since written must survive. Nothing here can
    // empty an array or shorten one.
    const check = await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042999'] })
    await run(index(registerRow(2, '6000353106', 'AP-ST042652')))

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.apvNumbers).toEqual(['AP-ST042652', 'AP-ST042999'])
  })

  it('skips a cheque number two cheques claim, rather than choosing one', async () => {
    // The state `scripts/merge-duplicate-cheques.ts` exists to clear. Choosing
    // between them would be this script deciding which company's cheque settled
    // which supplier's bill.
    const a = await makeCheck({ checkNumber: '6000353106' })
    const b = await makeCheck({ checkNumber: '6000353106' })
    const result = await run(index(registerRow(2, '6000353106', 'AP-ST042652')))

    expect(result).toMatchObject({ ambiguous: 1, matched: 0, changed: 0 })
    for (const id of [a.id, b.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).apvNumbers).toEqual([])
    }
  })

  it('counts a cheque number that is not here rather than failing on it', async () => {
    // 2,766 register rows never became cheques — staged for want of a company,
    // or for an ambiguous one. Their vouchers have nowhere to go, and that is
    // an accounting line, not an error.
    const result = await run(index(registerRow(2, '6000353106', 'AP-ST042652')))
    expect(result).toMatchObject({ absent: 1, matched: 0, changed: 0 })
  })

  it('writes nothing on a dry run, and reports what the real run would do', async () => {
    const check = await makeCheck({ checkNumber: '6000353106' })
    const i = index(registerRow(2, '6000353106', 'AP-ST042652'))

    const dry = await run(i, true)
    expect(dry).toMatchObject({ matched: 1, changed: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).apvNumbers).toEqual([])

    const wet = await run(i)
    // The dry run and the run that follows it must not disagree. They share the
    // decision, so this is a property rather than a coincidence.
    expect(wet.changed).toBe(dry.changed)
    expect(wet.matched).toBe(dry.matched)
  })

  it('touches nothing but the voucher column', async () => {
    // An import never changes a cheque's status (rule 4), and a backfill is an
    // import by another name. This one writes exactly one column.
    const check = await makeCheck({
      checkNumber: '6000353106', status: 'RELEASED', amount: '197715.42',
    })
    await run(index(registerRow(2, '6000353106', 'AP-ST042652')))

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.amount?.toFixed(2)).toBe('197715.42')
    expect(after.payeeName).toBe(check.payeeName)
    expect(after.checkDate).toEqual(check.checkDate)
  })

  it('writes no audit row', async () => {
    // The trail records what happened to a cheque. A reference list arriving
    // late is a repair to this system, not an event in the cheque's life, and
    // 11,552 rows saying so would bury the ones that matter. Same decision
    // `backfillIncompleteFlags` made.
    await makeCheck({ checkNumber: '6000353106' })
    await run(index(registerRow(2, '6000353106', 'AP-ST042652')))
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('reports the before and after in the same units', async () => {
    await makeCheck({ checkNumber: '6000353106' })
    await makeCheck({ checkNumber: '6000353107' })
    const result = await run(index(
      registerRow(2, '6000353106', 'AP-ST042652'),
      registerRow(3, '6000353107', 'AP-ST042653'),
    ))
    expect(result.checkNumbers).toBe(2)
    expect(result.vouchers).toBe(2)
    expect(result.chequesWithVouchers).toBe(2)
  })
})
