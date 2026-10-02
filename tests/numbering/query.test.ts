// tests/numbering/query.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listNumberingAccounts, countChequesWithoutAccount } from '@/lib/numbering/query'

beforeEach(resetDb)

async function onAccountOf(first: { cashAccountId: string | null }, overrides: Parameters<typeof makeCheck>[0]) {
  const c = await makeCheck(overrides)
  return testDb.check.update({ where: { id: c.id }, data: { cashAccountId: first.cashAccountId } })
}

describe('listNumberingAccounts', () => {
  it('includes every status and cheques with no amount; excludes non-cheques', async () => {
    const first = await makeCheck({ checkNumber: '100', status: 'RELEASED' })
    await onAccountOf(first, { checkNumber: '101', status: 'VOIDED', amount: null })
    await onAccountOf(first, { checkNumber: '102', status: 'CANCELLED' })
    await onAccountOf(first, { checkNumber: '104', status: 'SIGNED', isCheque: false })
    const [acc, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(acc.accountId).toBe(first.cashAccountId)
    expect(acc.series.summary).toMatchObject({ first: '100', last: '102', held: 3, voided: 1, cancelled: 1, missingRuns: 0 })
    const voided = acc.series.entries.find((e) => e.kind === 'CHEQUE' && e.cheque.checkNumber === '101')
    expect(voided?.kind === 'CHEQUE' && voided.cheque.amount).toBeNull()
  })

  it('one entry per cash account, sorted by account code, amounts as strings', async () => {
    const a = await makeCheck({ checkNumber: '1', amount: '197715.42' })
    const b = await makeCheck({ checkNumber: '2' })
    await testDb.cashAccount.update({ where: { id: a.cashAccountId! }, data: { code: 'ZZZ' } })
    await testDb.cashAccount.update({ where: { id: b.cashAccountId! }, data: { code: 'AAA' } })
    const out = await listNumberingAccounts(testDb, {})
    expect(out.map((x) => x.account)).toEqual(['AAA', 'ZZZ'])
    const e = out[1].series.entries[0]
    expect(e.kind === 'CHEQUE' && e.cheque.amount).toBe('197715.42')
  })

  it('returns amounts as two-decimal strings', async () => {
    const first = await makeCheck({ checkNumber: '1', amount: '1000.50' })
    await onAccountOf(first, { checkNumber: '2', amount: '500' })
    const [acc] = await listNumberingAccounts(testDb, {})
    const amountOf = (n: string) => {
      const e = acc.series.entries.find((x) => x.kind === 'CHEQUE' && x.cheque.checkNumber === n)
      return e?.kind === 'CHEQUE' ? e.cheque.amount : undefined
    }
    expect(amountOf('1')).toBe('1000.50')
    expect(amountOf('2')).toBe('500.00')
  })

  it('returns nothing when the account belongs to a different company than companyId', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const accB = await testDb.cashAccount.findUniqueOrThrow({ where: { id: b.cashAccountId! } })
    expect(await listNumberingAccounts(testDb, { companyId: accB.companyId, cashAccountId: a.cashAccountId! })).toEqual([])
  })

  it('narrows by the account\'s company, and by one account', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! } })
    expect((await listNumberingAccounts(testDb, { companyId: accA.companyId })).map((x) => x.accountId)).toEqual([a.cashAccountId])
    expect((await listNumberingAccounts(testDb, { cashAccountId: b.cashAccountId! })).map((x) => x.accountId)).toEqual([b.cashAccountId])
  })
})

