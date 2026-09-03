import { describe, it, expect } from 'vitest'
import { companyForBranch } from '@/lib/integrations/acumatica/companies'

describe('branch routing is per tenant', () => {
  it('routes the same branch code to different companies by tenant', () => {
    // This is the whole reason the function takes a tenant. Getting it wrong
    // files Starkson Paper and Plastic's cheques under Starkson Packaging.
    expect(companyForBranch('GOLIVE', 'ST')).toBe('STK')
    expect(companyForBranch('MANUFACTURING', 'ST')).toBe('STPP')
    expect(companyForBranch('GOLIVE', 'A1+')).toBe('A1+')
    expect(companyForBranch('MANUFACTURING', 'A1+')).toBe('A1PP')
  })

  it('routes the companies that exist in both tenants to the same company', () => {
    for (const t of ['GOLIVE', 'MANUFACTURING'] as const) {
      expect(companyForBranch(t, 'HAMFI(HO)')).toBe('HAMFI')
      expect(companyForBranch(t, 'STINDUSTRY')).toBe('IND')
    }
  })

  it('routes the A1+ Paper and Plastic sibling branches', () => {
    for (const b of ['EURASIA', 'HASBRO', 'MATTEL', 'PERULANDIA', 'SITIO', 'WARNER']) {
      expect(companyForBranch('MANUFACTURING', b), b).toBe('A1PP')
    }
  })

  it('returns null for an unrecognised branch rather than guessing', () => {
    // A branch nobody recognises is a data surprise. Silently filing it under
    // company one is how a cheque ends up attributed to the wrong legal entity.
    expect(companyForBranch('GOLIVE', 'ONEMARANAO')).toBeNull()
    expect(companyForBranch('GOLIVE', '')).toBeNull()
    expect(companyForBranch('MANUFACTURING', 'NOPE')).toBeNull()
  })

  it('tolerates the padding Acumatica applies to branch codes', () => {
    expect(companyForBranch('GOLIVE', '  ST  ')).toBe('STK')
    expect(companyForBranch('MANUFACTURING', 'hamfi(ho)')).toBe('HAMFI')
  })

  it('routes the China offices', () => {
    expect(companyForBranch('GOLIVE', 'DG')).toBe('DG')
    expect(companyForBranch('GOLIVE', 'SH')).toBe('SH')
  })
})
