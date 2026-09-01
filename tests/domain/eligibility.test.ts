import { describe, it, expect } from 'vitest'
import { classifyEligibility } from '@/lib/domain/eligibility'

const OWN = ['STARKSON PACKAGING INC.', 'A1+ MULTINATIONAL PACKAGING INC.', 'STARKSON INDUSTRIES']

const classify = (payeeName: string, category: string | null, sourceSheet: string | null = null) =>
  classifyEligibility({ payeeName, category, sourceSheet, ownCompanyNames: OWN })

describe('supplier classification', () => {
  it('classifies an ordinary trade supplier as SUPPLIER', () => {
    expect(classify('GDSM MARKETING', 'LOCAL SUPPLIER').eligibility).toBe('SUPPLIER')
    expect(classify('HENKEL PHILIPPINES INC.', 'LOCAL SUPPLIER').eligibility).toBe('SUPPLIER')
    expect(classify('AJZ Paint Center', null).eligibility).toBe('SUPPLIER')
  })
})

describe('broker classification', () => {
  it('routes the BROKERS category to the broker domain', () => {
    expect(classify('Samb Cargo Services', 'BROKERS').eligibility).toBe('BROKER')
  })
})

describe('internal classification', () => {
  it('treats payroll and salary categories as INTERNAL', () => {
    for (const c of ['PAYROLL', 'SALARIES', 'FTP']) {
      expect(classify('SAVE PLUS LABOR SERVICE COOPERATIVE', c).eligibility).toBe('INTERNAL')
    }
  })

  it('treats tax and fund-transfer categories as INTERNAL', () => {
    expect(classify('Anyone', 'TAX').eligibility).toBe('INTERNAL')
    expect(classify('Anyone', 'FUND TRANSFER').eligibility).toBe('INTERNAL')
  })

  it('treats a payment to one of our own companies as INTERNAL even under a supplier category', () => {
    const r = classify('STARKSON PACKAGING INC.', 'LOCAL SUPPLIER')
    expect(r.eligibility).toBe('INTERNAL')
    expect(r.reason).toBe('INTER-COMPANY')
  })

  it('matches our own companies case-insensitively and ignoring surrounding whitespace', () => {
    expect(classify('  Starkson Packaging Inc.  ', 'LOCAL SUPPLIER').eligibility).toBe('INTERNAL')
  })

  it('treats government and statutory payees as INTERNAL', () => {
    for (const p of [
      'SSS',
      'BUREAU OF INTERNAL REVENUE',
      'PAG-IBIG FUND',
      'PHILHEALTH',
      'MUNICIPALITY OF SILANG CAVITE',
    ]) {
      expect(classify(p, 'LOCAL SUPPLIER').eligibility).toBe('INTERNAL')
    }
  })

  it('treats everything on the FT & MC sheet as INTERNAL regardless of payee', () => {
    const r = classify('THE WALT DISNEY COMPANY (PHILIPPINES), INC.', 'LOCAL SUPPLIER', 'FT & MC')
    expect(r.eligibility).toBe('INTERNAL')
    expect(r.reason).toBe('FUND TRANSFER / MANAGER\u2019S CHEQUE')
  })

  it('defaults to INTERNAL when the payee is unknown or blank', () => {
    expect(classify('', null).eligibility).toBe('INTERNAL')
    expect(classify('   ', 'LOCAL SUPPLIER').eligibility).toBe('INTERNAL')
  })
})

describe('reason codes', () => {
  it('always returns a non-empty reason', () => {
    for (const [p, c] of [['GDSM MARKETING', 'LOCAL SUPPLIER'], ['X', 'PAYROLL'], ['SSS', null]] as const) {
      expect(classify(p, c).reason.length).toBeGreaterThan(0)
    }
  })
})
