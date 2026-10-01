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

  it('narrows by the account\'s company, and by one account', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! } })
    expect((await listNumberingAccounts(testDb, { companyId: accA.companyId })).map((x) => x.accountId)).toEqual([a.cashAccountId])
    expect((await listNumberingAccounts(testDb, { cashAccountId: b.cashAccountId! })).map((x) => x.accountId)).toEqual([b.cashAccountId])
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
