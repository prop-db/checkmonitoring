import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  BILL_CHECK_REF_RULING, BILL_SHEET, importBills, parseBillRows, type ParsedBill,
} from '@/lib/import/bills'
import type { RawRow } from '@/lib/import/workbook'

// The LIST sheet's measured layout, 0-indexed exactly as `readWorkbook` yields
// a row's cells. Restated here rather than imported from the parser so this
// file pins the mapping against the workbook, instead of agreeing with whatever
// the parser happens to believe.
const COL = {
  date: 0, postPeriod: 1, referenceNbr: 2, vendorRef: 3, vendorName: 4,
  balanceAmount: 5, description: 6, dueDate: 7, type: 8, detailTotal: 9,
  termsCode: 10, createdBy: 11, glAccount: 17, financeRemarks: 18,
  paymentRef: 19, checkNo: 20, bank: 21,
} as const

const WIDTH = 24

function listRow(row: number, values: Partial<Record<keyof typeof COL, unknown>>): RawRow {
  const cells: unknown[] = new Array<unknown>(WIDTH).fill(null)
  for (const key of Object.keys(values) as (keyof typeof COL)[]) cells[COL[key]] = values[key]
  return { sheet: BILL_SHEET, row, cells }
}

// A complete, well-formed LIST row, so a test states only what it is about.
// Typed against `COL` deliberately: a misspelt override is a compile error
// rather than a silently ignored key.
function billRow(row: number, values: Partial<Record<keyof typeof COL, unknown>> = {}): RawRow {
  return listRow(row, {
    date: new Date('2026-08-04T00:00:00Z'),
    postPeriod: '08-2026',
    referenceNbr: 'AP-A1033419',
    vendorRef: 'PO-A1-025543',
    vendorName: 'ACME TRADING INC.',
    balanceAmount: 0,
    description: 'CORRUGATED SHEETS',
    dueDate: new Date('2026-09-03T00:00:00Z'),
    type: 'Bill',
    detailTotal: 197715.42,
    termsCode: '30D',
    createdBy: 'JASMINE RABANG',
    glAccount: 'RAW MATERIALS',
    financeRemarks: 'AVAILABLE',
    checkNo: 6000338925,
    bank: 'BPI STK',
    ...values,
  })
}

function only(result: { bills: ParsedBill[] }): ParsedBill {
  expect(result.bills).toHaveLength(1)
  return result.bills[0]
}

