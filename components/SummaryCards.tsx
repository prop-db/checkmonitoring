import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { cardHref, isCardSelected, type CardId, type DashboardSelection } from '@/lib/dashboard-view'
import type { CurrencyTotal, TodaysRelease } from '@/lib/queries'

// `CurrencyTotal` is imported rather than restated. It was declared twice —
// here and in lib/queries.ts — and the two had already drifted apart on
// `total`'s nullability, which is precisely the drift a duplicated type
// invites: the query started returning null and this file went on promising a
// string.

type Summary = {
  total: number; pendingSignature: number; signed: number
  readyForRelease: number; scheduled: number; released: number
  incomplete: number
  totalsByCurrency: CurrencyTotal[]
}

/**
 * The icons.
 *
 * Inline SVG, four of them, rather than an icon package: this is a dashboard
 * with four icons on it and a dependency would be a bundle and a licence for
 * that. `aria-hidden` on every one — each sits beside a label that already
 * says what it is, so announcing it twice is noise.
 */
const ICON = 'h-4 w-4 shrink-0'

function IconReady() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 10.5 8 15l9-10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconWaiting() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 5.8V10l2.8 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconException() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M10 2.8 18.4 17H1.6L10 2.8Z" strokeLinejoin="round" />
      <path d="M10 8v3.4" strokeLinecap="round" />
      <circle cx="10" cy="14" r=".9" fill="currentColor" stroke="none" />
    </svg>
  )
}

function IconValue() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="1.8" y="4.4" width="16.4" height="11.2" rx="2" />
      <circle cx="10" cy="10" r="2.6" />
    </svg>
  )
}

function IconSigned() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.6 16.4h14.8" strokeLinecap="round" />
      <path d="M4.6 13.2c2.6-.6 3.4-8.2 5-8.2 1.3 0 .5 5.4 1.8 5.4 1 0 1.4-2.2 2.4-2.2.9 0 1 2.6 1.8 2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconArchive() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="2.4" y="3.4" width="15.2" height="4" rx="1" />
      <path d="M3.8 7.4v8.2a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V7.4M8 11h4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * A PRIMARY card: the four figures the client asked the first screen to answer
 * in under five seconds — what is ready, what is waiting, what is broken, what
 * it is all worth.
 *
 * Colour earns its place here and nowhere else. READY FOR RELEASE is the one
 * action of the day and carries the success tone; INCOMPLETE is the exception
 * list and carries the warning tone; the other two are white, because a screen
 * where everything is coloured is the screen the client already had.
 */
function PrimaryCard({
  label, icon, value, support, tone = 'plain', href, selected = false, hint,
}: {
  label: string
  icon: React.ReactNode
  value: React.ReactNode
  /** The supporting line beneath the figure. Always present — see below. */
  support: React.ReactNode
  tone?: 'plain' | 'success' | 'warn'
  href?: string
  selected?: boolean
  hint?: string
}) {
  const skin = {
    success: 'bg-success-bg ring-success-ink/20',
    warn: 'bg-warning-bg ring-warning-ink/25',
    plain: 'bg-white ring-hairline',
  }[tone]

  const ink = { success: 'text-success-ink', warn: 'text-warning-ink', plain: 'text-navy' }[tone]

  /**
   * The selected card keeps its own colour and gains a heavy dark outline.
   *
   * Colour alone would not do it: READY FOR RELEASE is already green and
   * INCOMPLETE already amber, so "the tinted one" cannot mean "the chosen one"
   * as well. The ring is a second channel, which also means the selection is
   * still visible to someone who cannot separate those hues.
   */
  const ring = selected ? 'ring-2 ring-navy shadow-sm' : `ring-1 ${skin.split(' ').pop()}`
  const bg = skin.split(' ')[0]

  const body = (
    <>
      <p className={`flex items-center gap-2 text-xs font-semibold tracking-wide ${ink}`}>
        {icon}
        {label}
      </p>
      {/* A plain number renders as text; a currency breakdown renders block-level
          markup (dl/div), which HTML forbids inside <p>. The wrapper has to be a
          <div> to legally hold either. */}
      <div className="mt-3 text-3xl font-semibold tracking-tight text-navy">{value}</div>
      {/* The supporting line is never conditional. A card that grows a second
          line only sometimes makes a row of four cards change height as the
          data changes, and the reader reads the movement as meaning. */}
      <div className="mt-1 text-xs font-medium tracking-wide text-slate-500">{support}</div>
      {selected && hint && (
        <p className="mt-2 text-[10px] font-semibold tracking-wide text-navy">{hint}</p>
      )}
    </>
  )

  // A card with somewhere to go is a link; the rest stay plain divs. Wrapping
  // every card in an anchor "for consistency" would offer dead links.
  //
  // `aria-current` rather than colour alone: a screen reader announces which
  // card is filtering the table, which the outline cannot convey.
  return href
    ? (
      <Link
        href={href}
        aria-current={selected ? 'true' : undefined}
        className={`block rounded-2xl p-5 transition ${bg} ${ring} hover:ring-navy`}
      >
        {body}
      </Link>
    )
    : <div className={`rounded-2xl p-5 ${bg} ${ring}`}>{body}</div>
}

