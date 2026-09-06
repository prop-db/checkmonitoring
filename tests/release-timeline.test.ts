import { describe, it, expect } from 'vitest'
import { buildReleaseTimeline, type TimelineSummary } from '@/lib/release-timeline'
import { cardHref, type DashboardSelection } from '@/lib/dashboard-view'

/**
 * Pure. The workflow timeline is five counts and five links, so it is decided
 * here and tested without rendering anything — the same reasoning that put the
 * card arithmetic in lib/dashboard-view.ts.
 */

const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, base: {} }

// Production, 2026-09-06, as the brief states it: 242 pending signature,
// 1,034 signed, 80 ready, 9,545 released.
const SUMMARY: TimelineSummary = {
  generated: 12,
  signaturePending: 230,
  signed: 1034,
  readyForRelease: 74,
  scheduled: 6,
  released: 9545,
}

describe('buildReleaseTimeline', () => {
  it('walks the ladder in order, so a reader sees where cheques are stuck', () => {
    expect(buildReleaseTimeline(SUMMARY, NOTHING).map((n) => n.label))
      .toEqual(['GENERATED', 'PENDING', 'SIGNED', 'READY', 'RELEASED'])
  })

  it('takes every count from the summary rather than from a query of its own', () => {
    const counts = Object.fromEntries(
      buildReleaseTimeline(SUMMARY, NOTHING).map((n) => [n.id, n.count]),
    )
    expect(counts).toEqual({
      GENERATED: 12,
      SIGNATURE_PENDING: 230,
      SIGNED: 1034,
      // READY folds SCHEDULED in, exactly as the card and the view do: to
      // Finance the cheque is available and waiting to be handed over.
      READY_FOR_RELEASE: 80,
      RELEASED: 9545,
    })
  })

  /**
   * The number on a node has to be the number of rows its link opens.
   *
   * This is why GENERATED is a node of its own rather than folded into PENDING
   * the way the summary card folds it: `viewStatusFilter` gives
   * `?status=SIGNATURE_PENDING` exactly the SIGNATURE_PENDING rows, so a node
   * reading 242 over a table of 230 would be a bug report waiting to happen.
   */
  it('splits GENERATED from PENDING so each node counts precisely what its link opens', () => {
    const nodes = buildReleaseTimeline(SUMMARY, NOTHING)
    const generated = nodes[0]
    const pending = nodes[1]
    expect(generated.count + pending.count).toBe(242)
    expect(generated.href).toBe('/?status=GENERATED')
    expect(pending.href).toBe('/?status=SIGNATURE_PENDING')
  })

  it('links each node exactly where the matching card links, filters and all', () => {
    const narrowed: DashboardSelection = {
      status: 'SIGNED', showAll: false, incomplete: true,
      base: { q: 'ACME', company: 'c1' },
    }
    for (const node of buildReleaseTimeline(SUMMARY, narrowed)) {
      expect(node.href, node.id).toBe(cardHref(node.id, narrowed))
    }
  })

  it('lights the node the table is currently showing', () => {
    const onSigned: DashboardSelection = { ...NOTHING, status: 'SIGNED' }
    const lit = buildReleaseTimeline(SUMMARY, onSigned).filter((n) => n.selected)
    expect(lit.map((n) => n.id)).toEqual(['SIGNED'])
  })

  it('lights READY while the table is showing a SCHEDULED cheque', () => {
    const onReady: DashboardSelection = { ...NOTHING, status: 'READY_FOR_RELEASE' }
    const lit = buildReleaseTimeline(SUMMARY, onReady).filter((n) => n.selected)
    expect(lit.map((n) => n.id)).toEqual(['READY_FOR_RELEASE'])
  })

  it('lights nothing on the default NEEDS ACTION view', () => {
    expect(buildReleaseTimeline(SUMMARY, NOTHING).every((n) => !n.selected)).toBe(true)
  })

  it('turns a lit node off again, rather than stranding the reader in a view', () => {
    const onSigned: DashboardSelection = { ...NOTHING, status: 'SIGNED' }
    const signed = buildReleaseTimeline(SUMMARY, onSigned).find((n) => n.id === 'SIGNED')
    expect(signed?.href).toBe('/')
  })
})