describe('parseBillRows', () => {
  it('maps each LIST column onto its CheckBill field', () => {
    const b = only(parseBillRows([billRow(2)]))
    expect(b.apvNumber).toBe('AP-A1033419')
    expect(b.poNumber).toBe('PO-A1-025543')
    expect(b.description).toBe('CORRUGATED SHEETS')
    expect(b.glAccount).toBe('RAW MATERIALS')
    expect(b.dueDate?.toISOString().slice(0, 10)).toBe('2026-09-03')
    expect(b.termsCode).toBe('30D')
    expect(b.amount).toBe('197715.42')
    expect(b.createdByName).toBe('JASMINE RABANG')
    expect(b.checkNumber).toBe('6000338925')
    expect(b.cashAccountLabel).toBe('BPI STK')
    expect(b.sheet).toBe(BILL_SHEET)
    expect(b.row).toBe(2)
  })

  it('ignores the PIVOT sheet entirely', () => {
    // PIVOT is a pivot table over LIST. Its rows are derived totals, not bills,
    // and letting one reach the database would double-count a bill.
    const pivot: RawRow = { sheet: 'PIVOT', row: 2, cells: ['BPI STK', 39, 1234567.89] }
    const result = parseBillRows([pivot, billRow(2)])
    expect(result.bills).toHaveLength(1)
    expect(result.review).toHaveLength(0)
  })

  it('reads a numeric cheque cell as digits, not as a float rendering', () => {
    // Every one of the 84 usable `check No.` cells is a numeric cell, so the
    // cheque number arrives as a JS number and has to survive the trip back to
    // a string intact.
    const b = only(parseBillRows([billRow(2, { checkNo: 1791361727 })]))
    expect(b.checkNumber).toBe('1791361727')
  })

  it('canonicalises a bank-prefixed cheque number through the shared rule', () => {
    // Acumatica prefixes 90.0% of its refs with a bank code. Matching a bill to
    // a cheque on the raw string would silently match nothing, so this must go
    // through `canonicalCheckNumber` rather than a second normalisation.
    const b = only(parseBillRows([billRow(2, { checkNo: 'BPI 6000240287' })]))
    expect(b.checkNumber).toBe('6000240287')
    expect(b.statedCheckRef).toBe('BPI 6000240287')
  })

  it('keeps the amount a decimal string and never a JS number', () => {
    for (const [cell, expected] of [
      [197715.42, '197715.42'],
      [7950, '7950'],
      ['1,234.56', '1234.56'],
      [0.05, '0.05'],
    ] as const) {
      const b = only(parseBillRows([billRow(2, { detailTotal: cell })]))
      expect(b.amount, String(cell)).toBe(expected)
      expect(typeof b.amount).toBe('string')
    }
  })

  it('sends an exponent-form total to review rather than expanding it', () => {
    // Same rule `readAmount` already applies to the register: expanding an
    // exponent risks inventing digits, and nothing in that range is a bill.
    const { bills, review } = parseBillRows([billRow(2, { detailTotal: 1e21 })])
    expect(bills).toHaveLength(0)
    expect(review[0]?.reason).toBe('NO_AMOUNT')
  })

  // CHANGED 2026-09-07. This used to assert that a row whose `check No.` is not
  // a cheque number goes to review at parse time. That was correct and it lost
  // a cheque: row 81 of the real LIST sheet holds a date there, and its voucher
  // AP-ST042652 therefore never reached the supplier portal. Whether such a row
  // is fatal is a question about the DATABASE — the voucher may name exactly
  // one cheque — and a pure parser cannot answer it. It is decided in
  // `matchBills`, which the tests below pin.
  it('keeps a row whose check No. is not a cheque number, with the cell verbatim', () => {
    const { bills, review } = parseBillRows([
      billRow(2, { checkNo: new Date('2026-08-13T00:00:00Z') }),
      billRow(3, { checkNo: null }),
      billRow(4, { checkNo: 'pls check w/ jasmine' }),
    ])
    expect(review).toHaveLength(0)
    expect(bills.map((b) => b.checkNumber)).toEqual([null, null, null])
    // Rendered as a date rather than through `String(new Date(...))`, which
    // yields "Thu Aug 13 2026 00:00:00 GMT+0800 (…)" — unusable to the person
    // who has to find the cheque this row means.
    expect(bills[0].statedCheckRef).toBe('2026-08-13')
    expect(bills[1].statedCheckRef).toBeNull()
    expect(bills[2].statedCheckRef).toBe('pls check w/ jasmine')
    // Everything else about the row survives, which is what makes it resolvable.
    expect(bills[0].apvNumber).toBe('AP-A1033419')
    expect(bills[0].amount).toBe('197715.42')
  })


  it('keeps a bill whose Type and Created By cells are blank', () => {
    // Measured: row 41 of the real LIST sheet has neither, and is a genuine
    // bill with a proper cheque number. Filtering on `Type = Bill` would drop it.
    const b = only(parseBillRows([billRow(2, { type: null, createdBy: null, postPeriod: null })]))
    expect(b.apvNumber).toBe('AP-A1033419')
    expect(b.createdByName).toBeNull()
  })

  it('reviews a row with no APV and one with no amount', () => {
    // `CheckBill.apvNumber` and `CheckBill.amount` are both NOT NULL. A bill
    // missing either cannot be written without inventing it.
    const { bills, review } = parseBillRows([
      billRow(2, { referenceNbr: null }),
      billRow(3, { detailTotal: null }),
      billRow(4, { detailTotal: 'CANCELLED' }),
    ])
    expect(bills).toHaveLength(0)
    expect(review.map((r) => r.reason)).toEqual(['NO_APV', 'NO_AMOUNT', 'NO_AMOUNT'])
    // A staged row has to be legible without reopening the workbook: the sheet
    // and row alone leave a human hunting for which of 85 rows it was.
    expect(review[1]).toMatchObject({ apvNumber: 'AP-A1033419', checkNumber: '6000338925' })
    expect(review[0].apvNumber).toBeNull()
  })

  it('drops nothing: every LIST row is either a bill or a review item', () => {
    const rows = [
      billRow(2),
      billRow(3, { checkNo: new Date('2026-08-13T00:00:00Z') }),
      billRow(4, { referenceNbr: '#N/A' }),
      billRow(5),
    ]
    const { bills, review } = parseBillRows(rows)
    expect(bills.length + review.length).toBe(rows.length)
  })

  it('reads a due date from an Excel serial as well as a date cell', () => {
    const serial = only(parseBillRows([billRow(2, { dueDate: 46164 })]))
    expect(serial.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-22')

    // ExcelJS yields an Invalid Date for a malformed date cell; it passes
    // `instanceof Date` and would throw on write.
    const bad = only(parseBillRows([billRow(2, { dueDate: new Date('nonsense') })]))
    expect(bad.dueDate).toBeNull()

    const none = only(parseBillRows([billRow(2, { dueDate: null })]))
    expect(none.dueDate).toBeNull()
  })

  it('carries the finance remark as evidence and states no status', () => {
    // AVAILABLE on all 85 rows corroborates READY_FOR_RELEASE, but import never
    // changes release status (D4). The remark is for a human to read.
    const b = only(parseBillRows([billRow(2)]))
    expect(b.financeRemark).toBe('AVAILABLE')
    expect(b).not.toHaveProperty('status')
  })
})

describe('importBills', () => {
  beforeEach(resetDb)

  // Bill detail is data about a cheque, never a reason to tell a supplier
  // anything. Asserted after every test rather than in one a later author could
  // forget to extend.
  afterEach(async () => {
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  const NOW = new Date('2026-09-04T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review } = parseBillRows(rows)
    return importBills(testDb, { bills, review, now: NOW })
  }

  it('writes a bill against the cheque its check No. names', async () => {
    const check = await makeCheck({ checkNumber: '6000338925' })
    const summary = await run([billRow(2)])

    expect(summary).toMatchObject({ bills: 1, created: 1, updated: 0 })
    expect(summary.unmatched).toHaveLength(0)

    const [bill] = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bill.apvNumber).toBe('AP-A1033419')
    expect(bill.poNumber).toBe('PO-A1-025543')
    expect(bill.description).toBe('CORRUGATED SHEETS')
    expect(bill.glAccount).toBe('RAW MATERIALS')
    expect(bill.termsCode).toBe('30D')
    expect(bill.createdByName).toBe('JASMINE RABANG')
    expect(bill.dueDate?.toISOString().slice(0, 10)).toBe('2026-09-03')
    // To the centavo. A float round-trip is how the .42 goes missing.
    expect(bill.amount.toFixed(2)).toBe('197715.42')
  })

  it('is idempotent on (checkId, apvNumber)', async () => {
    const check = await makeCheck({ checkNumber: '6000338925' })
    await run([billRow(2)])
    const second = await run([billRow(2, { detailTotal: 197715.43 })])

    expect(second).toMatchObject({ bills: 1, created: 0, updated: 1 })
    const bills = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bills).toHaveLength(1)
    expect(bills[0].amount.toFixed(2)).toBe('197715.43')
  })

  it('lets one cheque carry several bills', async () => {
    // One bill per cheque is a property of the 4 September snapshot, not of the
    // domain: the register carries cheques settling several bills, and
    // `CheckBill` is correctly one-to-many. Nothing here may harden the
    // snapshot's one-to-one shape into a constraint.
    const check = await makeCheck({ checkNumber: '6000338925' })
    await run([
      billRow(2, { referenceNbr: 'AP-ST036371' }),
      billRow(3, { referenceNbr: 'AP-ST036372' }),
    ])

    const bills = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bills.map((b) => b.apvNumber).sort()).toEqual(['AP-ST036371', 'AP-ST036372'])
  })

  it('sends a bill whose cheque is not imported to review, not the bin', async () => {
    // Not an error: the cheque may be staged for want of a company, or simply
    // absent from the register. This file is a snapshot and says nothing about
    // a cheque's absence.
    const summary = await run([billRow(2, { checkNo: 6000999999 })])

    expect(summary).toMatchObject({ bills: 1, created: 0, updated: 0 })
    expect(summary.unmatched).toEqual([
      expect.objectContaining({ reason: 'NO_MATCHING_CHECK', checkNumber: '6000999999', row: 2 }),
    ])
    expect(await testDb.checkBill.count()).toBe(0)
  })

  it('sends a cheque number claimed by two companies to review', async () => {
    await makeCheck({ checkNumber: '6000338925' })
    await makeCheck({ checkNumber: '6000338925' })
    const summary = await run([billRow(2)])

    expect(summary.unmatched[0]).toMatchObject({ reason: 'AMBIGUOUS_CHECK', checkNumber: '6000338925' })
    expect(await testDb.checkBill.count()).toBe(0)
  })

  it('never changes a cheque\'s release status', async () => {
    // FINANCE REMARKS is AVAILABLE on all 85 rows. It corroborates
    // READY_FOR_RELEASE; it does not instruct. Import never changes release
    // status (D4) and a bill import is an import.
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await run([billRow(2, { checkNo: Number(check.checkNumber) })])

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(after.readyAt).toBeNull()
    expect(after.readyById).toBeNull()
    expect(after.availablePickupDate).toBeNull()
    expect(after.amount?.toFixed(2)).toBe(check.amount?.toFixed(2))
  })

  it('records the import in the cheque\'s audit trail as SYSTEM', async () => {
    const check = await makeCheck({ checkNumber: '6000338925' })
    await run([billRow(2)])

    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', action: 'bill_imported', userId: null })
  })
})