/**
 * A SECONDARY card: smaller, quieter, still a view.
 *
 * RELEASED (9,545) and TOTAL CHECKS (11,671) are the two largest numbers on the
 * screen and the two least actionable — nobody will touch a released cheque
 * again. Given the same weight as READY FOR RELEASE they out-shout it by two
 * orders of magnitude, which is the client's complaint exactly. Demoted, not
 * removed: they stay clickable views, because the cards ARE the view selector
 * and that model does not change.
 */
function SecondaryCard({
  label, value, href, selected, hint,
}: {
  label: string
  value: string
  href: string
  selected: boolean
  hint: string
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? 'true' : undefined}
      className={`flex items-baseline justify-between gap-3 rounded-xl bg-white px-4 py-2.5 transition hover:ring-navy ${
        selected ? 'ring-2 ring-navy' : 'ring-1 ring-hairline'
      }`}
    >
      <span className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-slate-500">
        <IconArchive />
        {label}
      </span>
      <span className="text-base font-semibold tabular-nums text-slate-700">{value}</span>
      {selected && <span className="sr-only">{hint}</span>}
    </Link>
  )
}

// One line per currency, never one summed figure: a PHP total and a CNY total
// are not the same unit and must never be added together.
function CurrencyBreakdown({ totalsByCurrency }: { totalsByCurrency: CurrencyTotal[] }) {
  if (totalsByCurrency.length === 0) {
    return <div>{formatMoney('0', 'PHP')}</div>
  }
  return (
    <dl>
      {totalsByCurrency.map((t) => (
        <div key={t.currency}>
          <dt className="text-3xl font-semibold tracking-tight text-navy">
            {formatMoney(t.total, t.currency)}
          </dt>
          <dd className="sr-only">{t.currency}</dd>
        </div>
      ))}
    </dl>
  )
}

// Re-exported so a caller rendering these cards has one import, not two. The
// type itself is declared with the logic, in lib/dashboard-view.ts.
export type { DashboardSelection } from '@/lib/dashboard-view'

/**
 * The dashboard's KPI hierarchy.
 *
 * ── THE CLIENT'S DIAGNOSIS (2026-09-06) ───────────────────────────────────
 * "Everything has the same weight, so users don't immediately know what needs
 * to be released today." Seven identical cards in one row is that problem
 * stated as a layout: RELEASED at 9,545 and READY FOR RELEASE at 80 were the
 * same size in the same colour, and the eye goes to the big number.
 *
 * So there are two rows now. The PRIMARY four answer the three questions the
 * first screen exists to answer — how many need action today, what is ready for
 * supplier release, and are there exceptions — plus what it is all worth. The
 * SECONDARY row holds the historical views at a fraction of the weight.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The cards remain the VIEW SELECTOR, not a shortcut to a dropdown. Selecting
 * one chooses which set of cheques the table shows; the filter bar's COMPANY,
 * BANK and ELIGIBILITY controls then narrow within it. There is no STATUS
 * dropdown and no scope tabs — they wrote the same URL parameters as these
 * cards, and the client never read the cards as filters while a dropdown was
 * competing with them.
 *
 * All of the URL arithmetic lives in `lib/dashboard-view.ts`, which is pure and
 * tested. This file decides what a card looks like, never what it means.
 */
