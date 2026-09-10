import { describe, it, expect } from 'vitest'
import {
  VOUCHERS_PATH, VOUCHER_SCREEN_ROW_LIMIT, VOUCHER_STATUS_OPTIONS,
  parseVoucherStatusParam, filterByStatus, vouchersHref, describeVoucherView,
} from '@/lib/vouchers-view'
import { CONTESTED, ALL_CANCELLED, NOT_KEYED, type VoucherRow } from '@/lib/export/voucher-index'

/**
 * Pure. The page reads these and decides nothing itself, which is what lets
 * every decision on the screen be pinned here with literals.
 */
function row(overrides: Partial<VoucherRow> & { voucher: string }): VoucherRow {
  return {
    checkId: 'chk_0001',
    checkNumber: '6000353106',
    bank: 'BPI',
    company: 'STK',
    status: 'SIGNED',
    checkDate: new Date('2026-08-13'),
    payee: 'HENKEL PHILIPPINES INC.',
    releasedAt: null,
    supersedes: null,
    remarks: null,
    ...overrides,
  }
}

describe('the STATUS select', () => {
  it('offers every ladder status as words, then the three the resolver invents', () => {
    expect(VOUCHER_STATUS_OPTIONS).toContain('READY FOR RELEASE')
    expect(VOUCHER_STATUS_OPTIONS).not.toContain('READY_FOR_RELEASE')
    expect(VOUCHER_STATUS_OPTIONS.slice(-3)).toEqual([CONTESTED, ALL_CANCELLED, NOT_KEYED])
  })
})

describe('parseVoucherStatusParam', () => {
  it('accepts a status as words', () => {
    expect(parseVoucherStatusParam('READY FOR RELEASE')).toBe('READY FOR RELEASE')
  })

  it('accepts the underscore spelling and answers in words', () => {
    expect(parseVoucherStatusParam('READY_FOR_RELEASE')).toBe('READY FOR RELEASE')
  })

  it('accepts a synthetic status', () => {
    expect(parseVoucherStatusParam('NOT KEYED')).toBe(NOT_KEYED)
  })

  it('ignores anything it does not recognise, rather than filtering to nothing', () => {
    expect(parseVoucherStatusParam('DELIVERED')).toBeUndefined()
    expect(parseVoucherStatusParam('')).toBeUndefined()
    expect(parseVoucherStatusParam(undefined)).toBeUndefined()
  })
})

describe('filterByStatus', () => {
  const rows = [
    row({ voucher: 'AP-1', status: 'SIGNED' }),
    row({ voucher: 'AP-2', status: CONTESTED, checkId: null, checkNumber: null }),
    row({ voucher: 'AP-3', status: 'READY FOR RELEASE' }),
  ]

  it('keeps every row when no status is chosen', () => {
    expect(filterByStatus(rows, undefined)).toHaveLength(3)
  })

  it('narrows to a real status', () => {
    expect(filterByStatus(rows, 'SIGNED').map((r) => r.voucher)).toEqual(['AP-1'])
  })

  it('narrows to a synthetic status', () => {
    expect(filterByStatus(rows, CONTESTED).map((r) => r.voucher)).toEqual(['AP-2'])
  })
})

describe('vouchersHref', () => {
  it('is the bare path with nothing set', () => {
    expect(vouchersHref({})).toBe(VOUCHERS_PATH)
  })

  it('carries the search and the status, and drops an empty search', () => {
    expect(vouchersHref({ q: 'ST0426', status: CONTESTED })).toBe('/vouchers?q=ST0426&status=CONTESTED')
    expect(vouchersHref({ q: '   ', status: CONTESTED })).toBe('/vouchers?status=CONTESTED')
  })
})

describe('describeVoucherView', () => {
  it('states the count', () => {
    expect(describeVoucherView(1032, 200, undefined, undefined))
      .toBe('1,032 VOUCHERS · SHOWING FIRST 200 — narrow the search to see the rest')
  })

  it('says so when everything is shown', () => {
    expect(describeVoucherView(12, 12, 'ST0426', undefined)).toBe('12 VOUCHERS MATCHING "ST0426"')
  })

  it('names the status in force', () => {
    expect(describeVoucherView(6, 6, undefined, CONTESTED)).toBe('6 VOUCHERS WITH STATUS CONTESTED')
  })

  it('does not leave an empty result silent', () => {
    expect(describeVoucherView(0, 0, 'ZZZ', undefined)).toBe('NO VOUCHERS MATCHING "ZZZ"')
  })

  it('caps at 200', () => {
    expect(VOUCHER_SCREEN_ROW_LIMIT).toBe(200)
  })
})
