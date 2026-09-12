import { describe, it, expect } from 'vitest'
import { summariseByAccount, daysBetween, NO_ACCOUNT, type OutstandingRow } from '@/lib/recon/summary'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
function row(o: Partial<OutstandingRow> & { id: string }): OutstandingRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', accountId: 'acc-bpi', account: 'BPI STK', bank: 'BPI',
    company: 'STK', currency: 'PHP', amount: '100.00', checkDate: d('2026-08-20'), releasedAt: null,
    clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED', ...o,
  }
}

describe('daysBetween', () => {
  it('counts whole days, negative when the first day is later', () => {
    expect(daysBetween('2026-08-20', '2026-09-12')).toBe(23)
    expect(daysBetween('2026-09-12', '2026-09-12')).toBe(0)
    expect(daysBetween('2026-09-13', '2026-09-12')).toBe(-1)
  })
})

describe('summariseByAccount', () => {
  it('keeps only the rows outstanding as of the day, and adds in centavos per currency', () => {
    const s = summariseByAccount([
      row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' }),
      row({ id: 'c', amount: '5.00', currency: 'USD' }),
      row({ id: 'd', clearingStatus: 'CLEARED', clearedDate: d('2026-09-01') }),
      row({ id: 'e', status: 'SIGNED' }),
    ], '2026-09-12')
    expect(s.lines.map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(s.accounts).toHaveLength(1)
    expect(s.accounts[0]).toMatchObject({ accountId: 'acc-bpi', account: 'BPI STK', bank: 'BPI', company: 'STK', count: 3 })
    expect(s.accounts[0].totals).toEqual([
      { currency: 'PHP', count: 2, total: '0.30' }, { currency: 'USD', count: 1, total: '5.00' },
    ])
    expect(s.totals).toEqual([{ currency: 'PHP', count: 2, total: '0.30' }, { currency: 'USD', count: 1, total: '5.00' }])
  })

  it('orders accounts by bank then code, with no-account rows last under (NO ACCOUNT)', () => {
    const s = summariseByAccount([
      row({ id: 'a', accountId: 'acc-mbtc', account: 'MBTC STK', bank: 'MBTC' }),
      row({ id: 'b', accountId: 'acc-bpi2', account: 'BPI A1', bank: 'BPI', company: 'A1+' }),
      row({ id: 'c', accountId: null, account: null, bank: 'BDO' }),
      row({ id: 'd' }),
    ], '2026-09-12')
    expect(s.accounts.map((a) => a.account)).toEqual(['BPI A1', 'BPI STK', 'MBTC STK', NO_ACCOUNT])
    expect(s.accounts[3]).toMatchObject({ accountId: null, bank: 'BDO', count: 1 })
  })

  it('blanks BANK and COMPANY on a group whose cheques disagree, and counts the post-dated separately', () => {
    const s = summariseByAccount([
      row({ id: 'a', accountId: null, account: null, bank: 'BDO' }),
      row({ id: 'b', accountId: null, account: null, bank: 'BPI', company: 'A1+' }),
      row({ id: 'c', checkDate: d('2026-09-20') }),
      row({ id: 'd', checkDate: d('2026-09-20'), clearingStatus: 'CLEARED', clearedDate: d('2026-09-21') }),
      row({ id: 'e', checkDate: d('2026-09-20'), clearingStatus: 'CLEARED' }),
    ], '2026-09-12')
    const none = s.accounts.find((x) => x.accountId === null)!
    expect(none).toMatchObject({ account: NO_ACCOUNT, bank: null, company: null, count: 2 })
    expect(s.notYetIssued).toBe(2)
    expect(s.lines.map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('carries the issue day, its basis and the days outstanding on each line', () => {
    const s = summariseByAccount([
      row({ id: 'a' }),
      row({ id: 'b', releasedAt: new Date('2026-09-10T15:30:00Z') }),
      row({ id: 'c', checkDate: null }),
    ], '2026-09-12')
    expect(s.lines.find((l) => l.id === 'a')).toMatchObject({ issuedDay: '2026-08-20', basis: 'CHEQUE DATE', days: 23 })
    expect(s.lines.find((l) => l.id === 'b')).toMatchObject({ issuedDay: '2026-09-10', basis: 'RELEASED AT', days: 2 })
    expect(s.lines.find((l) => l.id === 'c')).toMatchObject({ issuedDay: null, basis: null, days: null })
  })

  it('is empty, not broken, with nothing outstanding', () => {
    const s = summariseByAccount([], '2026-09-12')
    expect(s).toEqual({ accounts: [], totals: [], lines: [], notYetIssued: 0 })
  })
})
