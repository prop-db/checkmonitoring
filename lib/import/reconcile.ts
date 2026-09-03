import { canonicalVendor } from './normalise'
import type { ParsedRow } from './parse'

export type ConflictKind =
  | 'DUPLICATE_ACROSS_SHEETS'
  | 'CONTRADICTORY_STATUS'
  | 'AMOUNT_MISMATCH'
  | 'IMPLAUSIBLE_DATE'

export type Conflict = {
  checkNumber: string
  kind: ConflictKind
  rows: { sheet: string; row: number }[]
  detail: string
}

export type VendorMerge = { canonical: string; variants: string[] }

// The register's own status vocabulary — the words its sheet names use, not the
// release ladder's. `lib/import/implied-status.ts` maps these onto `CheckStatus`
// and applies Finance's ruling when one cheque's sheets disagree.
export type RegisterStatus = 'CANCELLED' | 'RELEASED' | 'AVAILABLE' | 'FINDING' | 'FT_MC'

// Which sheet a row came from is what the register believed about that cheque.
// Two sheets implying different things about one cheque is a contradiction only
// a human can settle: deciding a cheque on both RELEASED and CANCELLED is
// "really" released is a judgement about money that has already moved.
// CANCELLED is tested first because several sheet names contain both words.
//
// Exported because the importer must reach the same verdict this report does.
// A second, divergent copy of this table is how the reconciliation report and
// the import come to disagree about the same cheque — so extend this one.
export const IMPLIED_STATUS: readonly (readonly [RegExp, RegisterStatus])[] = [
  [/CANCELLED/i, 'CANCELLED'],
  [/RELEASED/i, 'RELEASED'],
  [/AVAIL/i, 'AVAILABLE'],
  [/FINDING/i, 'FINDING'],
  [/FT ?& ?MC/i, 'FT_MC'],
]

// `null` when the sheet name asserts nothing — the pending registers, where a
// cheque simply waits.
export function registerStatus(sheet: string): RegisterStatus | null {
  for (const [re, status] of IMPLIED_STATUS) if (re.test(sheet)) return status
  return null
}

// '7950' and '7950.00' are the same money written two ways. Compared on a
// normalised decimal string, never through a float.
function amountKey(amount: string): string {
  const [wholeRaw, fracRaw = ''] = amount.trim().split('.')
  const sign = wholeRaw.startsWith('-') ? '-' : ''
  const digits = wholeRaw.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '')
  const frac = fracRaw.replace(/0+$/, '')
  const whole = digits === '' ? '0' : digits
  return frac ? sign + whole + '.' + frac : sign + whole
}

// A cheque dated far beyond the import is a data-entry error worth a human
// look, not a rejection. The real register carries a 2028 date against 2026.
const IMPLAUSIBLE_MONTHS_AHEAD = 12

export function reconcile(
  rows: readonly ParsedRow[],
  opts: { today: Date },
): { conflicts: Conflict[]; vendorMerges: VendorMerge[] } {
  const byCheck = new Map<string, ParsedRow[]>()
  for (const r of rows) {
    const list = byCheck.get(r.checkNumber)
    if (list) list.push(r)
    else byCheck.set(r.checkNumber, [r])
  }

  const conflicts: Conflict[] = []
  const horizon = new Date(opts.today.getTime())
  horizon.setUTCMonth(horizon.getUTCMonth() + IMPLAUSIBLE_MONTHS_AHEAD)

  for (const [checkNumber, group] of byCheck) {
    const where = group.map((r) => ({ sheet: r.sheet, row: r.row }))

    const sheets = [...new Set(group.map((r) => r.sheet))]
    if (sheets.length > 1) {
      conflicts.push({
        checkNumber,
        kind: 'DUPLICATE_ACROSS_SHEETS',
        rows: where,
        detail: 'appears on ' + sheets.length + ' sheets: ' + sheets.join(', '),
      })

      const statuses = [...new Set(
        sheets.map(registerStatus).filter((s): s is RegisterStatus => s !== null),
      )]
      if (statuses.length > 1) {
        conflicts.push({
          checkNumber,
          kind: 'CONTRADICTORY_STATUS',
          rows: where,
          detail: 'the register implies ' + statuses.join(' and ') + ' for the same cheque',
        })
      }
    }

    const present = group.map((r) => r.amount).filter((a): a is string => a !== null)
    const distinct = [...new Set(present.map(amountKey))]
    if (distinct.length > 1) {
      conflicts.push({
        checkNumber,
        kind: 'AMOUNT_MISMATCH',
        rows: where,
        detail: 'carries ' + distinct.length + ' different amounts: ' + [...new Set(present)].join(', '),
      })
    }

    for (const r of group) {
      if (r.checkDate && r.checkDate.getTime() > horizon.getTime()) {
        conflicts.push({
          checkNumber,
          kind: 'IMPLAUSIBLE_DATE',
          rows: [{ sheet: r.sheet, row: r.row }],
          detail: 'dated ' + r.checkDate.toISOString().slice(0, 10) +
            ', more than ' + IMPLAUSIBLE_MONTHS_AHEAD + ' months ahead',
        })
      }
    }
  }

  // Payee spellings that fold to one canonical form. Reported, never applied:
  // the merge list is presented for confirmation before any import runs.
  const byCanonical = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.payee) continue
    const key = canonicalVendor(r.payee)
    const set = byCanonical.get(key)
    if (set) set.add(r.payee)
    else byCanonical.set(key, new Set([r.payee]))
  }
  const vendorMerges: VendorMerge[] = [...byCanonical].map(([canonical, variants]) => ({
    canonical,
    variants: [...variants],
  }))

  return { conflicts, vendorMerges }
}
