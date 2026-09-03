import { describe, it, expect } from 'vitest'
import { COMPANIES } from '@/prisma/reference-data'

describe('company reference data', () => {
  it('has eight companies, not three', () => {
    // Six Philippine legal entities plus the two China offices (Dongguan,
    // Shanghai), which pay by transfer, not by cheque.
    expect(COMPANIES).toHaveLength(8)
  })

  it('keeps Starkson and A1+ Paper and Plastic separate', () => {
    const codes = COMPANIES.map((c) => c.code)
    expect(codes).toContain('STPP')
    expect(codes).toContain('A1PP')
    // The old model folded both into one "P&P" company.
    expect(codes).not.toContain('P&P')
  })

  it('gives every company a tenant and branch that round-trips through routing', async () => {
    const { companyForBranch } = await import('@/lib/integrations/acumatica/companies')
    for (const c of COMPANIES) {
      expect(companyForBranch(c.tenant, c.branch), c.code).toBe(c.code)
    }
  })

  it('carries the legal names the eligibility classifier needs', () => {
    // classifyEligibility treats a payment to one of our own companies as
    // INTERNAL. It can only do that if the names are here.
    const all = COMPANIES.flatMap((c) => c.legalNames)
    expect(all).toContain('STARKSON PACKAGING INC.')
    expect(all).toContain('A1+ MULTINATIONAL PACKAGING INC.')
  })
})
