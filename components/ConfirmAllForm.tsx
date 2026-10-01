'use client'

import Link from 'next/link'
import { useActionState, type ReactNode } from 'react'
import type { BulkActionResult, BulkOutcome } from '@/lib/bulk-run'

export type ConfirmNarrowing = { company: string; cashAccount: string; eligibility: string }

/**
 * The second half of a server-confirmed "ALL" action — RELEASE ALL on TODAY'S
 * RELEASE and SIGN ALL on the SIGNATURE PENDING list: the button that actually
 * moves the cheques, and the report of what happened to each one.
 *
 * **The confirmation is not this component.** Reaching this form at all means
 * the reader followed a link to `?confirm=release` (or `=sign`) and the SERVER
 * re-rendered the page as a confirmation naming the count and the total. That
 * step exists before any JavaScript does, which is the point: a `confirm()`
 * dialog on the highest-risk action in the system is a control that is simply
 * absent until the bundle loads.
 *
 * **This is a client component only so the outcomes can be rendered.** The
 * server action arrives as a prop and is passed STRAIGHT to `useActionState`
 * rather than through a closure, so Next gives the form a real POST target and
 * the action still runs with scripts off — the per-cheque report is what needs
 * hydration, not the action.
 *
 * **`expectedCount` is the figure the reader just agreed to**, submitted back
 * so the server can refuse if more cheques joined the set while the
 * confirmation sat open. Releasing 101 cheques on a confirmation that said 81
 * would mean the figures agreed to were never the figures that moved.
 *
 * **The prompt ("RELEASE 81 CHEQUES — …?") is shown only while the form is
 * unspent.** The action revalidates `/`, so the page re-renders under the
 * report with the NEW count: beside "73 OF 81 RELEASED" a heading asking
 * "RELEASE 8 CHEQUES?" contradicts it, and when everything moved the count is
 * zero. The parent keeps this component mounted while `?confirm=` is on the URL
 * so the report survives that re-render.
 */
export function ConfirmAllForm({
  action, confirm, count, cancelHref, narrow, columnParams, prompt, labels, tone,
}: {
  /** `releaseAllReadyAction` or `signAllPendingAction`, passed through untouched. */
  action: (prev: BulkActionResult | null, formData: FormData) => Promise<BulkActionResult>
  confirm: 'release' | 'sign'
  count: number
  cancelHref: string
  /** The narrowing on screen (company, bank, eligibility), as validated ids;
   * '' when not set. Written back as hidden fields so the server acts on the
   * set the page counted. */
  narrow: ConfirmNarrowing
  /** SIGN ALL only: the filter row's `f.*` boxes on screen, re-parsed by the server. */
  columnParams?: Readonly<Record<string, string>>
  /** The confirmation heading and any explanation; hidden once the form is spent. */
  prompt: ReactNode
  labels: {
    /** e.g. 'RELEASE ALL' — the button reads "YES — RELEASE ALL 81". */
    submit: string
    pending: string
    /** Past tense, e.g. 'RELEASED'. */
    done: string
    back: string
  }
  tone: 'rose' | 'navy'
}) {
  const [result, formAction, pending] = useActionState(action, null)

  // A type predicate, not a bare `!o.ok`: TypeScript does not narrow a union
  // through Array.filter, and the refusal message lives only on the false arm.
  const failures = result?.ok
    ? result.outcomes.filter((o): o is Extract<BulkOutcome, { ok: false }> => !o.ok)
    : []

  // Once the action has answered, the form is spent: the set it was confirmed
  // against has moved. Offering the button again would invite a second run
  // over a count nobody re-read.
  const done: BulkActionResult | null = result

  const buttonTone = tone === 'rose' ? 'bg-rose-700 hover:bg-rose-800' : 'bg-navy hover:bg-navy/90'

  return (
    <>
      {!done && count > 0 && prompt}
      <div className="mt-4">
        {!done && count > 0 && (
          <form action={formAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="confirm" value={confirm} />
            <input type="hidden" name="expectedCount" value={String(count)} />
            {narrow.company && <input type="hidden" name="company" value={narrow.company} />}
            {narrow.cashAccount && <input type="hidden" name="cashAccount" value={narrow.cashAccount} />}
            {narrow.eligibility && <input type="hidden" name="eligibility" value={narrow.eligibility} />}
            {Object.entries(columnParams ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <button
              type="submit"
              disabled={pending}
              className={`rounded-lg px-5 py-2.5 text-sm font-semibold tracking-wide text-white shadow-sm transition disabled:opacity-50 ${buttonTone}`}
            >
              {pending ? labels.pending : `YES — ${labels.submit} ${count.toLocaleString('en-PH')}`}
            </button>
            <Link
              href={cancelHref}
              className="rounded-lg px-4 py-2.5 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-slate-300 transition hover:ring-slate-400"
            >
              CANCEL
            </Link>
          </form>
        )}

        {/* Nothing left to confirm and nothing done here — a stale ?confirm= URL. */}
        {!done && count === 0 && (
          <Link
            href={cancelHref}
            className="inline-block text-xs font-medium tracking-wide text-slate-600 underline underline-offset-2"
          >
            {labels.back}
          </Link>
        )}

        {done && !done.ok && (
          <div className="space-y-2">
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{done.message}</p>
            {/* The form is spent after a refusal too; without this the reader is
                left on a confirmation with no button and no way back. */}
            <Link
              href={cancelHref}
              className="inline-block text-xs font-medium tracking-wide text-slate-600 underline underline-offset-2"
            >
              {labels.back}
            </Link>
          </div>
        )}

        {done?.ok && (
          <div className="space-y-2">
            {done.succeeded > 0 && (
              <p className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-900">
                {done.succeeded} OF {done.outcomes.length} CHEQUE
                {done.outcomes.length === 1 ? '' : 'S'} {labels.done}.
              </p>
            )}
            {/* Never a bare "73 of 81 released". Somebody is standing at a counter
                with the other eight in their hand and needs to know which. */}
            {failures.length > 0 && (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">
                  {failures.length} CHEQUE{failures.length === 1 ? ' WAS' : 'S WERE'} NOT {labels.done}:
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
              {labels.back}
            </Link>
          </div>
        )}
      </div>
    </>
  )
}
