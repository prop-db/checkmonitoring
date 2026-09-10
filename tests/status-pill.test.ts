import { describe, it, expect } from 'vitest'
import { statusPillClass, STATUS_PILL_CLASS, voucherStatusPillClass, VOUCHER_STATUS_PILL_CLASS } from '@/lib/status-pill'
import { ALL_STATUSES } from '@/lib/queries'
import { CONTESTED, ALL_CANCELLED, NOT_KEYED } from '@/lib/export/voucher-index'

/**
 * Pure. The pill's colour is a lookup, so it is tested here rather than by
 * rendering a table and reading class names out of it.
 *
 * The client's note: "avoid saturated colours — the current pastel style is
 * good." Every tone below is a pastel ground with a dark ink, which is also
 * what keeps the text readable; a saturated ground with dark text is not.
 */

describe('statusPillClass', () => {
  // The failure this prevents is a new status rendering with no styling at all
  // — an unstyled pill reads as a rendering fault rather than as a status.
  it('has a colour for every status on the ladder, with no gaps', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_PILL_CLASS[status], status).toBeTruthy()
    }
    expect(Object.keys(STATUS_PILL_CLASS).sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('falls back to a neutral pill for a status it does not recognise', () => {
    // Never an empty string: an unrecognised status must still be legible.
    expect(statusPillClass('SOMETHING_NEW')).toBe(STATUS_PILL_CLASS.GENERATED)
  })

  /**
   * The client's diagnosis was that everything has the same weight. A table
   * where every pill is the same blue is that problem in miniature: the reader
   * has to read eleven words per screen to find the rows that matter.
   */
  it('does not paint every status the same', () => {
    const tones = new Set(Object.values(STATUS_PILL_CLASS))
    expect(tones.size).toBeGreaterThanOrEqual(5)
  })

  it('gives READY FOR RELEASE the success tone and the closed statuses their own', () => {
    // The one status that means "act on this today" must not share a colour
    // with the two that mean "this is over".
    expect(statusPillClass('READY_FOR_RELEASE')).toContain('success')
    expect(statusPillClass('CANCELLED')).toContain('danger')
    expect(statusPillClass('VOIDED')).toContain('danger')
    expect(statusPillClass('READY_FOR_RELEASE')).not.toBe(statusPillClass('RELEASED'))
  })

  it('warns on the statuses that are waiting on a person', () => {
    expect(statusPillClass('SIGNATURE_PENDING')).toContain('warning')
  })
})

/**
 * The voucher screen shows statuses AS WORDS — `READY FOR RELEASE` — because
 * the resolver has already spelled them out for the Excel index, and three of
 * them are not cheque statuses at all. This lookup answers for both kinds.
 */
describe('voucherStatusPillClass', () => {
  it('covers exactly the three statuses only the resolver produces', () => {
    expect(Object.keys(VOUCHER_STATUS_PILL_CLASS).sort())
      .toEqual([CONTESTED, ALL_CANCELLED, NOT_KEYED].sort())
  })

  it('paints a real status the colour the dashboard gives it, from its words', () => {
    expect(voucherStatusPillClass('READY FOR RELEASE')).toBe(statusPillClass('READY_FOR_RELEASE'))
    expect(voucherStatusPillClass('SIGNATURE PENDING')).toBe(statusPillClass('SIGNATURE_PENDING'))
  })

  it('warns on a contested or unkeyed voucher and marks all-cancelled as gone wrong', () => {
    expect(voucherStatusPillClass(CONTESTED)).toContain('warning')
    expect(voucherStatusPillClass(NOT_KEYED)).toContain('warning')
    expect(voucherStatusPillClass(ALL_CANCELLED)).toContain('danger')
  })
})