export function SummaryCards({
  summary, todaysRelease, selection,
}: {
  summary: Summary
  /**
   * READY FOR RELEASE's value line.
   *
   * Passed in from the page's existing `getTodaysRelease` call rather than
   * queried again: it is the same set — READY_FOR_RELEASE + SCHEDULED — read
   * from one place, so the card's count and the card's value cannot come from
   * two queries that saw different data, and the panel below cannot disagree
   * with the card above it.
   */
  todaysRelease: TodaysRelease
  selection: DashboardSelection
}) {
  /**
   * A selected view card links back to NEEDS ACTION, so clicking it again turns
   * it off. A view you can switch on and cannot switch off sends people to the
   * browser's Back button to undo a click they just made.
   *
   * The hint says which of the two things a lit card is doing: a view card is
   * the table's scope, INCOMPLETE only narrows whatever scope is already there.
   */
  const card = (id: CardId) => ({
    selected: isCardSelected(id, selection),
    href: cardHref(id, selection),
    hint: id === 'INCOMPLETE'
      ? 'ALSO NARROWED TO THESE — CLICK TO STOP'
      : 'VIEWING — CLICK FOR NEEDS ACTION',
  })

  // SCHEDULED has no card of its own. To Finance the two are one state — the
  // cheque is available and waiting to be handed over — and a card reading 0
  // forever is furniture. The STATUS is NOT removed: a portal pickup
  // confirmation moves READY_FOR_RELEASE -> SCHEDULED and must still have
  // somewhere to land, so the count is folded in here rather than dropped, and
  // the view matches both.
  const ready = summary.readyForRelease + summary.scheduled

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <PrimaryCard
          label="READY FOR RELEASE"
          icon={<IconReady />}
          value={ready.toLocaleString('en-PH')}
          support={
            todaysRelease.totalsByCurrency.length === 0
              ? 'NOTHING WAITING TO BE HANDED OVER'
              // One line per currency, never summed across them.
              : todaysRelease.totalsByCurrency
                .map((t) => formatMoney(t.total, t.currency))
                .join(' + ') + ' READY TO HAND OVER'
          }
          tone="success"
          {...card('READY_FOR_RELEASE')}
        />

        {/* SIGNED is a QUEUE, not an archive, which is why it sits in the
            primary row and not beside RELEASED. These cheques are signed and in
            hand; the only thing between them and a supplier is a Finance user
            ticking READY FOR RELEASE. Omitting the card left 1,034 cheques
            reachable only through a timeline node — the client noticed within
            minutes of the deploy.

            White, not toned: colour is spent on the day's one action and on the
            exception list, and a third tinted card starts the creep back toward
            the screen where everything was coloured and nothing stood out. */}
        <PrimaryCard
          label="SIGNED"
          icon={<IconSigned />}
          value={summary.signed.toLocaleString('en-PH')}
          support="IN HAND · WAITING TO BE TICKED READY"
          {...card('SIGNED')}
        />

        <PrimaryCard
          label="PENDING SIGNATURE"
          icon={<IconWaiting />}
          // Both rungs — GENERATED and SIGNATURE_PENDING — because to Finance a
          // freshly generated cheque is a cheque waiting to be signed. The
          // timeline below splits them.
          value={summary.pendingSignature.toLocaleString('en-PH')}
          support="WAITING ON A SIGNATORY"
          {...card('SIGNATURE_PENDING')}
        />

        {/* 129 cheques in production whose amount the register never recorded.
            They are NOT part of the value beside them and never were — SQL
            SUM() skips a null — so the exception card and the value card sit in
            the same row deliberately: the reader can see how many cheques the
            total cannot speak for.

            The one card that is not a view: incompleteness cuts across every
            status, so it composes with the selected view rather than replacing
            it, and both cards light up together when both are on. */}
        <PrimaryCard
          label="INCOMPLETE"
          icon={<IconException />}
          value={summary.incomplete.toLocaleString('en-PH')}
          support="MISSING AMOUNT · NEEDS CORRECTION"
          tone={summary.incomplete > 0 ? 'warn' : 'plain'}
          {...card('INCOMPLETE')}
        />

        {/* Not clickable: there is no "cheques worth this much" set to view. */}
        <PrimaryCard
          label="TOTAL VALUE"
          icon={<IconValue />}
          value={<CurrencyBreakdown totalsByCurrency={summary.totalsByCurrency} />}
          support={`ACROSS ${summary.total.toLocaleString('en-PH')} CHEQUES · EXCLUDES ${summary.incomplete.toLocaleString('en-PH')} WITH NO AMOUNT`}
        />
      </div>

      {/* The historical views, at a fraction of the weight. Still links, still
          the view selector — demoted, not removed. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:max-w-2xl">
        {/* An explicit status wins over the NEEDS ACTION default, which excludes
            RELEASED — so this opens a full table without widening the view to
            everything. */}
        <SecondaryCard label="RELEASED" value={summary.released.toLocaleString('en-PH')} {...card('RELEASED')} />
        {/* "Show me everything, start again": every status, and no company, bank,
            eligibility, search or incomplete filter left over. */}
        <SecondaryCard label="TOTAL CHECKS" value={summary.total.toLocaleString('en-PH')} {...card('TOTAL_CHECKS')} />
      </div>
    </section>
  )
}
