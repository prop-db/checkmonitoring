/**
 * CHECKS TRANSMITTAL — the pure parts.
 *
 * Amounts are decimal strings end to end (rule 8). Totals are summed in
 * centavos as BigInt and formatted back to a string; a JS number would lose
 * centavos on a long list. `BigInt(0)` rather than `0n`: Next's file tracer
 * fails on BigInt literal arithmetic (see `lib/numbering/series.ts`).
 */
export const TRANSMITTAL_PATH = '/transmittal'

const ZERO = BigInt(0)
const HUNDRED = BigInt(100)

/** Decimal string (`"190817.35"`, `"5000"`, `"-12.5"`) to centavos; null when unreadable. */
export function amountToCentavos(value: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!m) return null
  const centavos = BigInt(m[2]) * HUNDRED + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -centavos : centavos
}

function centavosToString(c: bigint): string {
  const negative = c < ZERO
  const abs = negative ? -c : c
  const whole = (abs / HUNDRED).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (abs % HUNDRED).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/** `"190817.35"` to `"190,817.35"`; an em dash for no amount (unknown is not zero). */
export function formatAmount(value: string | null): string {
  if (value === null) return '—'
  const c = amountToCentavos(value)
  return c === null ? value : centavosToString(c)
}

export type CurrencyTotal = { currency: string; total: string; count: number }

/** Totals per currency, never mixed; rows with no amount are skipped, not zero. */
export function totalsByCurrency(rows: readonly { amount: string | null; currency: string }[]): CurrencyTotal[] {
  const sums = new Map<string, { total: bigint; count: number }>()
  for (const r of rows) {
    if (r.amount === null) continue
    const c = amountToCentavos(r.amount)
    if (c === null) continue
    const s = sums.get(r.currency) ?? { total: ZERO, count: 0 }
    s.total += c
    s.count += 1
    sums.set(r.currency, s)
  }
  return [...sums.entries()]
    .map(([currency, s]) => ({ currency, total: centavosToString(s.total), count: s.count }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

/** Cheque numbers are digit strings of varying length; order them numerically, text last. */
export function compareCheckNumbers(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? BigInt(a) : null
  const nb = /^\d+$/.test(b) ? BigInt(b) : null
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0
  if (na !== null) return -1
  if (nb !== null) return 1
  return a.localeCompare(b)
}