async function stage(cashAccountCode: string | null, statedCheckRef: string, extra: Record<string, unknown> = {}) {
  const workbook = extra.source === 'WORKBOOK'
  return testDb.stagedCheck.create({
    data: {
      source: workbook ? 'WORKBOOK' : 'ACUMATICA',
      ...(workbook
        ? { sourceSheet: 'BPI RELEASED', sourceRow: Math.floor(Math.random() * 1e6) }
        : { acumaticaRef: `CV-T${Math.random().toString(36).slice(2, 9)}`, acumaticaTenant: 'GOLIVE' }),
      reason: 'NO_CHECK_NUMBER', impliedStatus: 'SIGNATURE_PENDING',
      statedCheckRef, cashAccountCode, amount: '500.00', currency: 'PHP', payeeName: 'HENKEL',
      apvNumbers: [], poNumbers: [], conflictingCompanies: [],
      ...(extra.promotedCheckId ? { promotedCheckId: extra.promotedCheckId as string } : {}),
    },
  })
}

describe('listNumberingAccounts — staged dotted re-uses', () => {
  it('joins a dotted staged payment to its cash account as a STAGED line', async () => {
    const first = await makeCheck({ checkNumber: '1000' })
    await onAccountOf(first, { checkNumber: '1003' })
    const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: first.cashAccountId! } })
    await stage(acc.code, '1001.')
    const [a] = await listNumberingAccounts(testDb, {})
    const kinds = a.series.entries.map((e) => (e.kind === 'MISSING' ? `M${e.from}` : e.kind === 'STAGED' ? `S${e.number}` : e.cheque.checkNumber))
    expect(kinds).toEqual(['1000', 'S1001', 'M1002', '1003'])
    expect(a.series.summary.staged).toBe(1)
    const s = a.series.entries.find((e) => e.kind === 'STAGED')
    expect(s?.kind === 'STAGED' && s.staged.amount).toBe('500.00')
  })

  it('ignores a promoted row, a row without a dot, a WORKBOOK row and an unknown cash account', async () => {
    const first = await makeCheck({ checkNumber: '2000' })
    await onAccountOf(first, { checkNumber: '2005' })
    const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: first.cashAccountId! } })
    await stage(acc.code, '2001.', { promotedCheckId: first.id })
    await stage(acc.code, '2002')
    await stage(acc.code, '2003.', { source: 'WORKBOOK' })
    await stage('NO SUCH ACCOUNT', '2004.')
    const [a] = await listNumberingAccounts(testDb, {})
    expect(a.series.summary.staged).toBe(0)
    expect(a.series.summary.missingNumbers).toBe('4')
  })

  it('an account with only staged numbers still appears', async () => {
    const other = await makeCheck({ checkNumber: '1' })
    const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
    const empty = await testDb.cashAccount.create({ data: { code: 'EMPTY ACC', bankId: bank.id, companyId: other.companyId } })
    await stage('EMPTY ACC', '30.')
    const out = await listNumberingAccounts(testDb, {})
    const e = out.find((x) => x.accountId === empty.id)
    expect(e?.series.summary).toMatchObject({ first: '30', last: '30', held: 0, staged: 1 })
  })

  it('honours the company and account filters for staged rows', async () => {
    const a = await makeCheck({ checkNumber: '10' })
    const b = await makeCheck({ checkNumber: '20' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! } })
    await stage(accA.code, '11.')
    const onlyB = await listNumberingAccounts(testDb, { companyId: b.companyId })
    expect(onlyB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
    const onlyAccB = await listNumberingAccounts(testDb, { cashAccountId: b.cashAccountId! })
    expect(onlyAccB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
  })
})

describe('countChequesWithoutAccount', () => {
  it('counts cheques with no cash account, narrowed by the cheque\'s company', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    await testDb.check.update({ where: { id: a.id }, data: { cashAccountId: null } })
    await makeCheck({ checkNumber: '2' })
    expect(await countChequesWithoutAccount(testDb, {})).toBe(1)
    expect(await countChequesWithoutAccount(testDb, { companyId: a.companyId })).toBe(1)
    const other = await makeCheck({ checkNumber: '3' })
    expect(await countChequesWithoutAccount(testDb, { companyId: other.companyId })).toBe(0)
  })
})
