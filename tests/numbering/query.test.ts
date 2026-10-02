// tests/numbering/query.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listNumberingAccounts, countChequesWithoutCheckBook, listCheckBookOptions } from '@/lib/numbering/query'

beforeEach(resetDb)

/** A cheque book under the cheque's own company and bank, and the cheque in it. */
async function bookFor(c: { id: string; companyId: string; cashAccountId: string | null }, code = `BPI-S-${Math.random().toString(36).slice(2, 6)}`) {
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const book = await testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
  return book
}
async function inBook(book: { id: string }, overrides: Parameters<typeof makeCheck>[0]) {
  const c = await makeCheck(overrides)
  return testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
}

describe('listNumberingAccounts', () => {
  it('includes every status and cheques with no amount; excludes non-cheques', async () => {
    const first = await makeCheck({ checkNumber: '100', status: 'RELEASED' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '101', status: 'VOIDED', amount: null })
    await inBook(book, { checkNumber: '102', status: 'CANCELLED' })
    await inBook(book, { checkNumber: '104', status: 'SIGNED', isCheque: false })
    const [acc, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(acc.accountId).toBe(book.id)
    expect(acc.account).toBe(book.code)
    expect(acc.series.summary).toMatchObject({ first: '100', last: '102', held: 3, voided: 1, cancelled: 1, missingRuns: 0 })
    const voided = acc.series.entries.find((e) => e.kind === 'CHEQUE' && e.cheque.checkNumber === '101')
    expect(voided?.kind === 'CHEQUE' && voided.cheque.amount).toBeNull()
  })

  it('one entry per cheque book, sorted by book code, amounts as strings', async () => {
    const a = await makeCheck({ checkNumber: '1', amount: '197715.42' })
    const b = await makeCheck({ checkNumber: '2' })
    await bookFor(a, 'ZZZ')
    await bookFor(b, 'AAA')
    const out = await listNumberingAccounts(testDb, {})
    expect(out.map((x) => x.account)).toEqual(['AAA', 'ZZZ'])
    const e = out[1].series.entries[0]
    expect(e.kind === 'CHEQUE' && e.cheque.amount).toBe('197715.42')
  })

  it('returns amounts as two-decimal strings', async () => {
    const first = await makeCheck({ checkNumber: '1', amount: '1000.50' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '2', amount: '500' })
    const [acc] = await listNumberingAccounts(testDb, {})
    const amountOf = (n: string) => {
      const e = acc.series.entries.find((x) => x.kind === 'CHEQUE' && x.cheque.checkNumber === n)
      return e?.kind === 'CHEQUE' ? e.cheque.amount : undefined
    }
    expect(amountOf('1')).toBe('1000.50')
    expect(amountOf('2')).toBe('500.00')
  })

  it('returns nothing when the cheque book belongs to a different company than companyId', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const bookA = await bookFor(a)
    const bookB = await bookFor(b)
    expect(await listNumberingAccounts(testDb, { companyId: bookB.companyId, checkBookId: bookA.id })).toEqual([])
  })

  it('narrows by the cheque book\'s company, and by one cheque book', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const bookA = await bookFor(a)
    const bookB = await bookFor(b)
    expect((await listNumberingAccounts(testDb, { companyId: bookA.companyId })).map((x) => x.accountId)).toEqual([bookA.id])
    expect((await listNumberingAccounts(testDb, { checkBookId: bookB.id })).map((x) => x.accountId)).toEqual([bookB.id])
  })

  it('a cheque with a cash account but no cheque book is in no series', async () => {
    const c = await makeCheck({ checkNumber: '500' })
    expect(c.cashAccountId).not.toBeNull()
    expect(c.checkBookId).toBeNull()
    expect(await listNumberingAccounts(testDb, {})).toEqual([])
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(1)
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
  it('joins a dotted staged payment to its cheque book as a STAGED line', async () => {
    const first = await makeCheck({ checkNumber: '1000' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '1003' })
    await stage(book.code, '1001.')
    const [a] = await listNumberingAccounts(testDb, {})
    const kinds = a.series.entries.map((e) => (e.kind === 'MISSING' ? `M${e.from}` : e.kind === 'STAGED' ? `S${e.number}` : e.cheque.checkNumber))
    expect(kinds).toEqual(['1000', 'S1001', 'M1002', '1003'])
    expect(a.series.summary.staged).toBe(1)
    const s = a.series.entries.find((e) => e.kind === 'STAGED')
    expect(s?.kind === 'STAGED' && s.staged.amount).toBe('500.00')
  })

  it('ignores a promoted row, a row without a dot, a WORKBOOK row, an unknown cheque book and a cash-account code', async () => {
    const first = await makeCheck({ checkNumber: '2000' })
    const book = await bookFor(first)
    await inBook(book, { checkNumber: '2006' })
    const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: first.cashAccountId! } })
    await stage(book.code, '2001.', { promotedCheckId: first.id })
    await stage(book.code, '2002')
    await stage(book.code, '2003.', { source: 'WORKBOOK' })
    await stage('NO SUCH BOOK', '2004.')
    await stage(acc.code, '2005.')
    const [a, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(a.series.summary.staged).toBe(0)
    expect(a.series.summary.missingNumbers).toBe('5')
  })

  it('a cheque book with only staged numbers still appears', async () => {
    const other = await makeCheck({ checkNumber: '1' })
    await bookFor(other)
    const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
    const empty = await testDb.checkBook.create({ data: { code: 'EMPTY-BOOK', bankId: bank.id, companyId: other.companyId } })
    await stage('EMPTY-BOOK', '30.')
    const out = await listNumberingAccounts(testDb, {})
    const e = out.find((x) => x.accountId === empty.id)
    expect(e?.series.summary).toMatchObject({ first: '30', last: '30', held: 0, staged: 1 })
  })

  it('honours the company and cheque-book filters for staged rows', async () => {
    const a = await makeCheck({ checkNumber: '10' })
    const b = await makeCheck({ checkNumber: '20' })
    const bookA = await bookFor(a)
    const bookB = await bookFor(b)
    await stage(bookA.code, '11.')
    const onlyB = await listNumberingAccounts(testDb, { companyId: b.companyId })
    expect(onlyB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
    const forA = await listNumberingAccounts(testDb, { companyId: a.companyId })
    expect(forA.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(true)
    const forBookA = await listNumberingAccounts(testDb, { checkBookId: bookA.id })
    expect(forBookA.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(true)
    const onlyBookB = await listNumberingAccounts(testDb, { checkBookId: bookB.id })
    expect(onlyBookB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
  })
})

describe('countChequesWithoutCheckBook', () => {
  it('counts cheques with no cheque book, narrowed by the cheque\'s company', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    await bookFor(b)
    expect(await countChequesWithoutCheckBook(testDb, {})).toBe(1)
    expect(await countChequesWithoutCheckBook(testDb, { companyId: a.companyId })).toBe(1)
    const other = await makeCheck({ checkNumber: '3' })
    await bookFor(other)
    expect(await countChequesWithoutCheckBook(testDb, { companyId: other.companyId })).toBe(0)
  })
})

describe('listCheckBookOptions', () => {
  it('lists every cheque book by code with its bank code', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const bookA = await bookFor(a, 'ZZZ-BOOK')
    const bookB = await bookFor(b, 'AAA-BOOK')
    const bankA = await testDb.bank.findUniqueOrThrow({ where: { id: bookA.bankId } })
    const out = await listCheckBookOptions(testDb)
    expect(out.map((o) => o.id)).toEqual([bookB.id, bookA.id])
    expect(out[1]).toEqual({ id: bookA.id, code: 'ZZZ-BOOK', bankCode: bankA.code })
  })
})
