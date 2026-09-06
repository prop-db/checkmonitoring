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
    expect(r.filterDescription).toBe('No filters applied')
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
    expect(r.filterDescription).toBe('No filters applied')
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
      'COMPANY: STK  ·  BANK / CASH ACCOUNT: STK MAIN (BDO)  ·  ELIGIBILITY: SUPPLIER  ·  SEARCH: "henkel"',
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
