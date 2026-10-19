import { describe, it, expect } from 'vitest'
import { mapPortalRelease, createPortalReleasesReader } from '@/lib/integrations/portal/releases'

const raw = {
  domain: 'LOCAL', releaseId: 7, checkNumber: ' 6000354897 ', apvNumbers: ['ap-st045048'],
  releaseDate: '2026-10-19', releasedAt: '2026-10-19T02:30:00.000Z', orNumber: '4852', orDate: '2026-10-19',
  releasedByName: 'LUSIE', releasedByService: false, updatedAt: '2026-10-19T02:30:05.000Z',
}

describe('mapPortalRelease', () => {
  it('maps every field, trimming and upper-casing references', () => {
    expect(mapPortalRelease(raw)).toEqual({
      domain: 'LOCAL', releaseId: 7, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'],
      releaseDate: '2026-10-19', releasedAt: new Date('2026-10-19T02:30:00.000Z'), orNumber: '4852', orDate: '2026-10-19',
      releasedByName: 'LUSIE', releasedByService: false, updatedAt: new Date('2026-10-19T02:30:05.000Z'),
    })
  })
  it('missing optional values are null; a broker row keeps its domain', () => {
    const m = mapPortalRelease({ ...raw, domain: 'BROKER', releasedAt: null, orNumber: '', orDate: null, releaseDate: null })!
    expect(m).toMatchObject({ domain: 'BROKER', releasedAt: null, orNumber: null, orDate: null, releaseDate: null })
  })
  it('refuses a row without a check number, an updatedAt or a known domain', () => {
    expect(mapPortalRelease({ ...raw, checkNumber: '' })).toBeNull()
    expect(mapPortalRelease({ ...raw, updatedAt: 'x' })).toBeNull()
    expect(mapPortalRelease({ ...raw, domain: 'OTHER' })).toBeNull()
    expect(mapPortalRelease(null)).toBeNull()
  })
})

describe('createPortalReleasesReader', () => {
  it('GETs the endpoint with the bearer and since/limit, and maps the page', async () => {
    const calls: string[] = []
    const reader = createPortalReleasesReader({
      baseUrl: 'https://portal.test/', token: 'tok',
      fetchImpl: async (url, init) => {
        calls.push(`${init.method} ${url} ${init.headers.authorization}`)
        return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [raw, { bad: 1 }], next: '2026-10-19T02:30:05.000Z' }) }
      },
    })
    const page = await reader.list(new Date('2026-10-19T00:00:00Z'), 500)
    expect(calls).toEqual(['GET https://portal.test/api/integrations/check-monitoring/releases?since=2026-10-19T00%3A00%3A00.000Z&limit=500 Bearer tok'])
    expect(page.rows.map((r) => r.checkNumber)).toEqual(['6000354897'])
    expect(page.next).toEqual(new Date('2026-10-19T02:30:05.000Z'))
  })
  it('throws on a non-200 answer, naming the status', async () => {
    const reader = createPortalReleasesReader({ baseUrl: 'https://p', token: 't', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }) })
    await expect(reader.list(new Date(), 10)).rejects.toThrow(/401/)
  })
  it('keeps a page longer than the limit (rows tied on one millisecond)', async () => {
    const rows = [1, 2, 3].map((n) => ({ ...raw, releaseId: n, checkNumber: `600000000${n}` }))
    const reader = createPortalReleasesReader({
      baseUrl: 'https://p', token: 't',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ rows, next: null }) }),
    })
    const page = await reader.list(new Date(0), 2)
    expect(page.rows).toHaveLength(3)
    expect(page.next).toBeNull()
  })
})
