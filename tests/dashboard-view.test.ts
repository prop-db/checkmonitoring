import { describe, it, expect } from 'vitest'
import {
  isCardSelected, cardHref, clearFiltersHref, describeView, viewStatusFilter,
  releaseConfirmHref, releaseCancelHref, TODAYS_RELEASE_ANCHOR,
  type DashboardSelection,
} from '@/lib/dashboard-view'
import { LIVE_STATUSES } from '@/lib/domain/check-status'

/**
 * Pure. No database, no DOM, no browser.
 *
 * The summary cards are the dashboard's VIEW SELECTOR — which set of cheques
 * you are looking at — and the dropdowns narrow within the selected view. All
 * of that is URL arithmetic, so all of it is testable here rather than by
 * clicking around a rendered page.
 */

const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, base: {} }
const NARROWED: DashboardSelection = {
  ...NOTHING,
  base: { q: 'ACME', company: 'c1', cashAccount: 'a1', eligibility: 'ELIGIBLE' },
}

describe('the default view', () => {
  it('is NEEDS ACTION when no card is selected, not "everything"', () => {
    // 7,433 of 9,287 production cheques are RELEASED. A default of "everything"
    // buries the ~1,200 somebody has to act on today.
    expect(viewStatusFilter(NOTHING)).toEqual({ status: undefined, statusIn: LIVE_STATUSES })
  })

  it('names itself above the table so the scope is never a silent default', () => {
    expect(describeView(NOTHING)).toBe(
      'NEEDS ACTION — GENERATED, SIGNATURE PENDING, SIGNED, READY FOR RELEASE, SCHEDULED',
    )
  })

  it('lists exactly the live statuses, taken from the domain rather than restated', () => {
    for (const s of LIVE_STATUSES) expect(describeView(NOTHING)).toContain(s.replace(/_/g, ' '))
  })

  it('selects no view card', () => {
    for (const card of ['READY_FOR_RELEASE', 'SIGNATURE_PENDING', 'SIGNED', 'RELEASED', 'TOTAL_CHECKS'] as const) {
      expect(isCardSelected(card, NOTHING)).toBe(false)
    }
  })
})

describe('selecting a view', () => {
  it('writes the status and lights the card', () => {
    expect(cardHref('SIGNED', NOTHING)).toBe('/?status=SIGNED')
    expect(isCardSelected('SIGNED', { ...NOTHING, status: 'SIGNED' })).toBe(true)
  })

  it('filters to that status alone', () => {
    expect(viewStatusFilter({ ...NOTHING, status: 'SIGNED' }))
      .toEqual({ status: 'SIGNED', statusIn: undefined })
  })

  it('folds SCHEDULED into READY FOR RELEASE, so the card and the table agree', () => {
    // A card reading 406 that opens a table of 396 is a bug report waiting to
    // happen. The SCHEDULED status itself is untouched.
    expect(viewStatusFilter({ ...NOTHING, status: 'READY_FOR_RELEASE' }))
      .toEqual({ status: undefined, statusIn: ['READY_FOR_RELEASE', 'SCHEDULED'] })
    expect(describeView({ ...NOTHING, status: 'READY_FOR_RELEASE' }))
      .toBe('READY FOR RELEASE — INCLUDING SCHEDULED')
  })

  it('shows RELEASED without needing the all-cheques scope', () => {
    // RELEASED is excluded from the NEEDS ACTION default, and an explicit
    // status wins over that default — so the card opens a full table.
    expect(cardHref('RELEASED', NOTHING)).toBe('/?status=RELEASED')
    expect(viewStatusFilter({ ...NOTHING, status: 'RELEASED' }))
      .toEqual({ status: 'RELEASED', statusIn: undefined })
  })

  it('does not light one status card while another is the view', () => {
    expect(isCardSelected('SIGNED', { ...NOTHING, status: 'RELEASED' })).toBe(false)
  })
})

