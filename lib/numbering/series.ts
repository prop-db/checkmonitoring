import type { CheckStatus } from '@prisma/client'

/**
 * One cash account's cheques in number order, with every unused number between
 * the lowest and the highest reported as MISSING — the user's rule, "every
 * number counts" (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B2).
 *
 * Pure. Numbers are compared as BigInt (they run to ten digits; text order puts
 * 999 after 1000). A gap is one line, never one row per number: the jump between
 * two booklets on one account can be billions. Every number and count leaves
 * this function as a decimal string.
 */
export type SeriesCheque = {
  id: string; checkNumber: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string; status: CheckStatus
}
export type SeriesEntry =
  | { kind: 'CHEQUE'; cheque: SeriesCheque; duplicate: boolean }
  | { kind: 'MISSING'; from: string; to: string; count: string }
export type SeriesSummary = {
  first: string | null; last: string | null
  /** Distinct numbers held — a duplicate counts once. */
  held: number
  voided: number; cancelled: number
  missingNumbers: string; missingRuns: number
  notNumeric: number
  /** Cheques sharing a number with another cheque in the account. */
  duplicates: number
}
export type AccountSeries = { entries: SeriesEntry[]; notNumeric: SeriesCheque[]; summary: SeriesSummary }

const NUMERIC = /^\d+$/
// Not `0n` / `1n` literals: Next's file tracer (nft) evaluates BinaryExpressions
// statically and throws "Cannot mix BigInt and other types" on them, failing the build.
const ZERO = BigInt(0)
const ONE = BigInt(1)

export function buildSeries(cheques: readonly SeriesCheque[]): AccountSeries {
  const numeric: { n: bigint; text: string; cheque: SeriesCheque }[] = []
  const notNumeric: SeriesCheque[] = []
  for (const cheque of cheques) {
    const text = cheque.checkNumber.trim()
    if (NUMERIC.test(text)) numeric.push({ n: BigInt(text), text, cheque })
    else notNumeric.push(cheque)
  }
  numeric.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.cheque.id < b.cheque.id ? -1 : a.cheque.id > b.cheque.id ? 1 : 0))
  notNumeric.sort((a, b) => a.checkNumber.localeCompare(b.checkNumber))

  const perNumber = new Map<bigint, number>()
  for (const x of numeric) perNumber.set(x.n, (perNumber.get(x.n) ?? 0) + 1)
  const isDuplicate = (n: bigint) => (perNumber.get(n) ?? 0) > 1

  const entries: SeriesEntry[] = []
  let missing = ZERO
  let runs = 0
  let prev: { n: bigint; text: string } | null = null
  for (const x of numeric) {
    if (prev && x.n > prev.n + ONE) {
      const from = prev.n + ONE
      const to = x.n - ONE
      const count = to - from + ONE
      // A leading-zero number keeps its width on the MISSING bounds.
      entries.push({
        kind: 'MISSING',
        from: from.toString().padStart(prev.text.length, '0'),
        to: to.toString().padStart(prev.text.length, '0'),
        count: count.toString(),
      })
      missing += count
      runs += 1
    }
    entries.push({ kind: 'CHEQUE', cheque: x.cheque, duplicate: isDuplicate(x.n) })
    prev = { n: x.n, text: x.text }
  }

  const every = [...numeric.map((x) => x.cheque), ...notNumeric]
  return {
    entries,
    notNumeric,
    summary: {
      first: numeric.length ? numeric[0].text : null,
      last: numeric.length ? numeric[numeric.length - 1].text : null,
      held: perNumber.size,
      voided: every.filter((x) => x.status === 'VOIDED').length,
      cancelled: every.filter((x) => x.status === 'CANCELLED').length,
      missingNumbers: missing.toString(),
      missingRuns: runs,
      notNumeric: notNumeric.length,
      duplicates: numeric.filter((x) => isDuplicate(x.n)).length,
    },
  }
}
