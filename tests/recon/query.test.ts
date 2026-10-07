import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listOutstandingCandidates, countExcludedIncomplete } from '@/lib/recon/query'

beforeEach(resetDb)

describe('listOutstandingCandidates — the population', () => {
  it('holds RELEASED real checks with an amount, whatever their clearing, and nothing else', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: '1' })
    const cleared = await makeCheck({ status: 'RELEASED', checkNumber: '2' })
    await testDb.check.update({ where: { id: cleared.id }, data: { clearingStatus: 'CLEARED', clearedDate: new Date('2026-09-01') } })
    await makeCheck({ status: 'SIGNED', checkNumber: '3' })
    await makeCheck({ status: 'VOIDED', checkNumber: '4' })
    await makeCheck({ status: 'RELEASED', checkNumber: '5', amount: null })
    await makeCheck({ status: 'RELEASED', checkNumber: '6', isCheque: false })
    const rows = await listOutstandingCandidates(testDb)
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['1', '2'])
    const two = rows.find((r) => r.checkNumber === '2')!
    expect(two.clearingStatus).toBe('CLEARED')
    expect(two.clearedDate).toEqual(new Date('2026-09-01'))
  })

  it('carries the account, bank, company and a decimal-string amount', async () => {
    const c = await makeCheck({ status: 'RELEASED', amount: '1234.50' })
    const account = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! }, include: { bank: true, company: true } })
    const [row] = await listOutstandingCandidates(testDb)
    expect(row).toMatchObject({
      id: c.id, accountId: account.id, account: account.code, bank: account.bank.code,
      company: account.company.code, currency: 'PHP', amount: '1234.50', status: 'RELEASED',
    })
    expect(typeof row.amount).toBe('string')
  })

  it('narrows by bank, company and account', async () => {
    const a = await makeCheck({ status: 'RELEASED', checkNumber: '1' })
    const b = await makeCheck({ status: 'RELEASED', checkNumber: '2' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! }, include: { bank: true } })
    expect((await listOutstandingCandidates(testDb, { bankCode: accA.bank.code })).map((r) => r.checkNumber)).toEqual(['1'])
    expect((await listOutstandingCandidates(testDb, { companyId: b.companyId })).map((r) => r.checkNumber)).toEqual(['2'])
    expect((await listOutstandingCandidates(testDb, { cashAccountId: accA.id })).map((r) => r.checkNumber)).toEqual(['1'])
  })

  it('keeps a released check with no cash account, with the bank from its checkbook if any', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '9' })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null } })
    const [row] = await listOutstandingCandidates(testDb)
    expect(row).toMatchObject({ checkNumber: '9', accountId: null, account: null, bank: null })
  })

  it('takes the bank from the checkbook when there is no cash account, and the bank filter finds it there', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '9' })
    const bank = await testDb.bank.create({ data: { code: 'MBTC-X', name: 'Metrobank' } })
    const book = await testDb.checkBook.create({ data: { code: 'MBTC-S-0001', bankId: bank.id, companyId: c.companyId } })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null, checkBookId: book.id } })
    await makeCheck({ status: 'RELEASED', checkNumber: '1' })
    const rows = await listOutstandingCandidates(testDb)
    expect(rows.find((r) => r.checkNumber === '9')).toMatchObject({ accountId: book.id, account: 'MBTC-S-0001', bank: 'MBTC-X' })
    expect((await listOutstandingCandidates(testDb, { bankCode: 'MBTC-X' })).map((r) => r.checkNumber)).toEqual(['9'])
  })

  it('the check book wins over a register cash-account label: account, bank and both filters (2026-10-06)', async () => {
    // Follow Acumatica: its CashAccount is the cheque book. The register label
    // decides only for a cheque with no book.
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '9' })
    const label = c.cashAccountId!
    const bank = await testDb.bank.create({ data: { code: 'MBTC-X', name: 'Metrobank' } })
    const book = await testDb.checkBook.create({ data: { code: 'MBTC-S-0002', bankId: bank.id, companyId: c.companyId } })
    await testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
    const [row] = await listOutstandingCandidates(testDb)
    expect(row).toMatchObject({ accountId: book.id, account: 'MBTC-S-0002', bank: 'MBTC-X' })
    expect(await listOutstandingCandidates(testDb, { bankCode: 'MBTC-X' })).toHaveLength(1)
    expect(await listOutstandingCandidates(testDb, { cashAccountId: book.id })).toHaveLength(1)
    expect(await listOutstandingCandidates(testDb, { cashAccountId: label })).toHaveLength(0)
  })
})

describe('countExcludedIncomplete', () => {
  it('counts released checks with no amount under the same filters', async () => {
    await makeCheck({ status: 'RELEASED', amount: null })
    await makeCheck({ status: 'SIGNED', amount: null })
    await makeCheck({ status: 'RELEASED' })
    expect(await countExcludedIncomplete(testDb)).toBe(1)
  })
})
