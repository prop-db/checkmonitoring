import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { listForecastRows, listPlannedRows, listBankCodes, countExcludedIncomplete } from '@/lib/forecast/query'
import { createPlannedOutflow } from '@/lib/planned-outflow/actions'

beforeEach(resetDb)

/**
 * The population rule is the whole meaning of the report: what is written and
 * not yet handed over. Each exclusion is pinned by a row that would be counted
 * if the rule slipped.
 */
describe('listForecastRows — the population', () => {
  it('holds every live status and nothing closed', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '1' })
    await makeCheck({ status: 'SIGNED', checkNumber: '2' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '3' })
    await makeCheck({ status: 'SCHEDULED', checkNumber: '4' })
    await makeCheck({ status: 'RELEASED', checkNumber: '5' })
    await makeCheck({ status: 'CANCELLED', checkNumber: '6' })
    await makeCheck({ status: 'VOIDED', checkNumber: '7' })
    const rows = await listForecastRows(testDb)
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['1', '2', '3', '4'])
  })

  it('leaves out a check with no recorded amount', async () => {
    await makeCheck({ status: 'SIGNED', amount: null })
    expect(await listForecastRows(testDb)).toHaveLength(0)
  })

  it('leaves out a payment that is not a check', async () => {
    await makeCheck({ status: 'SIGNED', isCheque: false })
    expect(await listForecastRows(testDb)).toHaveLength(0)
  })

  it('carries the amount as a decimal string and the bank from the cash account', async () => {
    const check = await makeCheck({ status: 'SIGNED', amount: '1234.50' })
    const account = await testDb.cashAccount.findUniqueOrThrow({
      where: { id: check.cashAccountId! }, include: { bank: true },
    })
    const [row] = await listForecastRows(testDb)
    expect(row.amount).toBe('1234.50')
    expect(typeof row.amount).toBe('string')
    expect(row.bank).toBe(account.bank.code)
    expect(row.stage).toBe('SIGNED')
  })

  it('orders oldest check date first, undated last', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: 'B', checkDate: new Date('2026-08-01') })
    await makeCheck({ status: 'SIGNED', checkNumber: 'C', checkDate: null })
    await makeCheck({ status: 'SIGNED', checkNumber: 'A', checkDate: new Date('2026-07-01') })
    const rows = await listForecastRows(testDb)
    expect(rows.map((r) => r.checkNumber)).toEqual(['A', 'B', 'C'])
  })
})

describe('listForecastRows — the filters', () => {
  it('narrows by stage', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '2' })
    const rows = await listForecastRows(testDb, { stage: 'READY_FOR_RELEASE' })
    expect(rows.map((r) => r.checkNumber)).toEqual(['2'])
  })

  it('narrows by company', async () => {
    const keep = await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'SIGNED', checkNumber: '2' })
    const rows = await listForecastRows(testDb, { companyId: keep.companyId })
    expect(rows.map((r) => r.checkNumber)).toEqual(['1'])
  })

  it('narrows by bank, whichever of checkbook or cash account names it', async () => {
    const keep = await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'SIGNED', checkNumber: '2' })
    const account = await testDb.cashAccount.findUniqueOrThrow({
      where: { id: keep.cashAccountId! }, include: { bank: true },
    })
    const rows = await listForecastRows(testDb, { bankCode: account.bank.code })
    expect(rows.map((r) => r.checkNumber)).toEqual(['1'])
  })

  it('prefers the checkbook bank when a check has both', async () => {
    const check = await makeCheck({ status: 'SIGNED' })
    const bank = await testDb.bank.create({ data: { code: 'MBTC-X', name: 'Metrobank' } })
    const book = await testDb.checkBook.create({
      data: { code: 'MBTC-S-0001', bankId: bank.id, companyId: check.companyId },
    })
    await testDb.check.update({ where: { id: check.id }, data: { checkBookId: book.id } })
    const [row] = await listForecastRows(testDb)
    expect(row.bank).toBe('MBTC-X')
    expect(await listForecastRows(testDb, { bankCode: 'MBTC-X' })).toHaveLength(1)
  })
})

