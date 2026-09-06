import { cardHref, isCardSelected, type DashboardSelection, type ViewCardId } from './dashboard-view'

/**
 * The release workflow, as five nodes with live counts.
 *
 * GENERATED → PENDING → SIGNED → READY → RELEASED, each showing how many
 * cheques are sitting on that rung and each linking to that view. It answers a
 * question the cards alone do not: not "how many are ready" but "where is the
 * queue jammed".
 *
 * Pure. No database, no query of its own — every count is read off the summary
 * the page has already fetched, and every link is `cardHref`, so a node cannot
 * disagree with the card that means the same thing.
 *
 * ── WHY GENERATED IS ITS OWN NODE ─────────────────────────────────────────
 * The PENDING SIGNATURE *card* counts GENERATED + SIGNATURE_PENDING together:
 * to Finance a freshly generated cheque is a cheque waiting to be signed, and
 * that card is unchanged.
 *
 * The timeline cannot fold them, because a node's number has to be the number
 * of rows its link opens, and `viewStatusFilter` gives `?status=SIGNATURE_PENDING`
 * exactly the SIGNATURE_PENDING rows. A node reading 242 over a table of 230 is
 * the same class of defect the READY FOR RELEASE / SCHEDULED fold exists to
 * avoid, pointing the other way.
 *
 * READY does fold SCHEDULED in — there, the card, the view and this node all
 * agree, because `viewStatusFilter` widens `?status=READY_FOR_RELEASE` to both.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Exactly the counts a timeline needs, so a caller cannot pass a filtered one by habit. */
export type TimelineSummary = {
  generated: number
  signaturePending: number
  signed: number
  readyForRelease: number
  scheduled: number
  released: number
}

/** A rung of the ladder. `id` is the view card it opens, never a status string. */
export type TimelineNode = {
  id: Extract<ViewCardId, 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED' | 'READY_FOR_RELEASE' | 'RELEASED'>
  label: string
  count: number
  href: string
  selected: boolean
}

export function buildReleaseTimeline(
  summary: TimelineSummary,
  selection: DashboardSelection,
): TimelineNode[] {
  const stages: readonly (readonly [TimelineNode['id'], string, number])[] = [
    ['GENERATED', 'GENERATED', summary.generated],
    ['SIGNATURE_PENDING', 'PENDING', summary.signaturePending],
    ['SIGNED', 'SIGNED', summary.signed],
    // The pair, exactly as the card and the view read it.
    ['READY_FOR_RELEASE', 'READY', summary.readyForRelease + summary.scheduled],
    ['RELEASED', 'RELEASED', summary.released],
  ]

  return stages.map(([id, label, count]) => ({
    id,
    label,
    count,
    // Both of these are the card's own functions, not a restatement: a lit node
    // links back to NEEDS ACTION so clicking it again turns it off, and the
    // narrowing filters are carried along, because that is what a card does.
    href: cardHref(id, selection),
    selected: isCardSelected(id, selection),
  }))
}
