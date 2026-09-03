export type AcumaticaTenant = 'GOLIVE' | 'MANUFACTURING'

export const UNASSIGNED_COMPANY = 'UNASSIGNED'

// Acumatica's two tenants reuse the same branch codes for different companies.
// In Go-Live, "ST" is Starkson Packaging; in MANUFACTURING it is Starkson Paper
// and Plastic. Routing on branch alone files a cheque under the wrong legal
// entity, so the tenant is not optional.
//
// Mirrors the Supplier Portal's routing table so both systems agree on what a
// company is — they exchange cheques by APV number and must not disagree.
const GOLIVE: Readonly<Record<string, string>> = {
  ST: 'STK',
  'A1+': 'A1+',
  'HAMFI(HO)': 'HAMFI',
  STINDUSTRY: 'IND',
}

const MANUFACTURING: Readonly<Record<string, string>> = {
  ST: 'STPP',
  'A1+': 'A1PP',
  // A1+ Paper and Plastic carries the same sibling branches A1+ Multinational
  // does in Go-Live.
  EURASIA: 'A1PP',
  HASBRO: 'A1PP',
  MATTEL: 'A1PP',
  PERULANDIA: 'A1PP',
  SITIO: 'A1PP',
  WARNER: 'A1PP',
  'HAMFI(HO)': 'HAMFI',
  STINDUSTRY: 'IND',
}

export function companyForBranch(tenant: AcumaticaTenant, branch: string): string | null {
  const key = String(branch ?? '').trim().toUpperCase()
  if (!key) return null
  const map = tenant === 'MANUFACTURING' ? MANUFACTURING : GOLIVE
  return map[key] ?? null
}
