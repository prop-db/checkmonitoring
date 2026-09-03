import { describe, it, expect } from 'vitest'
import { canonicalVendor, canonicalCheckBook, excelSerialToDate, cleanCell } from '@/lib/import/normalise'

describe('cleanCell', () => {
  it('strips the noise the register carries', () => {
    expect(cleanCell('  HENKEL PHILIPPINES INC.  ')).toBe('HENKEL PHILIPPINES INC.')
    expect(cleanCell('#N/A')).toBeNull()
    expect(cleanCell('')).toBeNull()
    expect(cleanCell('   ')).toBeNull()
    expect(cleanCell(null)).toBeNull()
    expect(cleanCell(undefined)).toBeNull()
  })

  it('collapses internal whitespace', () => {
    expect(cleanCell('BIZARRE   MARKETING')).toBe('BIZARRE MARKETING')
  })
})

describe('canonicalVendor', () => {
  it('folds the casing variants the register actually contains', () => {
    // Both spellings appear in the client's data for the same company.
    expect(canonicalVendor('STARKSON PACKAGING INC.'))
      .toBe(canonicalVendor('Starkson Packaging Inc.'))
  })

  it('folds trailing punctuation and INC spelling', () => {
    expect(canonicalVendor('A1+ MULTINATIONAL PACKAGING INC'))
      .toBe(canonicalVendor('A1+ MULTINATIONAL PACKAGING INC.'))
    expect(canonicalVendor('Kooler Industries Incorporated'))
      .toBe(canonicalVendor('Kooler Industries Inc.'))
  })

  it('preserves characters that distinguish companies', () => {
    // The + in A1+ is part of the name, not punctuation.
    expect(canonicalVendor('A1+ PAPER AND PLASTIC')).toContain('A1+')
    expect(canonicalVendor('ABC Trading')).not.toBe(canonicalVendor('ABD Trading'))
  })
})

describe('canonicalCheckBook', () => {
  it('corrects the mis-keyed checkbook code Finance confirmed', () => {
    // MBT-S-9048 appears in the register but is not a real checkbook.
    expect(canonicalCheckBook('MBT-S-9048')).toBe('MBT-A-9048')
    expect(canonicalCheckBook('  mbt-s-9048  ')).toBe('MBT-A-9048')
  })

  it('leaves genuine checkbook codes alone', () => {
    for (const c of ['BPI-S-4636', 'BPI-A-5713', 'BPI-S-8879', 'BPI-A-8879', 'MBT-A-4155', 'MBT-A-9048', 'MBT-S-1121', 'BDO-A-3838']) {
      expect(canonicalCheckBook(c), c).toBe(c)
    }
  })

  it('returns null for a blank or missing code', () => {
    expect(canonicalCheckBook(null)).toBeNull()
    expect(canonicalCheckBook('#N/A')).toBeNull()
  })
})

describe('excelSerialToDate', () => {
  // Anchor the conversion to serials whose dates are independently known, not
  // to values eyeballed from the register. An earlier version of this test
  // asserted three dates that were each nine days out; the implementation was
  // correct and the expectations were invented.
  it('matches known Excel reference points', () => {
    expect(excelSerialToDate(44927).toISOString().slice(0, 10)).toBe('2023-01-01')
    expect(excelSerialToDate(45658).toISOString().slice(0, 10)).toBe('2025-01-01')
  })

  it('converts the serials the register actually carries', () => {
    expect(excelSerialToDate(46164).toISOString().slice(0, 10)).toBe('2026-05-22')
    expect(excelSerialToDate(46014).toISOString().slice(0, 10)).toBe('2025-12-23')
    expect(excelSerialToDate(46259).toISOString().slice(0, 10)).toBe('2026-08-25')
  })

  it('truncates the time component the register sometimes carries', () => {
    // 45882.606282141198 is a date with a time. Only the date matters here.
    expect(excelSerialToDate(45882.606282141198).toISOString().slice(0, 10)).toBe('2025-08-13')
  })

  it('is stable across a day boundary within one serial', () => {
    // .999 must not roll into the next day: the fraction is discarded, not rounded.
    expect(excelSerialToDate(46164.999).toISOString().slice(0, 10))
      .toBe(excelSerialToDate(46164).toISOString().slice(0, 10))
  })
})
