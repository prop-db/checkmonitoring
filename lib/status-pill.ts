import type { CheckStatus } from '@prisma/client'

/**
 * What colour a status pill is.
 *
 * Pure, and separated from the component that draws it so the map can be tested
 * for gaps: `Record<CheckStatus, string>` fails to compile the moment a ninth
 * status joins the enum without a colour, and the runtime test pins that the map
 * holds exactly the statuses the ladder has and no others.
 *
 * ── THE PALETTE (client, 2026-09-06) ──────────────────────────────────────
 * "Avoid saturated colours — the current pastel style is good." Every tone here
 * is a pale ground carrying dark ink, which is also what keeps a pill legible;
 * a saturated ground under dark text is not.
 *
 * Colour is never the only signal. The pill always spells the status out, so a
 * reader who cannot separate the greens from the ambers loses nothing — the
 * colour is there to let the eye skip to the rows that matter, not to carry the
 * meaning on its own.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The groupings are the ones Finance acts on, not a spectrum:
 *
 *   waiting on a person   SIGNATURE_PENDING          warning
 *   act on this today     READY_FOR_RELEASE          success
 *   in flight             SIGNED, SCHEDULED          cool, distinct from both
 *   over                  RELEASED                   muted — nothing to do
 *   gone wrong            CANCELLED, VOIDED          danger
 *
 * RELEASED is deliberately the quietest tone on the screen even though it is
 * the largest number: 9,545 cheques nobody will touch again must not out-shout
 * the 80 somebody has to hand over today.
 */
export const STATUS_PILL_CLASS: Record<CheckStatus, string> = {
  GENERATED:         'bg-slate-100 text-slate-700',
  SIGNATURE_PENDING: 'bg-warning-bg text-warning-ink',
  SIGNED:            'bg-navy-bg text-navy',
  READY_FOR_RELEASE: 'bg-success-bg text-success-ink',
  SCHEDULED:         'bg-indigo-50 text-indigo-900',
  RELEASED:          'bg-slate-200 text-slate-600',
  CANCELLED:         'bg-danger-bg text-danger-ink',
  VOIDED:            'bg-danger-bg text-danger-ink',
}

/**
 * The class for a status that arrived as a plain string.
 *
 * A row's status is typed, but this is also reached from the check detail page
 * and from the audit trail, where a status can be read back out of a stored
 * string. An unrecognised one gets the neutral pill rather than no pill: an
 * unstyled span reads as a rendering fault, and the status text itself is still
 * the thing being shown.
 */
export function statusPillClass(status: string): string {
  return STATUS_PILL_CLASS[status as CheckStatus] ?? STATUS_PILL_CLASS.GENERATED
}
