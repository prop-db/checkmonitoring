import { describe, it, expect } from 'vitest'
import {
  canonicalVendor, canonicalCheckBook, canonicalCheckNumber, isBareCheckNumber,
  excelSerialToDate, cleanCell,
} from '@/lib/import/normalise'

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

describe('canonicalCheckNumber', () => {
  // The two sources write the same physical cheque differently. The register
  // writes it bare (6000308584); Acumatica's PaymentRef is bank-prefixed
  // ("BPI 6000240287") on 1,789 of 1,987 live rows — 90.0% — and bare on only
  // 82 (4.1%). Since the dedup key is (companyId, checkNumber), the difference
  // stored one physical cheque TWICE, once per source, so no staged row could
  // ever be promoted and every cheque in both sources double-counted in the
  // dashboard totals. The bare form wins because it is the register's and the
  // one a human reads off the cheque itself.
  it('strips the bank prefix Acumatica puts in front of a check number', () => {
    expect(canonicalCheckNumber('BPI 6000240287')).toBe('6000240287')
    expect(canonicalCheckNumber('MBTC 6000240287')).toBe('6000240287')
    expect(canonicalCheckNumber('BDO 6000240287')).toBe('6000240287')
    // Six-digit cheque numbers exist alongside the ten-digit ones.
    expect(canonicalCheckNumber('MBTC 179123')).toBe('179123')
  })

  it('is the SAME key for a register check number and its Acumatica counterpart', () => {
    // The whole point. Measured over 2,000 live rows: stripping merges zero
    // distinct original refs onto one key, so this cannot collide two cheques.
    expect(canonicalCheckNumber('BPI 6000240287')).toBe(canonicalCheckNumber('6000240287'))
    expect(canonicalCheckNumber('MBTC 6000308584')).toBe(canonicalCheckNumber(' 6000308584 '))
  })

  it('leaves a bare check number exactly as it found it', () => {
    expect(canonicalCheckNumber('6000308584')).toBe('6000308584')
    expect(canonicalCheckNumber('179123')).toBe('179123')
  })

  // The rule is deliberately narrow: <known bank code><whitespace><6 or 10
  // digits> and nothing else. A blind replace(/\D/g, '') would turn the free
  // text 80 real cheques carry ("Oct interest", "pay 12 25 2nd") into
  // plausible-looking cheque numbers, which is inventing a fact about money.
  it('does not touch a reference that is not a bank code followed by a check number', () => {
    expect(canonicalCheckNumber('Oct interest')).toBe('Oct interest')
    expect(canonicalCheckNumber('pay 12 25 2nd')).toBe('pay 12 25 2nd')
    // A near miss: a bank code, but not a cheque number after it.
    expect(canonicalCheckNumber('MBTC 1791 to 1795')).toBe('MBTC 1791 to 1795')
    expect(canonicalCheckNumber('MBTC 17912')).toBe('MBTC 17912')
    // The China branches' AP reference is the only identifier those payments
    // have. Mangling it makes the row unkeyable.
    expect(canonicalCheckNumber('AP-DG001931')).toBe('AP-DG001931')
    // A bank we have not measured is left alone rather than guessed at.
    expect(canonicalCheckNumber('RCBC 6000240287')).toBe('RCBC 6000240287')
  })

  it('says nothing rather than empty string when the source states no reference', () => {
    expect(canonicalCheckNumber(null)).toBeNull()
    expect(canonicalCheckNumber(undefined)).toBeNull()
    expect(canonicalCheckNumber('   ')).toBeNull()
    expect(canonicalCheckNumber('#N/A')).toBeNull()
  })
})

describe('isBareCheckNumber', () => {
  // What separates a cheque number from a memo somebody typed into the cheque
  // number field. 80 live rows are PaymentMethod CHK — genuinely cheques — but
  // carry free text here, and they cannot be keyed on (company, checkNumber).
  it('accepts a canonical check number and rejects free text', () => {
    expect(isBareCheckNumber('6000308584')).toBe(true)
    expect(isBareCheckNumber('179123')).toBe(true)
    expect(isBareCheckNumber('Oct interest')).toBe(false)
    expect(isBareCheckNumber('pay 12 25 2nd')).toBe(false)
    expect(isBareCheckNumber('MBTC 1791 to 1795')).toBe(false)
    expect(isBareCheckNumber('AP-DG001931')).toBe(false)
    expect(isBareCheckNumber(null)).toBe(false)
  })
})
