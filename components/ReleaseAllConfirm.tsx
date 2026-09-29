'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import {
  releaseAllReadyAction, type BulkActionResult, type BulkOutcome,
} from '@/app/checks/bulk-actions'

/**
 * The second half of TODAY'S RELEASE: the button that actually hands the money
 * over, and the report of what happened to each cheque.
 *
 * **The confirmation is not this component.** Reaching this form at all means
 * the reader followed a link to `?confirm=release` and the SERVER re-rendered
 * the panel as a confirmation naming the count and the total. That step exists
 * before any JavaScript does, which is the point: a `confirm()` dialog on the
 * highest-risk action in the system is a control that is simply absent until
 * the bundle loads.
 *
 * **This is a client component only so the outcomes can be rendered.** The
 * server action is passed STRAIGHT to `useActionState` rather than through a
 * closure, so Next gives the form a real POST target and the release still
 * happens with scripts off — the per-cheque report is what needs hydration, not
 * the action.
 *
 * **`expectedCount` is the figure the reader just agreed to**, submitted back
 * so the server can refuse if more cheques became ready while the confirmation
 * sat open. Releasing 101 cheques on a confirmation that said 81 would mean the
 * figures agreed to were never the figures that moved.
 */
export type ReleaseNarrowing = { company: string; cashAccount: string; eligibility: string }

export function ReleaseAllConfirm({
  count, cancelHref, narrow,
}: {
  count: number
  cancelHref: string
  /** The TOTALS screen's filter, as validated ids; '' when not set. Written
   * back as hidden fields so the server releases the set the panel counted. */
  narrow: ReleaseNarrowing
}) {
  const [result, formAction, pending] = useActionState(releaseAllReadyAction, null)

  // A type predicate, not a bare `!o.ok`: TypeScript does not narrow a union
  // through Array.filter, and the refusal message lives only on the false arm.
  const failures = result?.ok
    ? result.outcomes.filter((o): o is Extract<BulkOutcome, { ok: false }> => !o.ok)
    : []

  // Once the action has answered, the form is spent: the set it was confirmed
  // against has moved. Offering the button again would invite a second release
  // over a count nobody re-read.
  const done: BulkActionResult | null = result

  return (
    <div className="mt-4">
      {!done && (
        <form action={formAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="confirm" value="release" />
          <input type="hidden" name="expectedCount" value={String(count)} />
          {narrow.company && <input type="hidden" name="company" value={narrow.company} />}
          {narrow.cashAccount && <input type="hidden" name="cashAccount" value={narrow.cashAccount} />}
          {narrow.eligibility && <input type="hidden" name="eligibility" value={narrow.eligibility} />}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-rose-700 px-5 py-2.5 text-sm font-semibold tracking-wide text-white shadow-sm transition hover:bg-rose-800 disabled:opacity-50"
          >
            {pending ? 'RELEASING…' : `YES — RELEASE ALL ${count}`}
          </button>
          <Link
            href={cancelHref}
            className="rounded-lg px-4 py-2.5 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-slate-300 transition hover:ring-slate-400"
          >
            CANCEL
          </Link>
        </form>
      )}

      {done && !done.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{done.message}</p>
      )}

      {done?.ok && (
        <div className="space-y-2">
          {done.succeeded > 0 && (
            <p className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-900">
              {done.succeeded} OF {done.outcomes.length} CHEQUE
              {done.outcomes.length === 1 ? '' : 'S'} RELEASED.
            </p>
          )}
          {/* Never a bare "73 of 81 released". Somebody is standing at a counter
              with the other eight in their hand and needs to know which. */}
          {failures.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">
                {failures.length} CHEQUE{failures.length === 1 ? ' WAS' : 'S WERE'} NOT RELEASED:
              </p>
              <ul className="mt-2 space-y-1">
                {failures.map((f) => (
                  <li key={f.checkId}>
                    <span className="font-medium">{f.checkNumber ?? f.checkId}</span>
                    {' — '}
                    {/* The domain's own sentence, passed through untouched. */}
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link
            href={cancelHref}
            className="inline-block text-xs font-medium tracking-wide text-slate-600 underline underline-offset-2"
          >
            BACK TO TODAY’S RELEASE
          </Link>
        </div>
      )}
    </div>
  )
}
