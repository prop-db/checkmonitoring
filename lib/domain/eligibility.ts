export type Eligibility = 'SUPPLIER' | 'BROKER' | 'INTERNAL'

export type EligibilityInput = {
  payeeName: string
  category: string | null
  sourceSheet?: string | null
  ownCompanyNames: readonly string[]
}

export type EligibilityResult = { eligibility: Eligibility; reason: string }

export const INTERNAL_CATEGORIES: readonly string[] = [
  'PAYROLL', 'SALARIES', 'FTP', 'TAX', 'FUND TRANSFER',
]

export const BROKER_CATEGORIES: readonly string[] = ['BROKERS']

// Statutory and government payees. These are never suppliers and must never be
// pushed to a supplier-facing portal.
//
// LIMITATION, deliberate and load-bearing: this is a denylist, and a denylist is
// necessarily incomplete. A statutory payee whose name matches nothing here, and
// whose category column is blank, falls through to SUPPLIER. Category is the
// primary control; this list is the backstop for rows where category is missing —
// roughly 15-30% of the client's historical register. Every pattern below was
// derived from the 873 distinct payees in that register, not invented.
export const GOVERNMENT_PATTERNS: readonly RegExp[] = [
  /^SSS\b/,
  /SOCIAL SECURITY SYSTEM/,
  /BUREAU OF INTERNAL REVENUE/,
  /\bBIR\b/,
  /PAG-?IBIG/,
  /\bHDMF\b/,
  /PHILHEALTH/,
  /^BUREAU OF\b/,                       // Bureau Of Customs, Bureau of Fire Protection
  /^DEPARTMENT OF\b/,                   // Department of Labor and Employment
  /NATIONAL LABOR RELATIONS/,
  /\bNLRC\b/,
  /\bTREASURER\b/,                      // Mandaue / Quezon City Treasurer Office
  /^MUNICIPALITY OF\b/,
  /^CITY OF\b/,
  /^CITY GOVERNMENT OF\b/,
  /^PROVINCE OF\b/,
  /^PROVINCIAL (GOVERNMENT|TREASURER)/, // PROVINCIAL TREASURER' OFFICE CAVITE
  /^REPUBLIC OF THE PHILIPPINES/,
]

// Internal payees that are not government: payroll runs and petty-cash
// replenishments drawn in the group's own name, and bare fund transfers.
export const INTERNAL_PAYEE_PATTERNS: readonly RegExp[] = [
  /\bCASH\s*\(?\s*PAYROLL\b/,           // CASH PAYROLL A1+, CASH PAYROLL STARKSON, CASH(PAYROLL)
  /\bPETTY CASH\b/,                     // SCM Petty Cash, SITIO PETTY CASH
  /^PCF\b/,                             // PCF PONDEROSA
  /\bCASH PCF\b/,                       // CASH PCF
  /^FUND TRANSFER$/,                    // anchored: the phrase is too generic unbounded
]

const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

// Real registers spell the same company several ways. The client's own data
// contains both "A1+ MULTINATIONAL PACKAGING INC." and "A1+ MULTINATIONAL
// PACKAGING INC" — exact string equality missed the second and would have
// classified an inter-company payment as a supplier payment. Compare on a key
// that ignores punctuation and the INC/INCORPORATED spelling.
const companyKey = (s: string | null | undefined) =>
  norm(s).replace(/[.,']/g, '').replace(/\bINCORPORATED\b/g, 'INC').replace(/\s+/g, ' ').trim()

// Fund transfers and manager's cheques are internal treasury movements. Their
// payees can look like ordinary third parties, so the source sheet is the only
// reliable signal.
const FT_MC_SHEETS = ['FT & MC']

export function classifyEligibility(input: EligibilityInput): EligibilityResult {
  const payee = norm(input.payeeName)
  const category = norm(input.category)
  const sheet = norm(input.sourceSheet)

  if (payee === '') {
    return { eligibility: 'INTERNAL', reason: 'UNKNOWN PAYEE' }
  }

  if (FT_MC_SHEETS.map(norm).includes(sheet)) {
    return { eligibility: 'INTERNAL', reason: 'FUND TRANSFER / MANAGER\u2019S CHEQUE' }
  }

  if (input.ownCompanyNames.map(companyKey).includes(companyKey(payee))) {
    return { eligibility: 'INTERNAL', reason: 'INTER-COMPANY' }
  }

  if (GOVERNMENT_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'GOVERNMENT / STATUTORY' }
  }

  if (INTERNAL_PAYEE_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'INTERNAL PAYEE' }
  }

  if (INTERNAL_CATEGORIES.includes(category)) {
    return { eligibility: 'INTERNAL', reason: `CATEGORY ${category}` }
  }

  if (BROKER_CATEGORIES.includes(category)) {
    return { eligibility: 'BROKER', reason: 'CATEGORY BROKERS' }
  }

  return { eligibility: 'SUPPLIER', reason: 'TRADE SUPPLIER' }
}
