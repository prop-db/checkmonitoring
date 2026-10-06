import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { TODAYS_RELEASE_ANCHOR } from '@/lib/dashboard-view'
import type { TodaysRelease } from '@/lib/queries'
import { releaseAllReadyAction } from '@/app/checks/bulk-actions'
import { ConfirmAllForm, type ConfirmNarrowing } from './ConfirmAllForm'

/**
 * TODAY'S RELEASE — the answer to "what do I do today".
 *
 * It sits above the table and below the cards, and it is shown even when the
 * count is zero: a panel that disappears leaves the reader unable to tell "there
 * is nothing to release" from "the panel broke".
 *
 * **Every figure comes from `getTodaysRelease`.** Nothing here is a constant,
 * and the set is READY_FOR_RELEASE + SCHEDULED — the same pair the READY FOR
 * RELEASE card folds together, read from `viewStatusFilter` rather than restated
 * anywhere.
 *
 * **The total is per currency and never summed across currencies.** The count
 * and the totals are struck over ONE population, so they cannot disagree: the
 * cheques with no recorded amount are excluded from this panel exactly as they
 * are excluded from the card above it (client decision, 2026-09-06 — see
 * TODAYS_RELEASE_FILTER). The panel used to count them and leave them out of the
 * total, and said so in an amber note; that note is gone because the situation
 * it explained cannot arise any more. Six of production's 129 are
 * READY_FOR_RELEASE and are released one at a time from `/?incomplete=1`.
 */
export function TodaysReleasePanel({
  todays, canRelease, confirming, confirmHref, cancelHref, narrow,
}: {
  todays: TodaysRelease
  /** FINANCE_ADMIN. The server re-checks it; this only decides what is drawn. */
  canRelease: boolean
  /** The reader followed the confirm link and is on the second step. */
  confirming: boolean
  confirmHref: string
  cancelHref: string
  narrow: ConfirmNarrowing
}) {
  const { count, totalsByCurrency } = todays
  const nothingToDo = count === 0

  return (
    <section
      id={TODAYS_RELEASE_ANCHOR}
      className={`rounded-2xl p-6 ring-1 ${
        nothingToDo ? 'bg-white shadow-sm ring-hairline' : 'bg-gradient-to-br from-success-bg via-success-bg to-white shadow-sm ring-success-ink/25'
      }`}
    >
      <p className="text-xs font-semibold tracking-widest text-slate-600">TODAY’S RELEASE</p>

      {nothingToDo ? (
        // Stated plainly, and the panel still occupies its place. "Nothing is
        // ready" is an answer; an empty space is not.
        <p className="mt-2 text-sm text-slate-600">
          NOTHING IS READY TO RELEASE RIGHT NOW. Cheques appear here once they are marked
          READY FOR RELEASE.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-3">
            <div>
              <p className="text-3xl font-semibold text-slate-900">
                {count.toLocaleString('en-PH')}
              </p>
              <p className="text-xs font-medium tracking-wide text-slate-600">
                CHEQUE{count === 1 ? '' : 'S'} READY
              </p>
            </div>

            {/* One line per currency, never one summed figure: a PHP total and a
                CNY total are not the same unit. Production is PHP-only today;
                the rule is structural, not a reading of the current data. */}
            <dl className="space-y-1">
              {totalsByCurrency.map((t) => (
                <div key={t.currency} className="flex items-baseline gap-3">
                  <dt className="text-3xl font-semibold text-slate-900">
                    {/* A decimal string, formatted. Null renders as an em dash —
                        "no amount is known" is not "worth nothing". */}
                    {formatMoney(t.total, t.currency)}
                  </dt>
                  <dd className="text-xs font-medium tracking-wide text-slate-600">
                    {t.count.toLocaleString('en-PH')} {t.currency}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      )}

      {/* While confirming, the block stays mounted even once the count reaches
          zero: the action revalidates this page, and when every cheque was
          released the count IS zero — unmounting here would throw away the
          "N OF N RELEASED" report the reader is waiting for. */}
      {canRelease && (
        confirming ? (
          <div className="mt-4 rounded-xl bg-white p-4 ring-1 ring-rose-300">
            <ConfirmAllForm
              action={releaseAllReadyAction}
              confirm="release"
              count={count}
              cancelHref={cancelHref}
              narrow={narrow}
              labels={{ submit: 'RELEASE ALL', pending: 'RELEASING…', done: 'RELEASED', back: 'BACK TO TODAY’S RELEASE' }}
              tone="rose"
              prompt={
                <>
                  {/* The confirmation names the count AND the total, because those are
                      the two facts being agreed to. Rendered by the SERVER: reaching
                      this text required following a link, not a click that fired. */}
                  <p className="text-sm font-semibold text-rose-900">
                    RELEASE {count.toLocaleString('en-PH')} CHEQUE{count === 1 ? '' : 'S'}
                    {totalsByCurrency.length > 0 && ' — '}
                    {totalsByCurrency.map((t) => formatMoney(t.total, t.currency)).join(' + ')}?
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    This records that the cheques have been physically handed over. It cannot be undone:
                    the only status after RELEASED is VOIDED. Each cheque is checked on its own, and any
                    that cannot be released will be listed here by number.
                  </p>
                </>
              }
            />
          </div>
        ) : !nothingToDo && (
          // A link, not a submit. One click cannot release anything; it can only
          // ask for the confirmation above.
          <Link
            href={confirmHref}
            className="mt-4 inline-block rounded-lg bg-rose-700 px-5 py-2.5 text-sm font-semibold tracking-wide text-white shadow-sm transition hover:bg-rose-800"
          >
            RELEASE ALL {count.toLocaleString('en-PH')}
          </Link>
        )
      )}

      {!canRelease && !nothingToDo && (
        // Said rather than left blank. A Finance user who cannot find the button
        // should know it is a permission, not a fault.
        <p className="mt-4 text-xs font-medium tracking-wide text-slate-600">
          ONLY A FINANCE ADMIN CAN RECORD A RELEASE.
        </p>
      )}
    </section>
  )
}
