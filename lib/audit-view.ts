/**
 * The audit screen's arithmetic — parameters, the cursor, the Manila-day
 * bounds, hrefs, the filter line, the filename. Pure, like `vouchers-view.ts`
 * and `forecast-view.ts`: the page reads these and decides nothing itself.
 */

export const AUDIT_PATH = '/admin/audit'
export const AUDIT_EXPORT_PATH = '/api/export/audit'

/** Rows per page. A keyset page, so the number is about reading, not cost. */
export const AUDIT_PAGE_SIZE = 100

export type AuditFilters = {
  /** True widens to every row; false (the default) is people's actions only. */
  system: boolean
  action?: string
  userId?: string
  checkNumber?: string
  from?: Date
  to?: Date
}

/** Where the previous page ended. Rows are ordered (createdAt desc, id desc). */
export type AuditCursor = { createdAt: Date; id: string }

export type AuditParams = {
  system?: string; action?: string; user?: string; check?: string; from?: string; to?: string; before?: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A Manila calendar day's first and last instants, as UTC. The Philippines is
 * UTC+8 with no daylight saving, so the offset is a constant rather than a
 * timezone lookup — the same reasoning as `MANILA_OFFSET_MS` in the voucher
 * workbook.
 */
export function manilaDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+08:00`)
}
export function manilaDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999+08:00`)
}

function readDay(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v && DAY.test(v) && !Number.isNaN(manilaDayStart(v).getTime()) ? v : undefined
}

/** `<createdAt ISO>|<id>`. Both halves are needed: two rows can share an instant. */
export function encodeCursor(c: AuditCursor): string {
  return `${c.createdAt.toISOString()}|${c.id}`
}

export function decodeCursor(s: string | undefined): AuditCursor | null {
  if (!s) return null
  const bar = s.indexOf('|')
  if (bar <= 0 || bar === s.length - 1) return null
  const createdAt = new Date(s.slice(0, bar))
  if (Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id: s.slice(bar + 1) }
}

export function parseAuditParams(p: AuditParams): {
  filters: AuditFilters
  cursor: AuditCursor | null
  raw: { from?: string; to?: string }
} {
  const from = readDay(p.from)
  const to = readDay(p.to)
  const filters: AuditFilters = { system: p.system === '1' }
  const action = p.action?.trim()
  if (action) filters.action = action
  const user = p.user?.trim()
  if (user) filters.userId = user
  const check = p.check?.trim()
  if (check) filters.checkNumber = check
  if (from) filters.from = manilaDayStart(from)
  if (to) filters.to = manilaDayEnd(to)
  return { filters, cursor: decodeCursor(p.before), raw: { from, to } }
}

/** The URL a filled-in form means. The export never carries the cursor: a file is the whole range. */
export function auditHref(p: AuditParams, path: string = AUDIT_PATH): string {
  const qs = new URLSearchParams()
  const keys: (keyof AuditParams)[] = ['system', 'action', 'user', 'check', 'from', 'to', 'before']
  for (const key of keys) {
    if (key === 'before' && path !== AUDIT_PATH) continue
    const v = p[key]?.trim()
    if (v) qs.set(key, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function actionWords(action: string): string {
  return action.replace(/_/g, ' ').toUpperCase()
}

/** The Manila day of an instant, for the filter line and the filename. */
function manilaDay(d: Date): string {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function describeAuditFilters(f: AuditFilters, names: { user?: string }): string {
  const parts: string[] = []
  if (f.system) parts.push('INCLUDING SYSTEM ROWS')
  if (f.action) parts.push(`ACTION: ${actionWords(f.action)}`)
  if (f.userId) parts.push(`USER: ${names.user ?? f.userId}`)
  if (f.checkNumber) parts.push(`CHECK: ${f.checkNumber}`)
  if (f.from) parts.push(`FROM ${manilaDay(f.from)}`)
  if (f.to) parts.push(`TO ${manilaDay(f.to)}`)
  return parts.length ? parts.join('  ·  ') : "PEOPLE'S ACTIONS ONLY"
}

export function auditFilename(generatedAt: Date): string {
  return `audit-${manilaDay(generatedAt)}.xlsx`
}
