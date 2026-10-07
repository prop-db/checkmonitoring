import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { upsertCheck } from '@/lib/import/upsert'
import type { NormalisedRow } from '@/lib/normalised-row'

/**
 * When Acumatica corrects a cheque number.
 *
 * MEASURED, 2026-09-10. The 04:39 sync reported one failed row:
 *
 *     Invalid `prisma.check.create()` invocation:
 *     Unique constraint failed on the fields: (`acumaticaPaymentId`)
 *
 * The payment was `CV-A1013045`. We held it as cheque `17913405552` — eleven
 * digits, where every other cheque in that book has ten — and the feed now said
 * `1791405552`. Somebody had removed a mis-keyed `3` in the ERP.
 *
 * `upsertCheck` identifies a row by `(companyId, checkNumber)` and then, on a
 * miss, by cheque number alone. A corrected number misses BOTH, so the row fell
 * through to `create`, and the create collided with the unique index on
 * `acumaticaPaymentId` — because the payment was already here under its old
 * number. One error per sync, every sync, for ever: the number never converges
 * on its own, and each run rediscovers the same collision.
 *
 * The payment document reference is the durable identity. A cheque number is a
 * fact about the cheque that a human keys and can therefore re-key; a
 * `ReferenceNbr` is the ERP's own primary key for the document and does not
 * change. So on a miss, look the payment up by it.
 *
 * ORDER MATTERS, and the exact match deliberately stays first. If
 * `(company, number)` HITS while a different row holds the same
 * `acumaticaPaymentId`, that is two rows for one cheque — the condition that
 * stored 1,865 physical cheques twice — and it wants a human, not whichever
 * lookup happened to run first. Putting the payment id ahead of the exact match
 * would silently pick one of the two and write to it.
 */

const NOW = new Date('2026-09-10T12:39:00+08:00')

beforeEach(resetDb)

async function seedCompany() {
  const company = await testDb.company.create({
    data: { code: 'A1+', name: 'A1+ Multinational Packaging Inc.', legalNames: ['A1+ MULTINATIONAL PACKAGING INC.'] },
  })
  const bank = await testDb.bank.create({ data: { code: 'BPI-A1', name: 'BPI' } })
  await testDb.cashAccount.create({ data: { code: 'BPI A1', bankId: bank.id, companyId: company.id } })
  return company
}

function row(overrides: Partial<NormalisedRow> = {}): NormalisedRow {
  return {
    source: 'ACUMATICA',
    acumaticaPaymentId: 'CV-A1013045',
    checkNumber: '1791405552',
    statedCheckRef: '1791405552',
    cvNumber: 'CV-A1013045',
    checkDate: new Date('2026-09-01T00:00:00Z'),
    amount: '12500.00',
    currency: 'PHP',
    payeeName: 'A SUPPLIER',
    vendorCode: null,
    companyCode: 'A1+',
    cashAccountCode: 'BPI A1',
    checkBookCode: null,
    category: null,
    apvNumbers: [],
    poNumbers: [],
    receiptRef: null,
    isCheque: true,
    voided: false,
    acumaticaDocType: 'Payment',
    acumaticaStatus: 'Balanced',
    acumaticaBranch: 'A1+',
    acumaticaTenant: 'GOLIVE',
    lastModifiedOn: new Date('2026-09-10T04:00:00Z'),
    sourceSheet: null,
    sourceRow: null,
    ...overrides,
  }
}

const upsert = (r: NormalisedRow) =>
  upsertCheck(testDb, { row: r, ownCompanyNames: ['A1+ MULTINATIONAL PACKAGING INC.'], now: NOW })

describe('a check number corrected in Acumatica', () => {
  it('updates the payment we already hold instead of trying to create a second one', async () => {
    await seedCompany()

    // The row as it first arrived, with the mis-keyed number.
    await upsert(row({ checkNumber: '17913405552', statedCheckRef: '17913405552' }))
    expect(await testDb.check.count()).toBe(1)

    // The same payment, renumbered in the ERP. This threw
    // "Unique constraint failed on the fields: (acumaticaPaymentId)" before the fix.
    await upsert(row())

    const all = await testDb.check.findMany()
    expect(all).toHaveLength(1)
    expect(all[0]?.checkNumber).toBe('1791405552')
    expect(all[0]?.acumaticaPaymentId).toBe('CV-A1013045')
  })

  it('records the renumbering in the audit trail rather than changing it silently', async () => {
    await seedCompany()
    await upsert(row({ checkNumber: '17913405552', statedCheckRef: '17913405552' }))
    await upsert(row())

    const audits = await testDb.auditLog.findMany()
    const renumber = audits.find((a) => a.action === 'renumbered_by_acumatica')
    expect(renumber, 'a check number changing is worth an audit row').toBeDefined()
    expect(JSON.stringify(renumber?.details)).toContain('17913405552')
    expect(JSON.stringify(renumber?.details)).toContain('1791405552')
  })

  it('leaves a check the ERP has never seen to the ordinary lookup', async () => {
    await seedCompany()
    // No payment id at all: a register row. Two different numbers are two cheques.
    await upsert(row({ source: 'WORKBOOK', acumaticaPaymentId: null, checkNumber: '1791405552', statedCheckRef: '1791405552', sourceSheet: 'BPI A1', sourceRow: 4 }))
    await upsert(row({ source: 'WORKBOOK', acumaticaPaymentId: null, checkNumber: '1791405553', statedCheckRef: '1791405553', sourceSheet: 'BPI A1', sourceRow: 5 }))
    expect(await testDb.check.count()).toBe(2)
  })
})
