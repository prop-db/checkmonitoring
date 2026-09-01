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
export const GOVERNMENT_PATTERNS: readonly RegExp[] = [
  /^SSS\b/,
  /SOCIAL SECURITY SYSTEM/,
  /BUREAU OF INTERNAL REVENUE/,
  /\bBIR\b/,
  /PAG-?IBIG/,
  /PHILHEALTH/,
  /^MUNICIPALITY OF\b/,
  /^CITY OF\b/,
  /^PROVINCE OF\b/,
  /^REPUBLIC OF THE PHILIPPINES/,
]

const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

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

  if (input.ownCompanyNames.map(norm).includes(payee)) {
    return { eligibility: 'INTERNAL', reason: 'INTER-COMPANY' }
  }

  if (GOVERNMENT_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'GOVERNMENT / STATUTORY' }
  }

  if (INTERNAL_CATEGORIES.includes(category)) {
    return { eligibility: 'INTERNAL', reason: `CATEGORY ${category}` }
  }

  if (BROKER_CATEGORIES.includes(category)) {
    return { eligibility: 'BROKER', reason: 'CATEGORY BROKERS' }
  }

  return { eligibility: 'SUPPLIER', reason: 'TRADE SUPPLIER' }
}