describe('importBills — a check No. cell that is not a cheque number', () => {
  beforeEach(resetDb)

  afterEach(async () => {
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  const NOW = new Date('2026-09-07T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review } = parseBillRows(rows)
    return importBills(testDb, { bills, review, now: NOW })
  }

  // The measured case, and the reason for the whole change: row 81 of the
  // 4 September LIST sheet holds the date 2026-08-13 where the cheque number
  // belongs. The cheque is fine — 6000353106, SIGNED, dated 2026-08-13, which
  // is the very date somebody typed into the wrong column — and it carries the
  // voucher AP-ST042652 in the register.
  const misKeyed = (row: number) => billRow(row, {
    checkNo: new Date('2026-08-13T00:00:00Z'),
    referenceNbr: 'AP-ST042652',
  })

  it('attaches the bill to the one cheque carrying its voucher', async () => {
    const check = await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    const summary = await run([misKeyed(81)])

    expect(summary).toMatchObject({ bills: 1, created: 1, resolvedByVoucher: 1 })
    expect(summary.unmatched).toHaveLength(0)
    const [bill] = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bill.apvNumber).toBe('AP-ST042652')
  })

  it('says in the audit trail that it matched on the voucher, and on what basis', async () => {
    // Attaching a bill to a cheque on evidence other than the number printed
    // beside it is a decision somebody may have to defend to Finance. It never
    // happens silently.
    const check = await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    await run([misKeyed(81)])

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    expect(audit.details).toMatchObject({ matchedOn: 'APV', statedCheckRef: '2026-08-13' })
    expect(audit.remarks).toContain('AP-ST042652')
    expect(audit.remarks).toContain(BILL_CHECK_REF_RULING)
  })

  it('stages the row rather than guessing when the voucher names no cheque', async () => {
    await makeCheck({ checkNumber: '6000353106', apvNumbers: [] })
    const summary = await run([misKeyed(81)])

    expect(await testDb.checkBill.count()).toBe(0)
    expect(summary.unmatched).toEqual([
      expect.objectContaining({ reason: 'NO_CHECK_NUMBER', row: 81, statedCheckRef: '2026-08-13' }),
    ])
  })

  it('stages the row rather than choosing when the voucher names two cheques', async () => {
    // Two cheques carrying one voucher is a state the register can produce, and
    // a bill hung on the wrong one is a supplier told the wrong thing. A wrong
    // cheque is far worse than a staged row.
    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    await makeCheck({ checkNumber: '6000353107', apvNumbers: ['AP-ST042652'] })
    const summary = await run([misKeyed(81)])

    expect(await testDb.checkBill.count()).toBe(0)
    expect(summary.unmatched[0]).toMatchObject({ reason: 'AMBIGUOUS_CHECK', row: 81 })
    expect(summary.unmatched[0].companies).toHaveLength(2)
  })

  it('does not re-resolve a good cheque number that names no cheque', async () => {
    // The fallback is for a cell that holds no cheque number, and only that. A
    // perfectly good number naming no cheque here is not an invitation to
    // overrule the workbook on evidence it did not offer — the cheque is simply
    // not in this system yet.
    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-A1033419'] })
    const summary = await run([billRow(2, { checkNo: 6000999999 })])

    expect(await testDb.checkBill.count()).toBe(0)
    expect(summary.unmatched[0]).toMatchObject({
      reason: 'NO_MATCHING_CHECK', checkNumber: '6000999999',
    })
  })
})

describe('stageBills — the rows that did not attach', () => {
  beforeEach(resetDb)

  const NOW = new Date('2026-09-07T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review } = parseBillRows(rows)
    return importBills(testDb, { bills, review, now: NOW })
  }

  it('writes every refused row where somebody sees it', async () => {
    // The defect this whole change exists for. The importer already REPORTED
    // the mis-keyed cell — to a terminal, once, during a run nobody was
    // watching — and the next person to notice was going to be the supplier.
    const summary = await run([
      billRow(2, { checkNo: new Date('2026-08-13T00:00:00Z'), referenceNbr: 'AP-ST042652' }),
      billRow(3, { referenceNbr: null }),
      billRow(4, { detailTotal: null }),
    ])
    expect(summary.staged).toBe(3)

    const staged = await testDb.stagedBill.findMany({ orderBy: { sourceRow: 'asc' } })
    expect(staged.map((s) => [s.sourceRow, s.reason])).toEqual([
      [2, 'NO_CHECK_NUMBER'], [3, 'NO_APV'], [4, 'NO_AMOUNT'],
    ])
    expect(staged[0]).toMatchObject({
      sourceSheet: 'LIST', statedCheckRef: '2026-08-13', apvNumber: 'AP-ST042652',
    })
  })

  it('is idempotent on the cell it points at', async () => {
    await run([billRow(2, { referenceNbr: null })])
    await run([billRow(2, { referenceNbr: null })])
    expect(await testDb.stagedBill.count()).toBe(1)
  })

  it('takes a row away once it attaches to a cheque', async () => {
    // Otherwise the queue only ever grows and a corrected cell never stops
    // being reported, which is how a queue stops being read.
    await run([misKeyedForClearing()])
    expect(await testDb.stagedBill.count()).toBe(1)

    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    const second = await run([misKeyedForClearing()])

    expect(second.cleared).toBe(1)
    expect(await testDb.stagedBill.count()).toBe(0)
    expect(await testDb.checkBill.count()).toBe(1)
  })

  function misKeyedForClearing() {
    return billRow(81, {
      checkNo: new Date('2026-08-13T00:00:00Z'), referenceNbr: 'AP-ST042652',
    })
  }

  it('holds no amount and no vendor name', async () => {
    // Deliberate. This table is displayed beside one whose amounts are CHEQUE
    // amounts, and a bill's Detail Total sitting in that column would be read
    // as a cheque's figure sooner or later. The sheet, the row, the voucher and
    // what the cell actually said are what a human needs to fix a mis-keyed
    // cell; the rest is in the workbook.
    await run([billRow(2, { referenceNbr: null })])
    const [staged] = await testDb.stagedBill.findMany()
    expect(Object.keys(staged)).not.toContain('amount')
    expect(Object.keys(staged)).not.toContain('payeeName')
  })
})
