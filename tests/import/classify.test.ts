import { describe, it, expect } from 'vitest'
import { classifyImportOutcome } from '@/lib/import/classify'

// The staging decision, pulled out of `upsertCheck` so the import preview and
// the import itself cannot reach different verdicts about the same row. These
// tests are the contract both of them read.
const row = (o: { checkNumber?: string | null; companyCode?: string | null } = {}) => ({
  checkNumber: o.checkNumber === undefined ? '6000329924' : o.checkNumber,
  companyCode: o.companyCode === undefined ? 'STK' : o.companyCode,
})

describe('classifyImportOutcome', () => {
  it('writes a row that has a cheque number and exactly one company', () => {
    expect(classifyImportOutcome(row(), ['STK'])).toEqual({
      write: true, checkNumber: '6000329924', companyCode: 'STK',
    })
  })

  it('defaults the company list to the row own company', () => {
    // What the Acumatica sync passes: one row, in isolation, with no register
    // to compare it against.
    expect(classifyImportOutcome(row())).toEqual({
      write: true, checkNumber: '6000329924', companyCode: 'STK',
    })
  })

  it('stages a row with no cheque number, which cannot be keyed at all', () => {
    expect(classifyImportOutcome(row({ checkNumber: null }))).toEqual({
      write: false, reason: 'NO_CHECK_NUMBER', conflictingCompanies: [],
    })
  })

  it('reports NO_CHECK_NUMBER even when the number is also contested', () => {
    // Order matters and is the one in `upsertCheck`: a row with no number is
    // not in any cheque-number group, so it cannot be part of an ambiguity.
    expect(classifyImportOutcome(row({ checkNumber: null }), ['STK', 'A1+'])).toMatchObject({
      write: false, reason: 'NO_CHECK_NUMBER',
    })
  })

  it('stages every row of a contested cheque number as AMBIGUOUS_COMPANY', () => {
    expect(classifyImportOutcome(row(), ['STK', 'A1+'])).toEqual({
      write: false, reason: 'AMBIGUOUS_COMPANY', conflictingCompanies: ['STK', 'A1+'],
    })
  })

  it('puts a row of a contested number that resolves nothing itself under the ambiguity', () => {
    // One of the real register's 61 AMBIGUOUS_COMPANY rows resolves no company
    // of its own. Filing it under NO_COMPANY would split one cheque's evidence
    // across two buckets, which is what the 2026-09-03 ruling forbids.
    expect(classifyImportOutcome(row({ companyCode: null }), ['STK', 'A1+'])).toMatchObject({
      write: false, reason: 'AMBIGUOUS_COMPANY',
    })
  })

  it('stages a row nothing says the company of', () => {
    expect(classifyImportOutcome(row({ companyCode: null }), [])).toEqual({
      write: false, reason: 'NO_COMPANY', conflictingCompanies: [],
    })
  })

  it('dedupes the company list before deciding it is ambiguous', () => {
    // 897 register rows resolve the same company from both signals. Two
    // agreeing claims are not a conflict.
    expect(classifyImportOutcome(row(), ['STK', 'STK'])).toMatchObject({ write: true })
  })
})
