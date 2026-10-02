import type { CheckStatus } from '@prisma/client'
import { canonicalCheckNumber, isBareCheckNumber } from '@/lib/import/normalise'

/**
 * One cash account's cheques in number order, with every unused number between
 * the lowest and the highest reported as MISSING — the user's rule, "every
 * number counts" (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B2).
 *
 * Pure. Numbers are compared as BigInt (they run to ten digits; text order puts
 * 999 after 1000). A gap is one line, never one row per number: the jump between
 * two booklets on one account can be billions. Every number and count leaves
 * this function as a decimal string.
 *
 * Staged re-uses (spec §C, 2026-10-02): Acumatica refuses a duplicate cheque
 * reference on a cash account, so a second payment document on the same cheque
 * number is entered with a dot appended. Such payments sit on the staged queue
 * (NO_CHECK_NUMBER); their number is USED, so it is a STAGED line, never MISSING.
 */
export type SeriesCheque = {
  id: string; checkNumber: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string; status: CheckStatus
}
export type SeriesStaged = {
  acumaticaRef: string; statedCheckRef: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string | null
}
export type SeriesEntry =
  | { kind: 'CHEQUE'; cheque: SeriesCheque; duplicate: boolean }
  | { kind: 'STAGED'; staged: SeriesStaged; number: string }
  | { kind: 'MISSING'; from: string; to: string; count: string }
export type SeriesSummary = {
  first: string | null; last: string | null
  /** Distinct numbers held by CHEQUES — a duplicate counts once; staged lines do not count. */
  held: number
  voided: number; cancelled: number
  /** STAGED lines: numbers Acumatica re-used with a trailing dot. */
  staged: number
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

/**
 * The cheque number a staged dotted re-use stands for, or null. The ONLY rule:
 * the trimmed reference must end with at least one dot, and with only those
 * trailing dots removed it must pass the import's own cheque-number rule. A
 * reference without a dot is not a re-use; a memo (`PCF26-00001.`) is not a
 * number. Nothing else is loosened.
 */
export function stagedSeriesNumber(statedCheckRef: string | null | undefined): string | null {
  const raw = (statedCheckRef ?? '').trim()
  if (!raw.endsWith('.')) return null
  const canonical = canonicalCheckNumber(raw.replace(/\.+$/, ''))
  return isBareCheckNumber(canonical) ? canonical : null
}

type Item =
  | { n: bigint; text: string; order: string; cheque: SeriesCheque; staged?: undefined }
  | { n: bigint; text: string; order: string; staged: SeriesStaged; cheque?: undefined }

export function buildSeries(cheques: readonly SeriesCheque[], staged: readonly SeriesStaged[] = []): AccountSeries {
  const items: Item[] = []
  const notNumeric: SeriesCheque[] = []
  for (const cheque of cheques) {
    const text = cheque.checkNumber.trim()
    // '0' sorts a cheque before any staged line on the same number.
    if (NUMERIC.test(text)) items.push({ n: BigInt(text), text, order: `0${cheque.id}`, cheque })
    else notNumeric.push(cheque)
  }
  for (const s of staged) {
    const number = stagedSeriesNumber(s.statedCheckRef)
    if (number !== null) items.push({ n: BigInt(number), text: number, order: `1${s.acumaticaRef}`, staged: s })
  }
  items.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  notNumeric.sort((a, b) => a.checkNumber.localeCompare(b.checkNumber) || a.id.localeCompare(b.id))

  const perNumber = new Map<bigint, number>()
  for (const x of items) if (x.cheque) perNumber.set(x.n, (perNumber.get(x.n) ?? 0) + 1)
  const isDuplicate = (n: bigint) => (perNumber.get(n) ?? 0) > 1

  const entries: SeriesEntry[] = []
  let missing = ZERO
  let runs = 0
  let prev: { n: bigint; text: string } | null = null
  for (const x of items) {
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
    entries.push(x.cheque
      ? { kind: 'CHEQUE', cheque: x.cheque, duplicate: isDuplicate(x.n) }
      : { kind: 'STAGED', staged: x.staged, number: x.text })
    prev = { n: x.n, text: x.text }
  }

  const chequeItems = items.filter((x) => x.cheque)
  const every = [...chequeItems.map((x) => x.cheque!), ...notNumeric]
  return {
    entries,
    notNumeric,
    summary: {
      first: items.length ? items[0].text : null,
      last: items.length ? items[items.length - 1].text : null,
      held: perNumber.size,
      voided: every.filter((x) => x.status === 'VOIDED').length,
      cancelled: every.filter((x) => x.status === 'CANCELLED').length,
      staged: items.length - chequeItems.length,
      missingNumbers: missing.toString(),
      missingRuns: runs,
      notNumeric: notNumeric.length,
      duplicates: chequeItems.filter((x) => isDuplicate(x.n)).length,
    },
  }
}
