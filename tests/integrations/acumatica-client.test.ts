import { describe, it, expect } from 'vitest'
import {
  createAcumaticaClient,
  PAYMENTS_FEED,
  PAYMENT_FIELDS,
  type AcumaticaFetch,
} from '@/lib/integrations/acumatica/client'

// Deliberately distinctive so a leak into an error, a URL or a log is
// unmistakable in a diff. Not real credentials.
const USER = 'odata-svc-acct'
const PASSWORD = 'hunter2-correct-horse'

type Call = { url: string; init: { method?: string; headers: Record<string, string> } }

/** Records every request and replies with whatever the queue says. Never touches the network. */
function recorder(replies: Array<{ ok?: boolean; status?: number; body: string }>) {
  const calls: Call[] = []
  const fetchImpl: AcumaticaFetch = async (url, init) => {
    calls.push({ url, init })
    const r = replies[calls.length - 1] ?? { body: JSON.stringify({ value: [] }) }
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body,
    }
  }
  return { calls, fetchImpl }
}

const page = (n: number) =>
  JSON.stringify({ value: Array.from({ length: n }, (_, i) => ({ ReferenceNbr: `CV-${i}` })) })

/**
 * The rejection, typed as an Error. `.catch((e) => e)` widens the result to
 * `rows | Error` and every assertion on `.message` then fails `tsc` — a green
 * Vitest run is not enough here, esbuild erases the types.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  const NO_REJECTION = Symbol('no rejection')
  const outcome = await p.then(() => NO_REJECTION, (e: unknown) => e)
  if (outcome === NO_REJECTION) throw new Error('expected the request to reject, but it resolved')
  return outcome as Error
}

const client = (fetchImpl: AcumaticaFetch) =>
  createAcumaticaClient({ baseUrl: 'https://acu.example.com/odata/', user: USER, password: PASSWORD, fetchImpl })

describe('createAcumaticaClient: read-only by construction', () => {
  it('exposes no mutating method — there is no way to write to Acumatica through it', () => {
    // Not a convention callers must remember. The spec forbids modifying
    // financial information in Acumatica, and the enforcement is that the type
    // has no such method. If a future change adds one, this test fails.
    const c = client(recorder([]).fetchImpl)
    expect(Object.keys(c).sort()).toEqual(['fetchAll', 'fetchPage'])
    for (const forbidden of ['post', 'put', 'patch', 'delete', 'create', 'update', 'write', 'save']) {
      expect(c, forbidden).not.toHaveProperty(forbidden)
    }
  })

  it('issues only GET requests', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage(PAYMENTS_FEED)
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('GET')
  })
})

describe('createAcumaticaClient: credentials', () => {
  it('sends Basic auth', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage(PAYMENTS_FEED)
    const expected = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64')
    expect(calls[0].init.headers.Authorization).toBe(expected)
    expect(calls[0].init.headers.Accept).toBe('application/json')
  })

  it('never puts a credential in the URL', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage(PAYMENTS_FEED)
    expect(calls[0].url).not.toContain(USER)
    expect(calls[0].url).not.toContain(PASSWORD)
    expect(calls[0].url).not.toContain('Basic')
  })

  it('a failed request names the status but leaks neither the username nor the password', async () => {
    // The whole error, including its stack and anything a logger would print,
    // must be safe to paste into a ticket.
    const unauthorized = () => recorder([{ ok: false, status: 401, body: 'Unauthorized' }]).fetchImpl
    await expect(client(unauthorized()).fetchPage(PAYMENTS_FEED)).rejects.toThrow(/401/)

    const err = await rejection(client(unauthorized()).fetchPage(PAYMENTS_FEED))
    const everything = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err, Object.getOwnPropertyNames(err))}`
    expect(everything).not.toContain(USER)
    expect(everything).not.toContain(PASSWORD)
    expect(everything).not.toContain('Basic ')
  })

  it('refuses to be constructed without a base URL or credentials, naming the setting not the value', () => {
    const f = recorder([]).fetchImpl
    expect(() => createAcumaticaClient({ baseUrl: '', user: USER, password: PASSWORD, fetchImpl: f }))
      .toThrow(/ACUMATICA_ODATA_URL/)
    const err = (() => {
      try {
        createAcumaticaClient({ baseUrl: 'https://acu.example.com', user: USER, password: '', fetchImpl: f })
        return null
      } catch (e) { return e as Error }
    })()
    expect(err?.message).toMatch(/credentials/i)
    expect(err?.message).not.toContain(USER)
    expect(err?.message).not.toContain(PASSWORD)
  })
})

describe('createAcumaticaClient: query encoding', () => {
  it('encodes the feed name, which contains spaces', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage(PAYMENTS_FEED)
    expect(calls[0].url).toBe('https://acu.example.com/odata/AP-Checks%20and%20Payments')
  })

  it('strips a trailing slash from the base URL rather than doubling it', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage('X')
    expect(calls[0].url).toBe('https://acu.example.com/odata/X')
  })

  it('encodes $select, $filter, $orderby, $top and $skip', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage(PAYMENTS_FEED, {
      select: ['Type', 'ReferenceNbr', 'PaymentRef'],
      // OData v3 wants a datetime'...' literal; the quoting is load-bearing and
      // must survive encoding intact.
      filter: "LastModifiedOn gt datetime'2026-09-01T08:00:00'",
      orderby: 'LastModifiedOn desc',
      top: 2000,
      skip: 4000,
    })
    const url = calls[0].url
    expect(url).toContain('$select=Type%2CReferenceNbr%2CPaymentRef')
    expect(url).toContain("$filter=LastModifiedOn%20gt%20datetime'2026-09-01T08%3A00%3A00'")
    expect(url).toContain('$orderby=LastModifiedOn%20desc')
    expect(url).toContain('$top=2000')
    expect(url).toContain('$skip=4000')
  })

  it('omits the options the caller did not give', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchPage(PAYMENTS_FEED, { top: 10 })
    expect(calls[0].url).not.toContain('$filter')
    expect(calls[0].url).not.toContain('$select')
    expect(calls[0].url).not.toContain('$orderby')
    // $skip=0 is noise, not information.
    expect(calls[0].url).not.toContain('$skip')
  })

  it('exposes the payments feed and its field list so the sync does not retype them', () => {
    expect(PAYMENTS_FEED).toBe('AP-Checks and Payments')
    expect(PAYMENT_FIELDS).toEqual([
      'Type', 'ReferenceNbr', 'Vendor', 'VendorName', 'Status', 'PaymentDate',
      'Description', 'PaymentRef', 'PaymentAmount', 'Balance', 'Currency',
      'CashAccount', 'PaymentMethod', 'Branch', 'LastModifiedOn',
    ])
  })
})

describe('createAcumaticaClient: paging', () => {
  it('pages with $top/$skip and stops on the first short page', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(3) }, { body: page(3) }, { body: page(1) }])
    const rows = await client(fetchImpl).fetchAll(PAYMENTS_FEED, { pageSize: 3 })
    expect(rows).toHaveLength(7)
    expect(calls).toHaveLength(3)
    expect(calls[0].url).toContain('$top=3')
    expect(calls[0].url).not.toContain('$skip')
    expect(calls[1].url).toContain('$skip=3')
    expect(calls[2].url).toContain('$skip=6')
  })

  it('spends one extra empty request when the last page happens to be full', async () => {
    // Cheaper than trusting a server-side count, and it is the only way to know
    // a full-length page was the last one.
    const { calls, fetchImpl } = recorder([{ body: page(2) }, { body: page(2) }, { body: page(0) }])
    const rows = await client(fetchImpl).fetchAll(PAYMENTS_FEED, { pageSize: 2 })
    expect(rows).toHaveLength(4)
    expect(calls).toHaveLength(3)
  })

  it('defaults to a page size of 2000', async () => {
    // The AP feed runs to roughly 37,000 rows and some inquiries ignore $top
    // and stream the whole result, which kills the body read. Paging is not
    // optional and the default must not be "everything".
    const { calls, fetchImpl } = recorder([{ body: page(0) }])
    await client(fetchImpl).fetchAll(PAYMENTS_FEED)
    expect(calls[0].url).toContain('$top=2000')
  })

  it('carries $select and $filter onto every page', async () => {
    const { calls, fetchImpl } = recorder([{ body: page(2) }, { body: page(0) }])
    await client(fetchImpl).fetchAll(PAYMENTS_FEED, {
      pageSize: 2,
      select: ['ReferenceNbr'],
      filter: "Branch eq 'ST'",
    })
    for (const c of calls) {
      expect(c.url).toContain('$select=ReferenceNbr')
      expect(c.url).toContain("$filter=Branch%20eq%20'ST'")
    }
  })

  it('reports progress per page so a long run is not silent', async () => {
    const seen: number[] = []
    const { fetchImpl } = recorder([{ body: page(2) }, { body: page(1) }])
    await client(fetchImpl).fetchAll(PAYMENTS_FEED, { pageSize: 2, onPage: (_rows, total) => seen.push(total) })
    expect(seen).toEqual([2, 3])
  })
})

describe('createAcumaticaClient: bad responses', () => {
  it('throws naming the feed and the status on a non-OK response', async () => {
    const { fetchImpl } = recorder([{ ok: false, status: 500, body: 'boom' }])
    await expect(client(fetchImpl).fetchPage(PAYMENTS_FEED)).rejects.toThrow(
      'OData AP-Checks and Payments returned 500',
    )
  })

  it('throws naming the feed and the body LENGTH, never the body, on unparseable JSON', async () => {
    // A 500 page or a truncated response can carry vendor names and amounts.
    // The length is enough to tell "empty" from "an HTML error page" apart.
    const html = '<html><body>Gateway Timeout for HENKEL PHILIPPINES INC.</body></html>'
    const { fetchImpl } = recorder([{ body: html }])
    const err = await rejection(client(fetchImpl).fetchPage(PAYMENTS_FEED))
    expect(err.message).toBe(
      `OData AP-Checks and Payments returned unparseable JSON (${html.length} bytes)`,
    )
    expect(err.message).not.toContain('HENKEL')
    expect(`${err.stack ?? ''}`).not.toContain('HENKEL')
  })

  it('treats a response with no value array as an empty page rather than throwing', async () => {
    const { fetchImpl } = recorder([{ body: JSON.stringify({}) }])
    await expect(client(fetchImpl).fetchPage(PAYMENTS_FEED)).resolves.toEqual([])
  })
})
