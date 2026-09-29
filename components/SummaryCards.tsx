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

// IconException went with the INCOMPLETE card (client decision, 2026-09-06). It
// is not kept "in case": an icon with no card is a component nobody renders and
// the next reader has to check.

function IconValue() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="1.8" y="4.4" width="16.4" height="11.2" rx="2" />
      <circle cx="10" cy="10" r="2.6" />
    </svg>
  )
}

function IconInventory() {
  return (
    <svg className={ICON} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="3" width="5.5" height="5.5" rx="1" />
      <rect x="3" y="11.5" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1" />
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
 * A PRIMARY card: the figures the client asked the first screen to answer in
 * under five seconds — what is ready, what is waiting, what it is all worth.
 *
 * Colour earns its place here and nowhere else. READY FOR RELEASE is the one
 * action of the day and carries the success tone; the rest are white, because a
 * screen where everything is coloured is the screen the client already had.
 * There was a `warn` tone too, for the INCOMPLETE card — that card is gone
 * (client decision, 2026-09-06) and so is the tone, rather than left as an
 * option nothing passes.
 */
function PrimaryCard({
  label, icon, value, support, tone = 'plain', href, selected = false, hint,
}: {
  label: string
  icon: React.ReactNode
  value: React.ReactNode
  /** The supporting line beneath the figure. Always present — see below. */
  support: React.ReactNode
  tone?: 'plain' | 'success'
  href?: string
  selected?: boolean
  hint?: string
}) {
  const skin = {
    success: 'bg-success-bg ring-success-ink/20',
    plain: 'bg-white ring-hairline',
  }[tone]

  const ink = { success: 'text-success-ink', plain: 'text-navy' }[tone]

  /**
   * The selected card keeps its own colour and gains a heavy dark outline.
   *
   * Colour alone would not do it: READY FOR RELEASE is already green, so "the
   * tinted one" cannot mean "the chosen one" as well. The ring is a second
   * channel, which also means the selection is still visible to someone who
   * cannot separate those hues.
   */
  const ring = selected ? 'ring-2 ring-navy shadow-md' : `ring-1 shadow-sm ${skin.split(' ').pop()}`
  const bg = skin.split(' ')[0]

  // The icon sits in a small tinted disc (2026-09-27 restyle): the same
  // pastel the card's ink belongs to, so a white card carries one touch of
  // navy and the green card one touch of white. Decorative, and the label
  // beside it still says everything.
  const disc = { success: 'bg-white/70', plain: 'bg-navy-bg' }[tone]

  const body = (
    <>
      <p className={`flex items-center gap-2.5 text-xs font-semibold tracking-wide ${ink}`}>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${disc}`}>{icon}</span>
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
 * So there are two rows now. The PRIMARY four answer the questions the first
 * screen exists to answer — what is ready for supplier release, what is signed
 * and waiting, what is still with a signatory — plus what it is all worth. The
 * SECONDARY row holds the historical views at a fraction of the weight.
 *
 * There was a fifth: INCOMPLETE, the exception list. It is gone (client
 * decision, 2026-09-06) along with the cheques it counted, which are now out of
 * every figure on this screen. See the TOTAL VALUE card below.
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
   * Every card is a view now — the INCOMPLETE toggle was the one that was not,
   * and it is no longer a card — so the hint is the same for all of them.
   */
  const card = (id: CardId) => ({
    selected: isCardSelected(id, selection),
    href: cardHref(id, selection),
    hint: 'VIEWING — CLICK FOR THE NEEDS ACTION LIST',
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
      {/* Five across since 2026-09-29: ALL CHECKS moved up from the secondary
          row, because it is the cheque inventory (client request) and an
          inventory is not a historical view. */}
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

            White, not toned: colour is spent on the day's one action and
            nothing else, and a second tinted card starts the creep back toward
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

        {/* THE INCOMPLETE CARD IS GONE (client decision, 2026-09-06). Shown the
            card reading 129 the client said "ignore them mean you have to remove
            them, dont consider them becuase they dont have amount", so those
            cheques are out of every count on this screen and out of the table.

            Nothing was deleted — 25 of them are RELEASED — and the exclusion is
            not silent either: `app/page.tsx` states the number above the table
            with a link that shows them. That notice is where this card's figure
            went, and it is the reason removing the card is honest rather than a
            number that quietly got smaller. */}

        {/* ALL CHECKS — the cheque INVENTORY (client request, 2026-09-29:
            "should ALL CHECKS in dashboard, to be use in checks inventory").
            Every status, and it keeps the company, bank, eligibility and
            incomplete filters like every other card, so the list it opens — and
            the export and print sheet, which read the same URL — is "every
            cheque STK holds at BPI". Card id and URL parameter are unchanged
            (`TOTAL_CHECKS`, `scope=all`); only the label and the row moved. */}
        <PrimaryCard
          label="ALL CHECKS"
          icon={<IconInventory />}
          value={summary.total.toLocaleString('en-PH')}
          support="EVERY STATUS · INCLUDING RELEASED, CANCELLED AND VOIDED"
          {...card('TOTAL_CHECKS')}
        />

        {/* Not clickable: there is no "cheques worth this much" set to view. */}
        <PrimaryCard
          label="TOTAL VALUE"
          icon={<IconValue />}
          value={<CurrencyBreakdown totalsByCurrency={summary.totalsByCurrency} />}
          /* The old line said "EXCLUDES 129 WITH NO AMOUNT" beside a count that
             INCLUDED all 129 — true then, because the value skipped them and the
             count did not. `summary.total` no longer counts them either, so the
             clause is rewritten rather than left standing as a half-truth: they
             are outside both figures now. */
          support={
            summary.incomplete > 0
              ? `ACROSS ${summary.total.toLocaleString('en-PH')} CHEQUES · ${summary.incomplete.toLocaleString('en-PH')} WITH NO AMOUNT ARE NOT COUNTED AT ALL`
              : `ACROSS ${summary.total.toLocaleString('en-PH')} CHEQUES`
          }
        />
      </div>

      {/* The historical view, at a fraction of the weight. Still a link, still
          the view selector — demoted, not removed. ALL CHECKS left this row on
          2026-09-29. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:max-w-2xl">
        {/* An explicit status wins over the NEEDS ACTION default, which excludes
            RELEASED — so this opens a full table without widening the view to
            everything. */}
        <SecondaryCard label="RELEASED" value={summary.released.toLocaleString('en-PH')} {...card('RELEASED')} />
      </div>
    </section>
  )
}
