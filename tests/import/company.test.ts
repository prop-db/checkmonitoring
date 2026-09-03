import { describe, it, expect } from 'vitest'
import { resolveCompany, type CompanyReferenceData } from '@/lib/import/company'
import { CASH_ACCOUNTS, CHECK_BOOKS } from '@/prisma/reference-data'

// A deliberately tiny table. These tests pin the resolution rules, not the
// contents of the seed data, so the reference table is injected rather than
// imported by the module under test. The real table is exercised once, at the
// bottom, to prove the two wire together.
const REF: CompanyReferenceData = {
  cashAccounts: [
    { code: 'BPI STK', company: 'STK' },
    { code: 'MBTC P&P', company: 'A1PP' },
  ],
  checkBooks: [
    { code: 'BPI-S-4636', company: 'STK' },
    { code: 'MBT-A-4155', company: 'A1+' },
  ],
}

describe('resolveCompany', () => {
  it('resolves from the checkbook alone', () => {
    // 8,245 of the register's 12,227 rows - the largest single case.
    expect(resolveCompany({ checkBook: 'BPI-S-4636', cashAccountLabel: null }, REF))
      .toEqual({ ok: true, companyCode: 'STK', from: 'CHECK_BOOK', conflictedWith: null })
  })

  it('resolves from the cash account alone', () => {
    // 362 rows.
    expect(resolveCompany({ checkBook: null, cashAccountLabel: 'MBTC P&P' }, REF))
      .toEqual({ ok: true, companyCode: 'A1PP', from: 'CASH_ACCOUNT', conflictedWith: null })
  })

  it('resolves when both signals agree, and reports no conflict', () => {
    // 897 rows.
    expect(resolveCompany({ checkBook: 'BPI-S-4636', cashAccountLabel: 'BPI STK' }, REF))
      .toEqual({ ok: true, companyCode: 'STK', from: 'CASH_ACCOUNT', conflictedWith: null })
  })

  it('lets the cash account win a conflict, and names the loser', () => {
    // 17 real rows, including two Metrobank book codes recorded on a BPI sheet.
    // The cash account names the bank account the money actually leaves and
    // agrees with the sheet in all 17; the checkbook cell is the implausible
    // one. Finance ruling, 2026-09-03.
    expect(resolveCompany({ checkBook: 'MBT-A-4155', cashAccountLabel: 'BPI STK' }, REF))
      .toEqual({ ok: true, companyCode: 'STK', from: 'CASH_ACCOUNT', conflictedWith: 'A1+' })
  })

  it('does not silently drop the conflict when the cash account wins', () => {
    // `conflictedWith` is the whole point: every one of the 17 is listed on the
    // reconciliation report so Finance can correct the register. Preferring the
    // cash account without reporting would hide a data-entry error.
    const r = resolveCompany({ checkBook: 'MBT-A-4155', cashAccountLabel: 'BPI STK' }, REF)
    expect(r.ok && r.conflictedWith).toBe('A1+')
  })

  it('fails rather than guessing when neither signal is present', () => {
    // 2,640 rows, 21.7% of the register. These are staged, never guessed at:
    // company is half the `@@unique([companyId, checkNumber])` dedup key, so a
    // wrong company is a cheque that can silently duplicate later.
    expect(resolveCompany({ checkBook: null, cashAccountLabel: null }, REF)).toEqual({ ok: false })
  })

  it('treats a blank or #N/A code as absent', () => {
    expect(resolveCompany({ checkBook: '   ', cashAccountLabel: '' }, REF)).toEqual({ ok: false })
    expect(resolveCompany({ checkBook: '#N/A', cashAccountLabel: null }, REF)).toEqual({ ok: false })
  })

  it('treats a code that is not in the reference data as absent for that signal', () => {
    expect(resolveCompany({ checkBook: 'BPI-X-0000', cashAccountLabel: null }, REF))
      .toEqual({ ok: false })
    expect(resolveCompany({ checkBook: 'BPI-X-0000', cashAccountLabel: 'BPI STK' }, REF))
      .toEqual({ ok: true, companyCode: 'STK', from: 'CASH_ACCOUNT', conflictedWith: null })
    expect(resolveCompany({ checkBook: 'BPI-S-4636', cashAccountLabel: 'RCBC WHO' }, REF))
      .toEqual({ ok: true, companyCode: 'STK', from: 'CHECK_BOOK', conflictedWith: null })
  })

  it('an unmapped code is absent, never a conflict', () => {
    // An unmapped code says nothing about the company, so it cannot disagree
    // with the signal that does.
    const r = resolveCompany({ checkBook: 'MBT-Z-9999', cashAccountLabel: 'BPI STK' }, REF)
    expect(r).toEqual({ ok: true, companyCode: 'STK', from: 'CASH_ACCOUNT', conflictedWith: null })
  })

  it('tolerates the casing and spacing the register carries', () => {
    expect(resolveCompany({ checkBook: '  bpi-s-4636 ', cashAccountLabel: null }, REF))
      .toEqual({ ok: true, companyCode: 'STK', from: 'CHECK_BOOK', conflictedWith: null })
    expect(resolveCompany({ checkBook: null, cashAccountLabel: 'mbtc   p&p' }, REF))
      .toEqual({ ok: true, companyCode: 'A1PP', from: 'CASH_ACCOUNT', conflictedWith: null })
  })

  it('resolves every code in the real reference table', () => {
    // Measured against the register: all 9 checkbook codes and all 6
    // cash-account codes that appear in the workbook are mapped. If this fails,
    // a code was removed from reference-data and rows will start staging.
    const real: CompanyReferenceData = { cashAccounts: CASH_ACCOUNTS, checkBooks: CHECK_BOOKS }
    for (const b of CHECK_BOOKS) {
      expect(resolveCompany({ checkBook: b.code, cashAccountLabel: null }, real), b.code)
        .toEqual({ ok: true, companyCode: b.company, from: 'CHECK_BOOK', conflictedWith: null })
    }
    for (const a of CASH_ACCOUNTS) {
      expect(resolveCompany({ checkBook: null, cashAccountLabel: a.code }, real), a.code)
        .toEqual({ ok: true, companyCode: a.company, from: 'CASH_ACCOUNT', conflictedWith: null })
    }
  })
})
