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

// Every payee below appears verbatim in the client's register of 10,035 released
// checks. These are regression tests against real misclassifications found by
// running the classifier over all 873 distinct payees, not invented examples.
describe('real payees from the client register', () => {
  it('catches government agencies the original patterns missed', () => {
    for (const p of [
      'Bureau Of Customs',
      'Bureau Of Customs(STARKSON PACKAGING INC.)',
      'Bureau of Fire Protection',
      'Department of Labor and Employment',
      'National Labor Relations Commission',
      'Mandaue City Treasurer Office',
      'Quezon City Treasurer Office',
      "PROVINCIAL TREASURER' OFFICE CAVITE",
    ]) {
      expect(classify(p, null).eligibility, p).toBe('INTERNAL')
    }
  })

  it('catches payroll and petty-cash payees by name', () => {
    for (const p of [
      'CASH PAYROLL A1+',
      'CASH PAYROLL STARKSON',
      'CASH(PAYROLL)',
      'CASH PCF',
      'PCF PONDEROSA',
      'SCM Petty Cash',
      'SITIO PETTY CASH',
      'FUND TRANSFER',
    ]) {
      expect(classify(p, null).eligibility, p).toBe('INTERNAL')
    }
  })

  it('matches an own company spelled without its trailing period', () => {
    // The register contains this exact spelling. Exact equality missed it.
    const r = classify('A1+ MULTINATIONAL PACKAGING INC', 'LOCAL SUPPLIER')
    expect(r.eligibility).toBe('INTERNAL')
    expect(r.reason).toBe('INTER-COMPANY')
  })

  it('does not sweep up genuine suppliers with government-adjacent names', () => {
    for (const p of [
      'C.B. Barangay Enterprises Towing and Trucking Services Inc.',
      'KWPB Customs Brokerage',
      'NEW TRENDS INTERNATIONAL CORPORATION',
      'TECHNOLOGY LINKS INTERNATIONAL CORPORATION',
      'International Spring Industries',
      'Caledonian International Corporation',
    ]) {
      expect(classify(p, 'LOCAL SUPPLIER').eligibility, p).toBe('SUPPLIER')
    }
  })

  it('does not capture vendors whose names merely contain payroll or PCF', () => {
    for (const p of [
      'ABC Payroll Solutions Corp',
      'PayrollHero Philippines, Inc.',
      'ABC PCF Corporation',
      'PETTY CASHIER SERVICES CORP.',
    ]) {
      expect(classify(p, 'LOCAL SUPPLIER').eligibility, p).toBe('SUPPLIER')
    }
  })

  // Labour cooperatives are mixed: sometimes a service invoice a representative
  // collects, sometimes payroll. Finance decided these are classified by the
  // category on the individual check, never by the payee name.
  it('classifies labour cooperatives by category, not by name', () => {
    expect(classify('SAVE PLUS LABOR SERVICE COOPERATIVE', 'LOCAL SUPPLIER').eligibility).toBe('SUPPLIER')
    expect(classify('SAVE PLUS LABOR SERVICE COOPERATIVE', 'PAYROLL').eligibility).toBe('INTERNAL')
    expect(classify('KOINONIA SERVICE COOPERATIVE', null).eligibility).toBe('SUPPLIER')
    expect(classify('SERENDIPITY MULTIPURPOSE COOPERATIVE', 'PAYROLL').eligibility).toBe('INTERNAL')
  })
})