describe('deselecting a view', () => {
  it('returns to NEEDS ACTION rather than to everything', () => {
    expect(cardHref('SIGNED', { ...NOTHING, status: 'SIGNED' })).toBe('/')
    expect(cardHref('READY_FOR_RELEASE', { ...NOTHING, status: 'READY_FOR_RELEASE' })).toBe('/')
    expect(cardHref('RELEASED', { ...NOTHING, status: 'RELEASED' })).toBe('/')
  })

  it('keeps the narrowing filters, which are not part of the view', () => {
    expect(cardHref('SIGNED', { ...NARROWED, status: 'SIGNED' }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE')
  })
})

describe('the narrowing filters survive a change of view', () => {
  it('carries the search, company, bank and eligibility into the selected view', () => {
    expect(cardHref('SIGNED', NARROWED))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED')
  })

  it('carries them from one view straight to another', () => {
    expect(cardHref('RELEASED', { ...NARROWED, status: 'SIGNED' }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=RELEASED')
  })
})

describe('TOTAL CHECKS', () => {
  it('shows every status', () => {
    expect(viewStatusFilter({ ...NOTHING, showAll: true }))
      .toEqual({ status: undefined, statusIn: undefined })
    expect(describeView({ ...NOTHING, showAll: true }))
      .toBe('ALL CHEQUES — EVERY STATUS, INCLUDING RELEASED, CANCELLED AND VOIDED')
  })

  it('clears every filter: the search, the dropdowns, the incomplete toggle and any status', () => {
    const messy: DashboardSelection = { ...NARROWED, status: 'SIGNED', incomplete: true }
    expect(cardHref('TOTAL_CHECKS', messy)).toBe('/?scope=all')
  })

  it('is selected only when it is the view, never beside a status card', () => {
    expect(isCardSelected('TOTAL_CHECKS', { ...NOTHING, showAll: true })).toBe(true)
    expect(isCardSelected('TOTAL_CHECKS', { ...NOTHING, showAll: true, status: 'SIGNED' })).toBe(false)
  })

  it('goes back to NEEDS ACTION when clicked again', () => {
    expect(cardHref('TOTAL_CHECKS', { ...NOTHING, showAll: true })).toBe('/')
  })
})

describe('INCOMPLETE (NO AMOUNT) is a toggle, not a view', () => {
  it('composes with the view instead of replacing it', () => {
    // The 129 cheques with no recorded amount cut across every status
    // (50 SIGNATURE_PENDING, 48 CANCELLED, 25 RELEASED, 6 READY_FOR_RELEASE),
    // so SIGNED + INCOMPLETE has to mean "signed cheques with no amount".
    expect(cardHref('INCOMPLETE', { ...NOTHING, status: 'SIGNED' }))
      .toBe('/?status=SIGNED&incomplete=1')
  })

  it('leaves the status filter of the view alone', () => {
    const both: DashboardSelection = { ...NOTHING, status: 'SIGNED', incomplete: true }
    expect(viewStatusFilter(both)).toEqual({ status: 'SIGNED', statusIn: undefined })
  })

  it('lights both cards when both are on, and says so above the table', () => {
    const both: DashboardSelection = { ...NOTHING, status: 'SIGNED', incomplete: true }
    expect(isCardSelected('SIGNED', both)).toBe(true)
    expect(isCardSelected('INCOMPLETE', both)).toBe(true)
    expect(describeView(both)).toBe('SIGNED + INCOMPLETE (NO AMOUNT)')
  })

  it('turns off without disturbing the view', () => {
    expect(cardHref('INCOMPLETE', { ...NARROWED, status: 'SIGNED', incomplete: true }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED')
  })

  it('survives a change of view, because it is independent of one', () => {
    expect(cardHref('RELEASED', { ...NOTHING, status: 'SIGNED', incomplete: true }))
      .toBe('/?status=RELEASED&incomplete=1')
    expect(cardHref('SIGNED', { ...NOTHING, status: 'SIGNED', incomplete: true }))
      .toBe('/?incomplete=1')
  })

  it('composes with the all-cheques view too', () => {
    expect(cardHref('INCOMPLETE', { ...NOTHING, showAll: true })).toBe('/?scope=all&incomplete=1')
  })
})

describe('CLEAR FILTERS', () => {
  it('drops the narrowing filters and keeps the view being read', () => {
    expect(clearFiltersHref({ ...NARROWED, status: 'SIGNED', incomplete: true })).toBe('/?status=SIGNED')
    expect(clearFiltersHref({ ...NARROWED, showAll: true })).toBe('/?scope=all')
    expect(clearFiltersHref(NARROWED)).toBe('/')
  })
})

/**
 * TODAY'S RELEASE puts its confirmation in the URL rather than in a `confirm()`
 * dialog, so the step exists before any JavaScript does — on the one action in
 * the system that hands money over.
 */
describe('the RELEASE ALL confirmation step', () => {
  it('adds confirm=release and lands on the panel', () => {
    expect(releaseConfirmHref(NOTHING)).toBe(`/?confirm=release#${TODAYS_RELEASE_ANCHOR}`)
  })

  it('carries the view and the narrowing filters, so cancelling returns you where you were', () => {
    const sel: DashboardSelection = { ...NARROWED, status: 'SIGNED', incomplete: true }
    expect(releaseConfirmHref(sel)).toBe(
      '/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&incomplete=1' +
      `&confirm=release#${TODAYS_RELEASE_ANCHOR}`,
    )
    expect(releaseCancelHref(sel)).toBe(
      '/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&incomplete=1' +
      `#${TODAYS_RELEASE_ANCHOR}`,
    )
  })

  /**
   * The confirmation must not survive a click on anything else. A `confirm=release`
   * left in the URL by a card link would put a half-made release back on screen
   * after the user had visibly moved on from it.
   */
  it('is dropped by every other control', () => {
    const confirming: DashboardSelection = { ...NARROWED, status: 'SIGNED' }
    for (const url of [
      cardHref('SIGNED', confirming),
      cardHref('TOTAL_CHECKS', confirming),
      cardHref('INCOMPLETE', confirming),
      clearFiltersHref(confirming),
    ]) {
      expect(url).not.toContain('confirm=')
    }
  })
})
