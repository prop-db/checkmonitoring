
/**
 * The banner the TOTALS screen opens with (client, 2026-10-06: "the dashboard
 * looks boring, make it presentable").
 *
 * A greeting and today's date.
 */
const MANILA = 'Asia/Manila'

function greeting(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: MANILA }).format(now)) % 24
  return hour < 12 ? 'GOOD MORNING' : hour < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'
}

export function DashboardHero({ name, now = new Date() }: { name: string; now?: Date }) {
  const first = name.trim().split(/\s+/)[0] || name
  const today = new Intl.DateTimeFormat('en-PH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: MANILA,
  }).format(now)

  // The greeting only (2026-10-07, "this looks redundant"): the counts and the
  // day's money live once, in the workflow row below (components/WorkflowRow.tsx).
  return (
    <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-[#274f7f] to-[#3d72a8] px-6 py-4 text-white shadow-md">
      <svg aria-hidden="true" className="pointer-events-none absolute -right-10 -top-20 h-56 w-56 text-white/10" viewBox="0 0 200 200" fill="none" stroke="currentColor">
        <circle cx="100" cy="100" r="90" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="62" strokeWidth="1.5" />
      </svg>
      <p className="relative text-sm font-semibold tracking-widest text-white/90">
        {greeting(now)}, {first.toUpperCase()} · {today.toUpperCase()}
      </p>
    </section>
  )
}
