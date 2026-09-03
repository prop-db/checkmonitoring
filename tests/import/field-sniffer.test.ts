import { describe, it, expect } from 'vitest'
import { sniff } from '@/lib/import/field-sniffer'

describe('sniff', () => {
  it('identifies APV numbers across all document prefixes', () => {
    for (const v of ['AP-ST036198', 'AP-A1032460', 'AP-HF001969', 'STPP-AP-000019', 'A1PP-AP-000007', 'AP-IND000580']) {
      expect(sniff(v), v).toBe('APV')
    }
  })

  it('identifies CV numbers', () => {
    for (const v of ['CV-ST011550', 'CV-A1009393', 'CV-HF000087', 'A1PP-CV-000009', 'STPP-CV-000012']) {
      expect(sniff(v), v).toBe('CV')
    }
  })

  it('identifies PO and PR numbers', () => {
    for (const v of ['PO-ST-027363', 'PO-A1-024234', 'A1PP-PO-000012', 'PR-D02-001314']) {
      expect(sniff(v), v).toBe('PO')
    }
  })

  it('identifies checkbooks', () => {
    for (const v of ['BPI-S-4636', 'BPI-A-5713', 'MBT-A-4155', 'MBT-S-1121', 'BDO-A-3838', 'BPI-S-8879']) {
      expect(sniff(v), v).toBe('CHECKBOOK')
    }
  })

  it('identifies check numbers at their two real lengths', () => {
    // BDO cheques are 6 digits, BPI and MBTC are 10. Those are the only two
    // lengths in the register.
    for (const v of ['6000329924', '1791379619', '174602', '326350']) {
      expect(sniff(v), v).toBe('CHECK_NUMBER')
    }
  })

  it('does not mistake a round-number amount for a cheque number', () => {
    // The register carries 4200000 and 20000000 as amounts. A \d{6,10} rule
    // matched them, and appearing earlier in the row they became the cheque
    // number. 600089528 is a truncated BPI number and belongs in review.
    for (const v of ['4200000', '20000000', '600089528', '60003162116']) {
      expect(sniff(v), v).not.toBe('CHECK_NUMBER')
    }
    expect(sniff(4200000)).not.toBe('CHECK_NUMBER')
    expect(sniff(20000000)).not.toBe('CHECK_NUMBER')
  })

  it('identifies Excel date serials in the plausible range', () => {
    // 44000 is 2020, 48000 is 2031. Outside that, a bare number is a check
    // number or an amount, not a date.
    for (const v of [46164, 45882.606282141198, 46259]) {
      expect(sniff(v), String(v)).toBe('DATE_SERIAL')
    }
  })

  it('identifies payment categories', () => {
    for (const v of ['LOCAL SUPPLIER', 'PAYROLL', 'UTILITIES', 'TAX', 'FUND TRANSFER', 'BROKERS', 'SALARIES']) {
      expect(sniff(v), v).toBe('CATEGORY')
    }
  })

  it('identifies clearing references', () => {
    for (const v of ['CR 6336', 'CR08970', 'CR19030']) {
      expect(sniff(v), v).toBe('CLEARING_REF')
    }
  })

  it('does not mistake a checkbook for a check number', () => {
    // BPI-S-4636 contains digits but is not a cheque.
    expect(sniff('BPI-S-4636')).not.toBe('CHECK_NUMBER')
  })

  it('does not mistake a check number for a date serial', () => {
    expect(sniff('174602')).toBe('CHECK_NUMBER')
    expect(sniff(174602)).toBe('CHECK_NUMBER')
  })

  it('identifies text-formatted amounts', () => {
    // Running the parser over the real register produced vendors named
    // "17187.5" and "3746.25": decimal text fell through to UNKNOWN and won the
    // payee slot. A decimal point is required, so cheque numbers are unaffected.
    for (const v of ['17187.5', '1718.75', '3746.25', '197715.42', '1,234.56']) {
      expect(sniff(v), v).toBe('AMOUNT')
    }
  })

  it('does not mistake a whole-number cheque number for an amount', () => {
    expect(sniff('6000329924')).toBe('CHECK_NUMBER')
    expect(sniff('174602')).toBe('CHECK_NUMBER')
  })

  it('identifies the cash-account labels the register uses', () => {
    for (const v of ['BPI STK', 'BPI P&P', 'MBTC A1+', 'MBTC P&P']) {
      expect(sniff(v), v).toBe('CASH_ACCOUNT')
    }
  })

  it('does not mistake a bank that is a genuine payee for an account label', () => {
    // The group pays BDO Unibank as a vendor; eight cheques in the register go
    // to it. Matching on a bank-name prefix would have swallowed them.
    expect(sniff('BDO Unibank, Inc')).toBe('UNKNOWN')
    expect(sniff('BDO Unibank, Inc Credit Card')).toBe('UNKNOWN')
  })

  it('identifies status words the register scatters across columns', () => {
    // "CANCELLED" became a vendor name before this rule existed.
    for (const v of ['PAID', 'YES', 'CANCELLED', 'DEPOSITED', 'CLEARED', 'RELEASED']) {
      expect(sniff(v), v).toBe('STATUS_WORD')
    }
  })

  it('returns UNKNOWN rather than guessing', () => {
    for (const v of ['', '   ', '#N/A', null, undefined, 'Some free text description']) {
      expect(sniff(v as unknown), String(v)).toBe('UNKNOWN')
    }
  })

  it('is not confused by the surrounding whitespace the register carries', () => {
    expect(sniff('  AP-ST036198  ')).toBe('APV')
    expect(sniff(' BPI-S-4636 ')).toBe('CHECKBOOK')
  })
})