describe('countExcludedIncomplete', () => {
  // Pinned per FIX 1: this report's own exclusion, not the database-wide
  // `Check.isIncomplete` count — struck over the same population
  // `listForecastRows` reads, with the amount clause inverted.
  it('counts a live check with no recorded amount', async () => {
    await makeCheck({ status: 'SIGNED', amount: null })
    expect(await countExcludedIncomplete(testDb)).toBe(1)
  })

  it('does not count an incomplete check outside the live statuses', async () => {
    await makeCheck({ status: 'RELEASED', amount: null })
    expect(await countExcludedIncomplete(testDb)).toBe(0)
  })

  it('does not count a complete check', async () => {
    await makeCheck({ status: 'SIGNED', amount: '100.00' })
    expect(await countExcludedIncomplete(testDb)).toBe(0)
  })

  it('narrows by the same stage filter as the population', async () => {
    await makeCheck({ status: 'SIGNED', amount: null })
    expect(await countExcludedIncomplete(testDb, { stage: 'READY_FOR_RELEASE' })).toBe(0)
  })
})

describe('listBankCodes', () => {
  it('lists every bank, sorted', async () => {
    await testDb.bank.create({ data: { code: 'MBTC', name: 'Metrobank' } })
    await testDb.bank.create({ data: { code: 'BPI', name: 'BPI' } })
    expect(await listBankCodes(testDb)).toEqual(['BPI', 'MBTC'])
  })
})

describe('listPlannedRows', () => {
  async function line(o: { bankCode?: string; companyCode?: string; status?: 'PAID' } = {}) {
    const user = await makeUser()
    const company = await testDb.company.create({ data: { code: o.companyCode ?? `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson', legalNames: [] } })
    const bank = await testDb.bank.create({ data: { code: o.bankCode ?? `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
    const l = await createPlannedOutflow(testDb, {
      input: { date: '2026-09-15', amount: '250', bankId: bank.id, companyId: company.id, description: 'SEPT PAYROLL' },
      userId: user.id, now: new Date(),
    })
    if (o.status === 'PAID') await testDb.plannedOutflow.update({ where: { id: l.id }, data: { status: 'PAID', paidAt: new Date(), paidById: user.id } })
    return { l, bank, company }
  }

  it('returns open lines in the forecast row shape, and no closed ones', async () => {
    const { l, bank, company } = await line()
    await line({ status: 'PAID' })
    const rows = await listPlannedRows(testDb)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: l.id, checkNumber: 'PLANNED', payee: 'SEPT PAYROLL', bank: bank.code, company: company.code,
      stage: 'PLANNED', kind: 'PLANNED', currency: 'PHP', amount: '250.00',
      checkDate: new Date('2026-09-15T00:00:00.000Z'), expectedOutflowDate: null,
    })
  })

  it('narrows by bank and company, and is empty under a check stage', async () => {
    const { bank, company } = await line({ bankCode: 'BPIX' })
    await line({ bankCode: 'MBTX' })
    expect((await listPlannedRows(testDb, { bankCode: 'BPIX' })).map((r) => r.bank)).toEqual([bank.code])
    expect((await listPlannedRows(testDb, { companyId: company.id }))).toHaveLength(1)
    expect(await listPlannedRows(testDb, { stage: 'SIGNED' })).toHaveLength(0)
    expect(await listPlannedRows(testDb, { stage: 'PLANNED' })).toHaveLength(2)
  })

  it('the check query is empty, and the exclusion zero, under the PLANNED stage', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'SIGNED', amount: null })
    expect(await listForecastRows(testDb, { stage: 'PLANNED' })).toHaveLength(0)
    expect(await countExcludedIncomplete(testDb, { stage: 'PLANNED' })).toBe(0)
  })

  it('carries the expected outflow date on a check', async () => {
    const c = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: c.id }, data: { expectedOutflowDate: new Date('2026-09-20T00:00:00.000Z') } })
    const [row] = await listForecastRows(testDb)
    expect(row.kind).toBe('CHECK')
    expect(row.expectedOutflowDate).toEqual(new Date('2026-09-20T00:00:00.000Z'))
  })
})
