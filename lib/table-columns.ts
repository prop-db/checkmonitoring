/**
 * Which columns the dashboard table shows, and how a stored choice is read back.
 *
 * Pure: no database, no `window`, no DOM. The browser reads the raw string out
 * of `localStorage` and hands it to `parseColumnPreference`, which is why every
 * way that string can be wrong — absent, empty, truncated, hand-edited, written
 * by an older version — is testable without a browser.
 *
 * The preference is a per-viewer convenience and lives ONLY in that viewer's
 * browser. It is never written to the database: which columns someone likes is
 * not a fact about a cheque, and storing it server-side would make a display
 * preference into a row that outlives the person and needs migrating.
 */

export const COLUMN_KEYS = [
  'checkNumber',
  'apvNumbers',
  'poNumbers',
  'refNumbers',
  'payeeName',
  'companyCode',
  'bank',
  'checkDate',
  'amount',
  'status',
  'availablePickupDate',
  'scheduledPickupDate',
  'releasedAt',
  'action',
] as const

export type ColumnKey = (typeof COLUMN_KEYS)[number]

// ALL CAPS to match every other label on the screen.
export const COLUMN_LABELS: Record<ColumnKey, string> = {
  checkNumber: 'CHECK NUMBER',
  apvNumbers: 'APV NUMBER',
  poNumbers: 'PO NUMBER',
  // Acumatica's Vendor Ref on the cheque's bills, shown whole (2026-10-06).
  refNumbers: 'REFERENCE',
  payeeName: 'SUPPLIER NAME',
  companyCode: 'COMPANY',
  bank: 'BANK',
  checkDate: 'CHECK DATE',
  amount: 'AMOUNT',
  status: 'STATUS',
  availablePickupDate: 'AVAILABLE DATE',
  scheduledPickupDate: 'PICKUP SCHEDULE',
  // When the release was recorded HERE. Blank on every release the register
  // load imported or a catch-up moved — that is the fact, not a gap to fill.
  releasedAt: 'DATE RELEASED',
  action: 'ACTION',
}

/**
 * The three that cannot be turned off. A row whose cheque number is hidden
 * cannot be identified, one whose status is hidden cannot be read, and one with
 * no action cannot be opened — that is not a narrower table, it is a list of
 * anonymous rows. They are rendered without a tick-box rather than with a
 * disabled one, because they were never a choice the user failed to make.
 */
export const ALWAYS_ON = ['checkNumber', 'status', 'action'] as const satisfies readonly ColumnKey[]

/**
 * What the table renders before any preference has loaded — every column.
 *
 * This matters more than it looks. The preference can only be read in an
 * effect, after the first paint, so the first render must already be a working
 * table. Defaulting to "nothing until we know" would give a fresh browser, a
 * slow one, and one with storage disabled a flash of an empty table instead.
 */
export const DEFAULT_COLUMNS: readonly ColumnKey[] = COLUMN_KEYS

// Bumped if the key set ever changes shape. An older version's value simply
// is not read and the reader falls back to the full table, which is the
// correct outcome and needs no migration.
// v2 (2026-10-01): PO NUMBER added. A v1 choice was a list of the columns that
// existed then, and read under v2 it would hide the new one for everybody who
// had ever ticked a box.
// Since part C (2026-10-01) the array is the visible columns IN DISPLAY ORDER.
// A v2 value written before that is in canonical order and reads as the default
// order with the same visibility, so the key is not bumped again.
// v3 (2026-10-06): REFERENCE added, for the same reason as v2.
export const COLUMN_STORAGE_KEY = 'check-monitoring.columns.v3'

export function isColumnKey(value: unknown): value is ColumnKey {
  return typeof value === 'string' && (COLUMN_KEYS as readonly string[]).includes(value)
}

const canonical = (k: ColumnKey) => COLUMN_KEYS.indexOf(k)

/**
 * `key` added to `order` beside its nearest canonical predecessor that is
 * already there (at the front if none is) — a column shown again returns to
 * its usual neighbour, not to the end. ACTION is always appended last.
 */
