import type { GuardResult } from './check-status'
import { isIsoDay } from './details'
import { DEFAULT_CATEGORIES, isCategory } from '@/lib/settings/categories'

/**
 * A PLANNED OUTFLOW THAT IS NOT A CHEQUE.
 *
 * Payroll, a tax remittance, loan amortisation, a transfer — money that leaves
 * the same account as the cheques and appeared nowhere in this system until
 * 2026-09-12. Typed one line at a time; nothing here recurs, so nothing is
 * forecast that nobody typed.
 *
 * Pure. The amount is money as TEXT (rule 8): the guard reads the string, the
 * normaliser pads it to two decimals, and it reaches the database as a
 * decimal string. Zero is refused — a planned outflow of nothing is a line
 * somebody forgot to fill in, not a fact.
 */

export const MONEY = /^\d+(\.\d{1,2})?$/

export type PlannedOutflowInput = {
  date: string
  amount: string
  currency?: string
  bankId: string
  companyId: string
  description: string
  category?: string | null
}

export type PlannedOutflowValues = {
  date: string
  amount: string
  currency: string
  bankId: string
  companyId: string
  description: string
  category: string | null
}

const blank = (s: string | null | undefined) => (s ?? '').trim() === ''

export function checkPlannedOutflowInput(
  input: PlannedOutflowInput,
  opts: { categories?: readonly string[] } = {},
): GuardResult {
  if (!isIsoDay((input.date ?? '').trim())) {
    return { ok: false, code: 'INVALID_DATE', message: 'DATE must be a day, YYYY-MM-DD.' }
  }
  const amount = (input.amount ?? '').trim()
  if (!MONEY.test(amount) || Number(amount) === 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'AMOUNT must be a number with up to two decimals, greater than zero, without commas.' }
  }
  if (blank(input.description)) return { ok: false, code: 'DESCRIPTION_REQUIRED', message: 'Describe the outflow — what it is for.' }
  if (blank(input.bankId)) return { ok: false, code: 'BANK_REQUIRED', message: 'Choose the bank it leaves from.' }
  if (blank(input.companyId)) return { ok: false, code: 'COMPANY_REQUIRED', message: 'Choose the company it belongs to.' }
  const category = (input.category ?? '').trim()
  if (category !== '' && !isCategory(opts.categories ?? DEFAULT_CATEGORIES, category)) {
    return {
      ok: false,
      code: 'UNKNOWN_CATEGORY',
      message: `${category.toUpperCase()} is not a category. Add it under ADMINISTRATION → SETTINGS first.`,
    }
  }
  return { ok: true }
}

/** Two decimals, as text. `'5'` → `'5.00'`, `'5.5'` → `'5.50'`. Never through a float. */
function padMoney(s: string): string {
  const [whole, frac = ''] = s.split('.')
  return `${whole}.${(frac + '00').slice(0, 2)}`
}

export function normalisePlannedOutflow(input: PlannedOutflowInput): PlannedOutflowValues {
  const category = (input.category ?? '').trim()
  return {
    date: input.date.trim(),
    amount: padMoney(input.amount.trim()),
    currency: (input.currency ?? '').trim() === '' ? 'PHP' : input.currency!.trim().toUpperCase(),
    bankId: input.bankId.trim(),
    companyId: input.companyId.trim(),
    description: input.description.trim(),
    category: category === '' ? null : category.toUpperCase(),
  }
}

export type PlannedOutflowChange = { from: string | null; to: string | null }

export function diffPlannedOutflow(
  before: PlannedOutflowValues, after: PlannedOutflowValues,
): Partial<Record<keyof PlannedOutflowValues, PlannedOutflowChange>> {
  const changes: Partial<Record<keyof PlannedOutflowValues, PlannedOutflowChange>> = {}
  for (const key of Object.keys(before) as (keyof PlannedOutflowValues)[]) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] }
  }
  return changes
}
