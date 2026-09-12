import { ALL_STATUSES } from './queries'
import { statusWords } from './export/report'
import { CONTESTED, ALL_CANCELLED, NOT_KEYED, type VoucherRow } from './export/voucher-index'
import { DEFAULT_VOUCHER_SCREEN_ROW_LIMIT } from '@/lib/settings/defaults'

/**
 * The voucher screen's arithmetic: what its URL means, what its select offers,
 * how its rows are narrowed, and what its count line says.
 *
 * Pure, for the same reason `dashboard-view.ts` is: the page reads these and
 * decides nothing itself, so every decision on the screen is pinned here with
 * literals rather than by rendering a page and reading text out of it.
 */

export const VOUCHERS_PATH = '/vouchers'

/**
 * How many rows the screen draws. A cap that says so — `describeVoucherView`
 * states the true total beside it — rather than pagination, for the same
 * reason the dashboard caps at 200: a voucher is found by searching for it,
 * not by paging to it.
 */
export const VOUCHER_SCREEN_ROW_LIMIT = DEFAULT_VOUCHER_SCREEN_ROW_LIMIT

/**
 * The three statuses that are facts about a ROW rather than about a cheque.
 * They exist only after resolution, which is why the status filter is applied
 * to resolved rows and not pushed into the SQL like the search is.
 */
export const SYNTHETIC_STATUSES = [CONTESTED, ALL_CANCELLED, NOT_KEYED] as const

/**
 * What the STATUS select offers: every rung of the ladder, spelled as the row
 * spells it — `VoucherRow.status` already holds `statusWords` output — then the
 * three synthetic ones. The ladder is read from `ALL_STATUSES`, not restated:
 * a restatement is how a ninth status ends up on the dashboard and not here.
 */
export const VOUCHER_STATUS_OPTIONS: readonly string[] = [
  ...ALL_STATUSES.map(statusWords),
  ...SYNTHETIC_STATUSES,
]

/**
 * `?status=` as the screen reads it. Words or underscores are both accepted —
 * a link pasted from the dashboard carries `READY_FOR_RELEASE` — and the answer
 * is always words. Anything unrecognised is ignored rather than passed on: a
 * filter to a status that does not exist would show an empty table that looks
 * like a broken one.
 */
export function parseVoucherStatusParam(value: string | undefined): string | undefined {
  if (!value) return undefined
  const words = value.trim().toUpperCase().replace(/_/g, ' ')
  return VOUCHER_STATUS_OPTIONS.includes(words) ? words : undefined
}

export function filterByStatus(
  rows: readonly VoucherRow[],
  status: string | undefined,
): VoucherRow[] {
  if (!status) return [...rows]
  return rows.filter((r) => r.status === status)
}

/** The URL a filled-in form means. An empty search is dropped, as the dashboard drops it. */
export function vouchersHref(params: { q?: string; status?: string }): string {
  const qs = new URLSearchParams()
  const q = params.q?.trim()
  if (q) qs.set('q', q)
  if (params.status) qs.set('status', params.status)
  const s = qs.toString()
  return s ? `${VOUCHERS_PATH}?${s}` : VOUCHERS_PATH
}

const count = (n: number) => n.toLocaleString('en-PH')

/**
 * The line above the table. Says how many there are, how many are drawn, and
 * what narrowed them — the same discipline as `describeScope` in the export:
 * a table of 200 that does not say it is the first 200 reads as the whole.
 */
export function describeVoucherView(
  total: number,
  shown: number,
  q: string | undefined,
  status: string | undefined,
): string {
  const scope = [
    q?.trim() ? `MATCHING "${q.trim()}"` : null,
    status ? `WITH STATUS ${status}` : null,
  ].filter(Boolean).join(' · ')
  const suffix = scope ? ` ${scope}` : ''
  if (total === 0) return `NO VOUCHERS${suffix}`
  const what = `${count(total)} VOUCHER${total === 1 ? '' : 'S'}${suffix}`
  if (shown < total) return `${what} · SHOWING FIRST ${count(shown)} — narrow the search to see the rest`
  return what
}