export function insertColumn(order: readonly ColumnKey[], key: ColumnKey): ColumnKey[] {
  if (order.includes(key)) return [...order]
  if (key === 'action') return [...order, 'action']
  const out: ColumnKey[] = order.filter((k) => k !== 'action')
  const before = COLUMN_KEYS.slice(0, canonical(key)).reverse().find((k) => out.includes(k))
  out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, key)
  return order.includes('action') ? [...out, 'action'] : out
}

/**
 * Canonicalises a stored choice: unknown keys dropped, duplicates removed,
 * the ORDER GIVEN KEPT, the always-on three added back beside their canonical
 * neighbours, and ACTION last.
 */
export function normaliseColumns(keys: readonly unknown[]): ColumnKey[] {
  let out: ColumnKey[] = [...new Set(keys.filter(isColumnKey))].filter((k) => k !== 'action')
  for (const key of ALWAYS_ON) out = insertColumn(out, key)
  return out
}

/** Show or hide one column. The always-on three do not toggle. */
export function toggleColumn(order: readonly ColumnKey[], key: ColumnKey): ColumnKey[] {
  if ((ALWAYS_ON as readonly ColumnKey[]).includes(key)) return [...order]
  return order.includes(key) ? order.filter((k) => k !== key) : insertColumn(order, key)
}

export function canMoveColumn(order: readonly ColumnKey[], key: ColumnKey, delta: -1 | 1): boolean {
  const at = order.indexOf(key)
  const to = at + delta
  return key !== 'action' && at >= 0 && to >= 0 && to < order.length && order[to] !== 'action'
}

/** One place left or right; ACTION never moves and nothing passes it. */
export function moveColumn(order: readonly ColumnKey[], key: ColumnKey, delta: -1 | 1): ColumnKey[] {
  if (!canMoveColumn(order, key, delta)) return [...order]
  const out = [...order]
  const at = out.indexOf(key)
  ;[out[at], out[at + delta]] = [out[at + delta], out[at]]
  return out
}

/**
 * The chooser's controls. What is SHOWN is the preference with the filtered
 * columns forced in; what is EDITED and saved is the preference alone, so a
 * column on screen only because a filter is in force is never written to
 * storage by a move or a toggle. Such a column does not move (its arrows are
 * disabled): it has no place in the saved order to move from.
 */
export function columnControls(preference: readonly ColumnKey[], forced: readonly ColumnKey[]) {
  return {
    visible: withColumns(preference, forced),
    canMove: (key: ColumnKey, delta: -1 | 1) => canMoveColumn(preference, key, delta),
    move: (key: ColumnKey, delta: -1 | 1) => moveColumn(preference, key, delta),
    toggle: (key: ColumnKey) => toggleColumn(preference, key),
  }
}

/** `order` with `keys` forced in — a filtered column stays on screen (part C2). */
export function withColumns(order: readonly ColumnKey[], keys: readonly ColumnKey[]): ColumnKey[] {
  return keys.reduce<ColumnKey[]>((acc, k) => insertColumn(acc, k), [...order])
}

/** The export link with `cols=` in the viewer's order (ACTION is not a file column). */
export function withColumnOrder(href: string, order: readonly ColumnKey[]): string {
  const [path, query = ''] = href.split('?')
  const qs = new URLSearchParams(query)
  qs.set('cols', order.filter((k) => k !== 'action').join(','))
  return `${path}?${qs.toString()}`
}

/**
 * Reads what `localStorage` held.
 *
 * `null` means NO USABLE PREFERENCE — absent, empty, unparseable, or the wrong
 * shape — and the caller answers that by showing every column. An empty array
 * is not that case: it is a real choice, the user having unticked every
 * optional column, and it normalises to the always-on three rather than
 * springing back to all eleven.
 */
export function parseColumnPreference(raw: string | null | undefined): ColumnKey[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Storage can hold anything: a half-written value, or something another
    // tool put under this key. Never throw out of a render.
    return null
  }
  if (!Array.isArray(parsed)) return null
  return normaliseColumns(parsed)
}

export function serialiseColumnPreference(keys: readonly ColumnKey[]): string {
  return JSON.stringify(normaliseColumns(keys))
}
