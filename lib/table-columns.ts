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
// fails to parse and the reader falls back to the full table, which is the
// correct outcome and needs no migration.
export const COLUMN_STORAGE_KEY = 'check-monitoring.columns.v1'

export function isColumnKey(value: unknown): value is ColumnKey {
  return typeof value === 'string' && (COLUMN_KEYS as readonly string[]).includes(value)
}

/**
 * Canonicalises a chosen set: unknown keys dropped, duplicates removed, the
 * always-on three added back, and the result in `COLUMN_KEYS` order.
 *
 * Ordering is derived rather than stored, so a preference written before a
 * column existed still renders the new column in its designed position instead
 * of at the end.
 */
export function normaliseColumns(keys: readonly unknown[]): ColumnKey[] {
  const chosen = new Set<ColumnKey>(keys.filter(isColumnKey))
  for (const key of ALWAYS_ON) chosen.add(key)
  return COLUMN_KEYS.filter((key) => chosen.has(key))
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
