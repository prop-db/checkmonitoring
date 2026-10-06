import { formatMoney } from '@/lib/money'
import { TODAYS_RELEASE_ANCHOR } from '@/lib/dashboard-view'
import type { TodaysRelease } from '@/lib/queries'

/**
 * The banner the TOTALS screen opens with (client, 2026-10-06: "the dashboard
 * looks boring, make it presentable").
 *
 * A greeting, today's date and the one sentence the screen exists to answer —
 * how many cheques are ready to hand over, and what they are worth — with the
 * two queues behind it as chips. Pure presentation: every figure is read off
 * the summary and TODAY'S RELEASE the page already fetched, so the banner and
 * the cards below it cannot disagree. Money is per currency, never summed
 * across them, and formatted from decimal strings (rule 8).
 */
const MANILA = 'Asia/Manila'

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: MANILA }).format(now)) % 24
  return hour < 12 ? 'GOOD MORNING' : hour < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'
}

function Chip({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/20 backdrop-blur-sm">
      <p className="text-2xl font-semibold tabular-nums text-white">{value.toLocaleString('en-PH')}</p>
      <p className="mt-0.5 text-[10px] font-semibold tracking-widest text-white/70">{label}</p>
    </div>
  )
}

export function DashboardHero({
  name, todays, pendingSignature, signed, now = new Date(),
}: {
  name: string
  todays: TodaysRelease
  pendingSignature: number
  signed: number
  now?: Date
}) {
  const first = name.trim().split(/\s+/)[0] || name
  const today = new Intl.DateTimeFormat('en-PH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: MANILA,
  }).format(now)
  const { count, totalsByCurrency } = todays

  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-navy via-[#274f7f] to-[#3d72a8] p-6 text-white shadow-md sm:p-8">
      {/* Decoration: soft rings and a ruled cheque line, behind everything. */}
      <svg aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 h-72 w-72 text-white/10" viewBox="0 0 200 200" fill="none" stroke="currentColor">
        <circle cx="100" cy="100" r="90" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="62" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="34" strokeWidth="1.5" />
      </svg>
      <svg aria-hidden="true" className="pointer-events-none absolute -bottom-6 left-1/3 h-24 w-80 text-white/10" viewBox="0 0 320 96" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M0 70h220M0 50h160M250 70h70" />
      </svg>

      <div className="relative flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold tracking-widest text-white/70">
            {greeting(now)}, {first.toUpperCase()} · {today.toUpperCase()}
          </p>
          {count === 0 ? (
            <>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Nothing is waiting to be handed over</h2>
              <p className="mt-2 text-sm text-white/75">
                Cheques appear here once Finance marks them READY FOR RELEASE.
              </p>
            </>
          ) : (
            <>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                {count.toLocaleString('en-PH')} cheque{count === 1 ? '' : 's'} ready to hand over
              </h2>
              <p className="mt-2 text-lg font-medium text-white/90">
                {totalsByCurrency.map((t) => formatMoney(t.total, t.currency)).join(' + ')}
              </p>
              <a
                href={`#${TODAYS_RELEASE_ANCHOR}`}
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold tracking-wide text-navy shadow-sm transition hover:bg-navy-bg"
              >
                REVIEW TODAY’S RELEASE
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 10h12M11 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </>
          )}
        </div>

        <div className="flex gap-3">
          <Chip value={pendingSignature} label="AWAITING SIGNATURE" />
          <Chip value={signed} label="SIGNED · IN HAND" />
        </div>
      </div>
    </section>
  )
}
