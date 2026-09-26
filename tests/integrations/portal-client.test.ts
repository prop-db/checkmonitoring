// tests/integrations/portal-client.test.ts
import { describe, it, expect } from 'vitest'
import { buildPortalEventBody, createPortalClient, manilaDay, PortalPayloadError, type CheckForPortal } from '@/lib/integrations/portal/client'

const bank = { bank: { code: 'BPI' } }
const check = (over: Partial<CheckForPortal> = {}): CheckForPortal => ({
  id: 'chk1', checkNumber: '6000353106', apvNumbers: ['AP-1001', 'AP-1002'], eligibility: 'SUPPLIER',
  availablePickupDate: new Date('2026-09-30T00:00:00Z'), releasedAt: null, orNumber: null, orDate: null,
  cashAccount: bank, checkBook: null,
  bills: [{ apvNumber: 'AP-1001', poNumber: 'PO-77' }, { apvNumber: 'AP-1002', poNumber: null }],
  ...over,
})

describe('manilaDay', () => {
  it('renders the Manila calendar day', () => {
    expect(manilaDay(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10-01')
    expect(manilaDay(new Date('2026-09-30T00:00:00Z'))).toBe('2026-09-30')
  })
})

describe('buildPortalEventBody', () => {
  it('MARK_AVAILABLE carries apvs, positional PO numbers, cheque number, bank and the pickup date', () => {
    expect(buildPortalEventBody({ id: 'ev1', kind: 'MARK_AVAILABLE' }, check())).toEqual({
      eventId: 'ev1', kind: 'MARK_AVAILABLE', apvs: ['AP-1001', 'AP-1002'], poNumbers: ['PO-77', ''],
      checkNo: '6000353106', bank: 'BPI', availablePickupDate: '2026-09-30',
    })
  })

  it('RELEASED carries the release day and receipt from the cheque as it stands', () => {
    const body = buildPortalEventBody({ id: 'ev2', kind: 'RELEASED' }, check({
      releasedAt: new Date('2026-10-02T02:00:00Z'), orNumber: 'OR-9', orDate: new Date('2026-10-02T00:00:00Z'),
    }))
    expect(body).toMatchObject({ kind: 'RELEASED', releaseDate: '2026-10-02', orNumber: 'OR-9', orDate: '2026-10-02' })
    expect(body).not.toHaveProperty('availablePickupDate')
  })

  it('RELEASE_REVERSED carries the pickup date; REVERT and CANCELLED carry no dates', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'RELEASE_REVERSED' }, check())).toMatchObject({ availablePickupDate: '2026-09-30' })
    for (const kind of ['REVERT', 'CANCELLED'] as const) {
      const b = buildPortalEventBody({ id: 'e', kind }, check())
      expect(b).not.toHaveProperty('availablePickupDate'); expect(b).not.toHaveProperty('releaseDate')
    }
  })

  it('takes the bank from the cheque book when there is no cash account, and blank when neither', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ cashAccount: null, checkBook: { bank: { code: 'MBTC' } } })).bank).toBe('MBTC')
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ cashAccount: null })).bank).toBe('')
  })

  it('falls back to the bills for APVs when apvNumbers is empty', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ apvNumbers: [] })).apvs).toEqual(['AP-1001', 'AP-1002'])
  })

  it('refuses an INTERNAL cheque before building anything', () => {
    expect(() => buildPortalEventBody({ id: 'e', kind: 'MARK_AVAILABLE' }, check({ eligibility: 'INTERNAL' })))
      .toThrow(/INTERNAL/)
    try {
      buildPortalEventBody({ id: 'e', kind: 'MARK_AVAILABLE' }, check({ eligibility: 'INTERNAL' }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('INTERNAL')
    }
  })

  it('MARK_AVAILABLE with no availablePickupDate throws PortalPayloadError MISSING_DATE', () => {
    try {
      buildPortalEventBody({ id: 'e', kind: 'MARK_AVAILABLE' }, check({ availablePickupDate: null }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('MISSING_DATE')
    }
  })

  it('RELEASED with no releasedAt throws PortalPayloadError MISSING_DATE', () => {
    try {
      buildPortalEventBody({ id: 'e', kind: 'RELEASED' }, check({ releasedAt: null }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('MISSING_DATE')
    }
  })

  it('RELEASE_REVERSED with no availablePickupDate throws PortalPayloadError MISSING_DATE', () => {
    try {
      buildPortalEventBody({ id: 'e', kind: 'RELEASE_REVERSED' }, check({ availablePickupDate: null }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('MISSING_DATE')
    }
  })

  it('REVERT and CANCELLED do not throw when both dates are null', () => {
    for (const kind of ['REVERT', 'CANCELLED'] as const) {
      expect(() => buildPortalEventBody({ id: 'e', kind }, check({ availablePickupDate: null, releasedAt: null }))).not.toThrow()
    }
  })
})

describe('createPortalClient', () => {
  it('POSTs JSON with the bearer to the events route and parses the reply', async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = []
    const client = createPortalClient({
      baseUrl: 'https://portal.test/', token: 'tok',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 200, text: async () => JSON.stringify({ eventId: 'ev1', replay: false, results: [], unmatched: ['AP-1001'] }) }
      },
    })
    const out = await client.deliver(buildPortalEventBody({ id: 'ev1', kind: 'REVERT' }, check()))
    expect(calls[0].url).toBe('https://portal.test/api/integrations/check-monitoring/events')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body).eventId).toBe('ev1')
    expect(out).toEqual({ status: 200, body: { eventId: 'ev1', replay: false, results: [], unmatched: ['AP-1001'] } })
  })

  it('returns the status with a null body when the reply is not JSON', async () => {
    const client = createPortalClient({ baseUrl: 'https://portal.test', token: 'tok',
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }) })
    expect(await client.deliver(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check()))).toEqual({ status: 502, body: null })
  })
})
