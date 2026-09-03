// Thin Acumatica OData reader: Basic auth, $select/$filter passthrough, and
// $top/$skip paging. `fetchImpl` is injectable so tests never hit the network.
//
// READ-ONLY BY CONSTRUCTION. The project specification says: "Do not modify
// financial information in Acumatica from this application unless specifically
// authorized." That is enforced here by this module offering no way to write —
// no POST, PUT, PATCH or DELETE exists, not even unused — rather than by every
// caller remembering to be careful. Do not add one "for later": the absence is
// the control, and `tests/integrations/acumatica-client.test.ts` asserts it.
//
// Mirrors the Supplier Portal's `src/import/odata-client.js`, which is known to
// work against this Acumatica instance. Deviations from it are marked below.

/**
 * The slice of `fetch` this client uses. Narrower than the DOM `fetch` on
 * purpose: a test double should not have to implement `Response`, and a wider
 * type would let a caller pass a `method` through.
 */
export type AcumaticaFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type AcumaticaRow = Record<string, unknown>

export type AcumaticaClientOptions = {
  baseUrl: string
  user: string
  password: string
  fetchImpl?: AcumaticaFetch
}

export type PageOptions = {
  select?: readonly string[]
  filter?: string
  orderby?: string
  top?: number
  skip?: number
}

export type FetchAllOptions = {
  select?: readonly string[]
  filter?: string
  orderby?: string
  pageSize?: number
  onPage?: (rows: AcumaticaRow[], total: number) => void
}

export type AcumaticaClient = {
  fetchPage(feed: string, opts?: PageOptions): Promise<AcumaticaRow[]>
  fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]>
}

/** The generic inquiry the Supplier Portal already reads. Its name, not a guess. */
export const PAYMENTS_FEED = 'AP-Checks and Payments'

/**
 * Exactly the fields that inquiry exposes, in the order the portal requests
 * them. Named here so the sync does not retype them and quietly ask for a field
 * the inquiry does not publish — which Acumatica answers with a 500, not an
 * omission.
 */
export const PAYMENT_FIELDS = [
  'Type', 'ReferenceNbr', 'Vendor', 'VendorName', 'Status', 'PaymentDate',
  'Description', 'PaymentRef', 'PaymentAmount', 'Balance', 'Currency',
  'CashAccount', 'PaymentMethod', 'Branch', 'LastModifiedOn',
] as const

// The AP feed runs to roughly 37,000 rows and some inquiries ignore $top and
// stream the entire result, which kills the body read. Paging is therefore not
// optional and the default page size must not be "everything".
const DEFAULT_PAGE_SIZE = 2000

export function createAcumaticaClient({
  baseUrl,
  user,
  password,
  fetchImpl,
}: AcumaticaClientOptions): AcumaticaClient {
  // Both messages name the setting, never the value. An error from this module
  // has to be safe to paste into a ticket.
  if (!baseUrl) throw new Error('ACUMATICA_ODATA_URL is not set')
  if (!user || !password) throw new Error('Acumatica OData credentials are not set')

  const doFetch: AcumaticaFetch = fetchImpl ?? (globalThis.fetch as unknown as AcumaticaFetch)
  const root = String(baseUrl).replace(/\/+$/, '')

  // Built once, held in this closure, and placed only in a request header. It
  // is never logged, never interpolated into a URL, and never included in a
  // thrown error — the tests prove all three.
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')

  function urlFor(feed: string, { select, filter, orderby, top, skip }: PageOptions = {}): string {
    const q: string[] = []
    if (select && select.length) q.push('$select=' + encodeURIComponent(select.join(',')))
    if (filter) q.push('$filter=' + encodeURIComponent(filter))
    // Server-side sort. A $filter on a big joined generic inquiry evaluates the
    // whole set (minutes) where an ordered page returns in seconds, so a feed
    // that pages newest-first with a client-side watermark stop needs this.
    if (orderby) q.push('$orderby=' + encodeURIComponent(orderby))
    if (top != null) q.push('$top=' + Number(top))
    // $skip=0 is noise, not information.
    if (skip) q.push('$skip=' + Number(skip))
    return `${root}/${encodeURIComponent(feed)}${q.length ? '?' + q.join('&') : ''}`
  }

  async function fetchPage(feed: string, opts: PageOptions = {}): Promise<AcumaticaRow[]> {
    const url = urlFor(feed, opts)
    // Deviation from the portal, which relies on fetch defaulting to GET. Stated
    // explicitly here so the read-only intent is visible at the call site and
    // testable without inspecting a default.
    const r = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    if (!r.ok) throw new Error(`OData ${feed} returned ${r.status}`)
    const body = await r.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // The LENGTH, never the body. An Acumatica error page or a truncated
      // response carries vendor names and amounts, and this message ends up in
      // a SyncRun row and in logs. The length still separates "empty" from "an
      // HTML error page", which is all the diagnosis needs.
      throw new Error(`OData ${feed} returned unparseable JSON (${body.length} bytes)`)
    }
    const value = (parsed as { value?: unknown })?.value
    return Array.isArray(value) ? (value as AcumaticaRow[]) : []
  }

  // Stops on the first short page. A full-length final page costs one extra
  // empty request, which is cheaper than trusting a server-side count — and is
  // the only way to know a full page was the last one.
  async function fetchAll(
    feed: string,
    { select, filter, orderby, pageSize = DEFAULT_PAGE_SIZE, onPage }: FetchAllOptions = {},
  ): Promise<AcumaticaRow[]> {
    const all: AcumaticaRow[] = []
    for (let skip = 0; ; skip += pageSize) {
      const rows = await fetchPage(feed, { select, filter, orderby, top: pageSize, skip })
      all.push(...rows)
      if (onPage) onPage(rows, all.length)
      if (rows.length < pageSize) return all
    }
  }

  // Two readers. Nothing else. See the read-only note at the top of the file.
  return { fetchPage, fetchAll }
}
