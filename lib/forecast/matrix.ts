import type { CheckStatus } from '@prisma/client'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import { statusWords, toCentavos, fromCentavos } from '@/lib/export/report'
import { BUCKETS, bucketFor, daysPresentable, type Bucket } from './buckets'
import type { ForecastRow } from './query'

/**
 * THE TWO MATRICES, struck over one list of rows.
 *
 * Pure. Every total is a decimal string summed in centavos and handed back as
 * a decimal string (rule 8); every cell keeps its currencies apart, because a
 * PHP amount added to a USD amount is a number with no meaning. The same
 * discipline as `totalsByCurrency` in lib/export/report.ts.
 */

/** A cheque with neither a checkbook nor a cash account. Shown, never dropped: it is still money. */
export const NO_BANK = '(NO BANK)'

export type Cell = { count: number; totals: { currency: string; total: string }[] }
export type MatrixRow = { bucket: Bucket; cells: Record<string, Cell>; total: Cell }
export type Matrix = {
  columns: string[]
  rows: MatrixRow[]
  /** The column totals. Its `bucket` is meaningless and set to 'NO DATE' only to satisfy the type. */
  total: MatrixRow
}
export type BucketedRow = ForecastRow & { bucket: Bucket; days: number | null }

type Acc = { count: number; cents: Map<string, bigint> }
const acc = (): Acc => ({ count: 0, cents: new Map() })
function add(a: Acc, currency: string, amount: string): void {
  a.count += 1
  a.cents.set(currency, (a.cents.get(currency) ?? 0n) + toCentavos(amount))
}
function seal(a: Acc): Cell {
  return {
    count: a.count,
    totals: [...a.cents.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([currency, cents]) => ({ currency, total: fromCentavos(cents) })),
  }
}

function matrix(rows: readonly BucketedRow[], columns: string[], columnOf: (r: BucketedRow) => string): Matrix {
  const grid = new Map<Bucket, Map<string, Acc>>()
  const rowTotals = new Map<Bucket, Acc>()
  const colTotals = new Map<string, Acc>()
  const grand = acc()
  for (const b of BUCKETS) {
    grid.set(b, new Map(columns.map((c) => [c, acc()])))
    rowTotals.set(b, acc())
  }
  for (const c of columns) colTotals.set(c, acc())

  for (const r of rows) {
    const col = columnOf(r)
    add(grid.get(r.bucket)!.get(col)!, r.currency, r.amount)
    add(rowTotals.get(r.bucket)!, r.currency, r.amount)
    add(colTotals.get(col)!, r.currency, r.amount)
    add(grand, r.currency, r.amount)
  }

  const cellsOf = (m: Map<string, Acc>) => Object.fromEntries(columns.map((c) => [c, seal(m.get(c)!)]))
  return {
    columns,
    rows: BUCKETS.map((bucket) => ({ bucket, cells: cellsOf(grid.get(bucket)!), total: seal(rowTotals.get(bucket)!) })),
    total: { bucket: 'NO DATE', cells: cellsOf(colTotals), total: seal(grand) },
  }
}

export function buildMatrices(
  rows: readonly ForecastRow[],
  today: Date,
): { byBank: Matrix; byStage: Matrix; bucketed: BucketedRow[] } {
  const bucketed: BucketedRow[] = rows.map((r) => ({
    ...r,
    bucket: bucketFor(r.checkDate, today),
    days: r.checkDate ? daysPresentable(r.checkDate, today) : null,
  }))

  // Banks: whichever appear, sorted, NO BANK last. Never a hard-coded list —
  // a third bank appears on the report the day its first cheque does.
  const banks = [...new Set(bucketed.map((r) => r.bank ?? NO_BANK))]
    .sort((a, b) => (a === NO_BANK ? 1 : b === NO_BANK ? -1 : a.localeCompare(b)))

  // Stages: ladder order, only those present, spelled as words.
  const present = new Set<CheckStatus>(bucketed.map((r) => r.stage))
  const stages = LIVE_STATUSES.filter((s) => present.has(s)).map(statusWords)

  return {
    byBank: matrix(bucketed, banks, (r) => r.bank ?? NO_BANK),
    byStage: matrix(bucketed, stages, (r) => statusWords(r.stage)),
    bucketed,
  }
}
