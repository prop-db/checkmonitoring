import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { TODAYS_RELEASE_ANCHOR } from '@/lib/dashboard-view'
import type { TodaysRelease } from '@/lib/queries'
import { ReleaseAllConfirm } from './ReleaseAllConfirm'

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
 * **The total is per currency and the count is not.** A cheque with no recorded
 * amount is a real cheque that has to be handed over, so it is IN the count; it
 * has no figure to add, so it is absent from the total. That makes the two
 * numbers legitimately disagree, which is why the panel says so out loud when
 * any are present rather than leaving a reader to wonder which figure is wrong.
 */
export function TodaysReleasePanel({
  todays, canRelease, confirming, confirmHref, cancelHref,
}: {
  todays: TodaysRelease
  /** FINANCE_ADMIN. The server re-checks it; this only decides what is drawn. */
  canRelease: boolean
  /** The reader followed the confirm link and is on the second step. */
  confirming: boolean
  confirmHref: string
  cancelHref: string
}) {
  const { count, incomplete, totalsByCurrency } = todays
  const nothingToDo = count === 0

  return (
    <section
      id={TODAYS_RELEASE_ANCHOR}
      className={`rounded-2xl p-6 ring-1 ${
        nothingToDo ? 'bg-white ring-slate-200' : 'bg-emerald-50 ring-emerald-200'
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

          {incomplete > 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {incomplete} OF THESE {incomplete === 1 ? 'CHEQUE HAS' : 'CHEQUES HAVE'} NO RECORDED
              AMOUNT, so {incomplete === 1 ? 'it is' : 'they are'} counted above but absent from the
              total. The total is the value of the cheques whose amount is known.
            </p>
          )}
        </>
      )}

      {canRelease && !nothingToDo && (
        confirming ? (
          <div className="mt-4 rounded-xl bg-white p-4 ring-1 ring-rose-300">
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
            <ReleaseAllConfirm count={count} cancelHref={cancelHref} />
          </div>
        ) : (
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
