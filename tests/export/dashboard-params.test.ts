import { describe, it, expect } from 'vitest'
import { resolveDashboardQuery } from '@/lib/dashboard-params'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import type { FilterOptions } from '@/lib/queries'

const options: FilterOptions = {
  companies: [
    { id: 'co-stk', code: 'STK', name: 'Starkson Packaging Inc.' },
    { id: 'co-a1', code: 'A1+', name: 'A1 Plus' },
  ],
  cashAccounts: [
    { id: 'ca-bpi', code: 'BPI STK', bankCode: 'BPI' },
    { id: 'ca-main', code: 'STK MAIN', bankCode: 'BDO' },
  ],
}

describe('resolveDashboardQuery', () => {
  it('defaults to NEEDS ACTION with nothing narrowing it', () => {
    const r = resolveDashboardQuery({}, options)
    expect(r.filters.statusIn).toEqual(LIVE_STATUSES)
    expect(r.filters.status).toBeUndefined()
    expect(r.selection).toEqual({ status: null, showAll: false, incomplete: false, base: {} })
    expect(r.viewLabel).toBe('NEEDS ACTION')
    /**
     * SUPERSEDED BY A CLIENT DECISION, 2026-09-06: this was 'No filters
     * applied'. The default view now EXCLUDES the 129 cheques with no recorded
     * amount, so the export's title block has something to declare even when the
     * reader has touched nothing. `filters.incomplete` is `false`, not
     * `undefined` — the tri-state's "exclude", not its "do not filter".
     */
    expect(r.filters.incomplete).toBe(false)
    expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
  })

  it('folds SCHEDULED into the READY FOR RELEASE view', () => {
    const r = resolveDashboardQuery({ status: 'READY_FOR_RELEASE' }, options)
    expect(r.filters.statusIn).toEqual(['READY_FOR_RELEASE', 'SCHEDULED'])
    expect(r.viewLabel).toBe('READY FOR RELEASE')
  })

  it('opens every status for scope=all', () => {
    const r = resolveDashboardQuery({ scope: 'all' }, options)
    expect(r.filters.status).toBeUndefined()
    expect(r.filters.statusIn).toBeUndefined()
    expect(r.viewLabel).toBe('ALL CHEQUES')
  })

  // The parsers answer `undefined` for anything they do not recognise, which
  // buildWhere reads as "do not filter". A stale bookmark must open the
  // dashboard unfiltered, never hand Prisma an invalid enum value.
  it('drops an unrecognised status, company, cash account and eligibility', () => {
    const r = resolveDashboardQuery({
      status: 'DELETED', company: 'co-gone', cashAccount: 'ca-gone', eligibility: 'MAYBE',
    }, options)
    expect(r.filters.status).toBeUndefined()
    expect(r.filters.companyId).toBeUndefined()
    expect(r.filters.cashAccountId).toBeUndefined()
    expect(r.filters.eligibility).toBeUndefined()
    // Dropped from the carried-forward filters too, not only from the query.
    expect(r.selection.base).toEqual({})
    // The one thing left to declare is the default exclusion — see above.
    expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
  })

  it('resolves a company and cash account to the labels a reader recognises', () => {
    const r = resolveDashboardQuery(
      { company: 'co-stk', cashAccount: 'ca-main', eligibility: 'SUPPLIER', q: '  henkel  ' },
      options,
    )
    expect(r.filters.companyId).toBe('co-stk')
    expect(r.filters.cashAccountId).toBe('ca-main')
    expect(r.filters.q).toBe('henkel')
    expect(r.filterDescription).toBe(
      'COMPANY: STK  ·  BANK / CASH ACCOUNT: STK MAIN (BDO)  ·  ELIGIBILITY: SUPPLIER  ·  SEARCH: "henkel"'
      + '  ·  EXCLUDES RECORDS WITH NO AMOUNT',
    )
  })

  it('turns the incomplete toggle on only for the exact value the checkbox submits', () => {
    expect(resolveDashboardQuery({ incomplete: '1' }, options).filters.incomplete).toBe(true)
    expect(resolveDashboardQuery({ incomplete: 'true' }, options).filters.incomplete).toBe(false)
    expect(resolveDashboardQuery({ incomplete: '0' }, options).filters.incomplete).toBe(false)
  })

  it('leaves an empty search out of the query rather than filtering on nothing', () => {
    expect(resolveDashboardQuery({ q: '   ' }, options).filters.q).toBeUndefined()
    expect(resolveDashboardQuery({ q: '   ' }, options).q).toBe('')
  })

  it('carries the narrowing filters, but not the view, in `base`', () => {
    const r = resolveDashboardQuery(
      { q: 'henkel', company: 'co-stk', status: 'SIGNED', scope: 'all', incomplete: '1' },
      options,
    )
    expect(r.selection.base).toEqual({ q: 'henkel', company: 'co-stk' })
    expect(r.selection.status).toBe('SIGNED')
    expect(r.selection.showAll).toBe(true)
    expect(r.selection.incomplete).toBe(true)
  })

  /**
   * DATE RELEASED. Honoured on the two views that can contain a released
   * cheque — RELEASED and ALL CHEQUES — and dropped everywhere else exactly as
   * an unrecognised company id is: a live cheque has no release instant, and a
   * range on SIGNED could only empty the table without saying why.
   */
  describe('the DATE RELEASED range', () => {
    it('becomes inclusive Manila-day bounds on the RELEASED view, and rides in `base`', () => {
      const r = resolveDashboardQuery(
        { status: 'RELEASED', releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
        options,
      )
      expect(r.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(r.filters.releasedTo).toEqual(new Date('2026-09-15T15:59:59.999Z'))
      expect(r.releasedFrom).toBe('2026-09-01')
      expect(r.releasedTo).toBe('2026-09-15')
      expect(r.selection.base).toEqual({ releasedFrom: '2026-09-01', releasedTo: '2026-09-15' })
      expect(r.filterDescription).toBe('DATE RELEASED: 2026-09-01 TO 2026-09-15  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })

    it('accepts either bound alone', () => {
      const from = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: '2026-09-01' }, options)
      expect(from.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(from.filters.releasedTo).toBeUndefined()
      expect(from.selection.base).toEqual({ releasedFrom: '2026-09-01' })

      const to = resolveDashboardQuery({ status: 'RELEASED', releasedTo: '2026-09-15' }, options)
      expect(to.filters.releasedFrom).toBeUndefined()
      expect(to.filters.releasedTo).toEqual(new Date('2026-09-15T15:59:59.999Z'))
      expect(to.selection.base).toEqual({ releasedTo: '2026-09-15' })
    })

    it('applies on ALL CHEQUES too', () => {
      const r = resolveDashboardQuery({ scope: 'all', releasedFrom: '2026-09-01' }, options)
      expect(r.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(r.selection.base).toEqual({ releasedFrom: '2026-09-01' })
    })

    it('is dropped — from the filters, `base` and the description — on every other view', () => {
      for (const params of [
        { releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },                       // NEEDS ACTION
        { status: 'SIGNED', releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
        { status: 'READY_FOR_RELEASE', releasedFrom: '2026-09-01' },
        { status: 'SIGNATURE_PENDING', releasedTo: '2026-09-15' },
      ]) {
        const r = resolveDashboardQuery(params, options)
        expect(r.filters.releasedFrom).toBeUndefined()
        expect(r.filters.releasedTo).toBeUndefined()
        expect(r.releasedFrom).toBe('')
        expect(r.releasedTo).toBe('')
        expect(r.selection.base).toEqual({})
        expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
      }
    })

    // A hand-edited or half-typed value opens the view unfiltered, never a 500
    // — the same contract every other parameter on this URL has.
    it('ignores a value that is not a real calendar day', () => {
      for (const bad of ['2026-02-30', '25/09/2026', '2026-9-1', 'today', '']) {
        const r = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: bad, releasedTo: bad }, options)
        expect(r.filters.releasedFrom).toBeUndefined()
        expect(r.filters.releasedTo).toBeUndefined()
        expect(r.selection.base).toEqual({})
      }
    })

    // Not swapped: the honest answer to a backwards question is an empty table,
    // and the title block says what was asked.
    it('keeps FROM after TO as given rather than swapping them', () => {
      const r = resolveDashboardQuery(
        { status: 'RELEASED', releasedFrom: '2026-09-15', releasedTo: '2026-09-01' },
        options,
      )
      expect(r.filters.releasedFrom).toEqual(new Date('2026-09-14T16:00:00.000Z'))
      expect(r.filters.releasedTo).toEqual(new Date('2026-09-01T15:59:59.999Z'))
      expect(r.filterDescription).toBe('DATE RELEASED: 2026-09-15 TO 2026-09-01  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })
  })

  // The URL parameters `URLSearchParams` hands back are strings or null; the
  // page's own searchParams give strings or undefined. One resolver takes both.
  it('reads a URLSearchParams as readily as a plain object', () => {
    const sp = new URLSearchParams('status=SIGNED&company=co-stk&incomplete=1')
    const r = resolveDashboardQuery(
      {
        status: sp.get('status') ?? undefined,
        company: sp.get('company') ?? undefined,
        incomplete: sp.get('incomplete') ?? undefined,
      },
      options,
    )
    expect(r.filters.status).toBe('SIGNED')
    expect(r.filters.companyId).toBe('co-stk')
    expect(r.filters.incomplete).toBe(true)
  })
})
