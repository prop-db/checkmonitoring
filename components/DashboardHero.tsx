import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { TODAYS_RELEASE_ANCHOR } from '@/lib/dashboard-view'
import type { TodaysRelease } from '@/lib/queries'

/**
 * The banner the TOTALS screen opens with, and the ONE place READY FOR RELEASE
 * is shown (2026-10-07: "this looks redundant", then "it looks boring again").
 *
 * A greeting, the day's job — how many cheques are ready to hand over and what
 * they are worth — and its two actions: open the list, or RELEASE ALL (a link
 * to the confirmation, never a submit). The other stages are the cards below
 * (components/WorkflowRow.tsx); no figure here repeats there. Money is per
 * currency, never summed, from decimal strings (rule 8).
 */
const MANILA = 'Asia/Manila'

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: MANILA }).format(now)) % 24
  return hour < 12 ? 'GOOD MORNING' : hour < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'
}

/** A cheque, drawn: decoration only. */
function ChequeArt() {
  return (
    <svg aria-hidden="true" viewBox="0 0 260 150" className="h-auto w-full max-w-[300px] drop-shadow-xl" fill="none">
      <g transform="rotate(-6 130 75)">
        <rect x="14" y="22" width="232" height="112" rx="12" fill="white" fillOpacity="0.14" stroke="white" strokeOpacity="0.35" />
      </g>
      <rect x="8" y="14" width="232" height="112" rx="12" fill="white" />
      <rect x="8" y="14" width="232" height="22" rx="12" fill="#DFF5E8" />
      <rect x="8" y="26" width="232" height="10" fill="#DFF5E8" />
      <text x="22" y="30" fontSize="9" fontWeight="700" fill="#166534" letterSpacing="1.5">READY FOR RELEASE</text>
      <rect x="22" y="50" width="96" height="6" rx="3" fill="#CBD5E1" />
      <rect x="22" y="64" width="140" height="6" rx="3" fill="#E2E8F0" />
      <rect x="164" y="48" width="62" height="20" rx="5" fill="#E8EEF5" />
      <text x="195" y="62" fontSize="10" fontWeight="700" fill="#1E3A5F" textAnchor="middle">₱ ✓</text>
      <path d="M22 104c14-10 22 6 34-4s18 2 28-3" stroke="#1E3A5F" strokeWidth="2" strokeLinecap="round" />
      <path d="M150 108h76" stroke="#94A3B8" strokeWidth="1.5" />
      <circle cx="214" cy="96" r="13" fill="#166534" />
      <path d="M208 96l4 4 8-8" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function DashboardHero({
  name, todays, readyHref, canRelease, confirming, confirmHref, now = new Date(),
}: {
  name: string
  /** READY_FOR_RELEASE + SCHEDULED, complete: the count and the money of one set. */
  todays: TodaysRelease
  readyHref: string
  /** FINANCE_ADMIN. The server re-checks it; this only decides what is drawn. */
  canRelease: boolean
  /** On the confirmation step, drawn below the cards; the button is hidden here. */
  confirming: boolean
  confirmHref: string
  now?: Date
}) {
  const first = name.trim().split(/\s+/)[0] || name
  const today = new Intl.DateTimeFormat('en-PH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: MANILA,
  }).format(now)
  const { count, totalsByCurrency } = todays

  return (
    <section
      id={confirming ? undefined : TODAYS_RELEASE_ANCHOR}
      className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-navy via-[#274f7f] to-[#3d72a8] p-6 text-white shadow-lg sm:p-8"
    >
      <svg aria-hidden="true" className="pointer-events-none absolute -left-16 -bottom-24 h-72 w-72 text-white/[0.07]" viewBox="0 0 200 200" fill="none" stroke="currentColor">
        <circle cx="100" cy="100" r="90" strokeWidth="2" />
        <circle cx="100" cy="100" r="60" strokeWidth="2" />
      </svg>

      <div className="relative grid items-center gap-8 md:grid-cols-[1fr_auto]">
        <div>
          <p className="text-[11px] font-semibold tracking-widest text-white/70">
            {greeting(now)}, {first.toUpperCase()} · {today.toUpperCase()}
          </p>

          {count === 0 ? (
            <>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">Nothing is waiting to be handed over</h2>
              <p className="mt-2 text-sm text-white/75">Cheques appear here once they are marked READY FOR RELEASE.</p>
            </>
          ) : (
            <>
              <p className="mt-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold tracking-widest text-white ring-1 ring-white/25">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-300" />
                READY FOR RELEASE
              </p>
              <h2 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
                <span className="tabular-nums">{count.toLocaleString('en-PH')}</span>{' '}
                <span className="text-2xl font-medium text-white/85 sm:text-3xl">cheque{count === 1 ? '' : 's'} to hand over</span>
              </h2>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-emerald-200">
                {totalsByCurrency.map((t) => formatMoney(t.total, t.currency)).join(' + ')}
              </p>
            </>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {count > 0 && !confirming && canRelease && (
              // A link, not a submit: one click can only ask for the confirmation.
              <Link
                href={confirmHref}
                className="rounded-xl bg-white px-5 py-2.5 text-sm font-semibold tracking-wide text-rose-700 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                RELEASE ALL {count.toLocaleString('en-PH')}
              </Link>
            )}
            <Link
              href={readyHref}
              className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold tracking-wide text-white ring-1 ring-white/40 transition hover:bg-white/10"
            >
              OPEN THE LIST
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 10h12M11 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            {count > 0 && !canRelease && (
              <span className="text-[11px] font-medium tracking-wide text-white/70">ONLY A FINANCE ADMIN CAN RECORD A RELEASE.</span>
            )}
          </div>
        </div>

        <div className="hidden md:block">
          <ChequeArt />
        </div>
      </div>
    </section>
  )
}
