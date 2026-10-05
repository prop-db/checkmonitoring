import { naiveDate } from './map'

/**
 * The purchase orders an AP bill names, read from Acumatica.
 *
 * `AP-Bills and Adjustments` carries one row per AP document; `VendorRef` is
 * the field the approval workbook's PO column comes from (lib/import/bills.ts,
 * VENDOR_REF). It is NOT always a PO — `26X06-0267A`, `SI#1659`, free text —
 * and the client chose "only real POs" (2026-10-05), so `extractPoNumbers`
 * keeps the PO shapes measured that day and nothing else.
 *
 * ONE column map for both tenants: measured 2026-10-05, MANUFACTURING names
 * this inquiry's columns exactly as Go-Live does (unlike AP-PAYMENTS-WITH-BILLS,
 * lib/integrations/acumatica/bills.ts).
 *
 * Only `Bill` documents dated 2026 onward (the sync's scope). The incremental
 * filter is on `LastModifiedOn` alone, so the scope is enforced here, not in
 * OData. Pure.
 */

export const BILL_REFS_FEED = 'AP-Bills and Adjustments'

export const BILL_REF_COLUMNS = {
  type: 'Type',
  ref: 'ReferenceNbr',
  date: 'Date',
  vendorRef: 'VendorRef',
  lastModified: 'LastModifiedOn',
} as const

/** The same scope boundary as the payment sync (`SYNC_FROM_DATE` in lib/sync/run.ts). */
const IN_SCOPE_FROM = '2026-01-01T00:00:00'
const SCOPE_START = new Date(`${IN_SCOPE_FROM}Z`)

const literal = (d: Date) => `datetime'${d.toISOString().slice(0, 19)}'`

export function billRefsSelect(): string[] {
  return Object.values(BILL_REF_COLUMNS)
}

export function billRefsSinceFilter(since: Date): string {
  return `${BILL_REF_COLUMNS.lastModified} ge ${literal(since)}`
}

export function billRefsInScopeFilter(): string {
  return `${BILL_REF_COLUMNS.date} ge datetime'${IN_SCOPE_FROM}'`
}

/**
 * `PO-ST-031109`, `PO-A1-012345`, `PO-IND123456`, `PO-ST123456` (first form) and
 * `A1PP-PO-000123`, `STPP-PO-0001234` (second), never inside a longer
 * alphanumeric run. A trailing dot is outside the match by construction.
 */
const PO_PATTERN = /(?<![A-Z0-9])(?:PO-[A-Z0-9]{2,4}-?\d{5,7}|[A-Z0-9]{2,5}-PO-\d{5,7})(?![A-Z0-9])/gi

export function extractPoNumbers(vendorRef: string | null | undefined): string[] {
  if (!vendorRef) return []
  const out: string[] = []
  for (const m of vendorRef.matchAll(PO_PATTERN)) {
    const po = m[0].toUpperCase()
    if (!out.includes(po)) out.push(po)
  }
  return out
}

export type BillRef = {
  /** `ReferenceNbr`, trimmed and upper-cased — the APV. */
  apvNumber: string
  /** `VendorRef`, trimmed; '' when absent. Kept for diagnosis. */
  vendorRef: string
  /** `extractPoNumbers(vendorRef)`; empty when the ref names no PO. */
  poNumbers: string[]
  lastModifiedOn: Date | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function mapBillRef(raw: unknown): BillRef | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (text(r[BILL_REF_COLUMNS.type]) !== 'Bill') return null
  const apvNumber = text(r[BILL_REF_COLUMNS.ref]).toUpperCase()
  if (!apvNumber) return null
  const date = naiveDate(r[BILL_REF_COLUMNS.date], { dayOnly: true })
  if (date === null || date < SCOPE_START) return null
  const vendorRef = text(r[BILL_REF_COLUMNS.vendorRef])
  return {
    apvNumber,
    vendorRef,
    poNumbers: extractPoNumbers(vendorRef),
    lastModifiedOn: naiveDate(r[BILL_REF_COLUMNS.lastModified], { dayOnly: false }),
  }
}
