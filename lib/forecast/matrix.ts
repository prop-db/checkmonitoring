import { LIVE_STATUSES } from '@/lib/domain/check-status'
import { statusWords, toCentavos, fromCentavos } from '@/lib/export/report'
import { BUCKETS, bucketFor, daysPresentable, type Bucket } from './buckets'
import { PLANNED_STAGE, type ForecastRow, type ForecastStage } from './query'

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

/**
 * `count` is the cell's whole: how many cheques land here, across every
 * currency. `totals` is per currency, and each entry carries its OWN count
 * alongside its own sum — a cell holding one PHP cheque and one USD cheque
 * has `count: 2` but each `totals` entry reads `count: 1`. Counts and amounts
 * are struck from the same accumulator (`Acc`, below), so a currency-split
 * count can never drift from the currency-split amount beside it — which is
 * the whole fix: the workbook used to re-derive a per-currency count from
 * `detail` rows because this type could not answer the question, and `detail`
 * is capped while the matrix is not.
 */
export type Cell = { count: number; totals: { currency: string; count: number; total: string }[] }
export type MatrixRow = { bucket: Bucket; cells: Record<string, Cell>; total: Cell }
export type Matrix = {
  columns: string[]
  rows: MatrixRow[]
  /** The column totals. Its `bucket` is meaningless and set to 'NO DATE' only to satisfy the type. */
  total: MatrixRow
}
export type DateBasis = 'EXPECTED' | 'CHECK DATE' | 'PLANNED'
export type BucketedRow = ForecastRow & { bucket: Bucket; days: number | null; dateBasis: DateBasis }

/** The day a row is bucketed on: a planned line's own day; a cheque's expected date when Finance typed one, else its cheque date. */
export function outflowDate(r: ForecastRow): Date | null {
  if (r.kind === 'PLANNED') return r.checkDate
  return r.expectedOutflowDate ?? r.checkDate
}

function basisOf(r: ForecastRow): DateBasis {
  if (r.kind === 'PLANNED') return 'PLANNED'
  return r.expectedOutflowDate ? 'EXPECTED' : 'CHECK DATE'
}

type Acc = { count: number; byCurrency: Map<string, { count: number; cents: bigint }> }
const acc = (): Acc => ({ count: 0, byCurrency: new Map() })
function add(a: Acc, currency: string, amount: string): void {
  a.count += 1
  const prior = a.byCurrency.get(currency) ?? { count: 0, cents: 0n }
  a.byCurrency.set(currency, { count: prior.count + 1, cents: prior.cents + toCentavos(amount) })
}
function seal(a: Acc): Cell {
  return {
    count: a.count,
    totals: [...a.byCurrency.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([currency, { count, cents }]) => ({ currency, count, total: fromCentavos(cents) })),
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
  const bucketed: BucketedRow[] = rows.map((r) => {
    const on = outflowDate(r)
    return { ...r, bucket: bucketFor(on, today), days: on ? daysPresentable(on, today) : null, dateBasis: basisOf(r) }
  })

  // Banks: whichever appear, sorted, NO BANK last. Never a hard-coded list —
  // a third bank appears on the report the day its first cheque does.
  const banks = [...new Set(bucketed.map((r) => r.bank ?? NO_BANK))]
    .sort((a, b) => (a === NO_BANK ? 1 : b === NO_BANK ? -1 : a.localeCompare(b)))

  // Stages: ladder order, only those present, spelled as words — then PLANNED
  // last, only when a line is present. A column for nothing is a column that
  // reads as "no planned outflows" when the truth is "none were typed".
  const present = new Set<ForecastStage>(bucketed.map((r) => r.stage))
  const stages = LIVE_STATUSES.filter((s) => present.has(s)).map(statusWords)
  if (present.has(PLANNED_STAGE)) stages.push(PLANNED_STAGE)

  return {
    byBank: matrix(bucketed, banks, (r) => r.bank ?? NO_BANK),
    byStage: matrix(bucketed, stages, (r) => statusWords(r.stage)),
    bucketed,
  }
}
