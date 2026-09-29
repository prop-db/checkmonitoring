# TOTALS-screen filters and ALL CHECKS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CHECK RELEASE dashboard's TOTALS screen gains COMPANY / BANK / ELIGIBILITY filters that narrow every figure on it (cards, TODAY'S RELEASE and RELEASE ALL, timeline, disclosure), and TOTAL CHECKS becomes ALL CHECKS — a primary card that carries the filters into the list instead of clearing them.

**Architecture:** Everything is URL arithmetic already (`lib/dashboard-view.ts`, `lib/dashboard-params.ts`), so the screen rule and the card links change there, pure and tested without a DOM. `getSummary`, `getTodaysRelease` and `listTodaysReleaseIds` in `lib/queries.ts` gain an optional narrowing parameter. RELEASE ALL carries the narrowing as hidden inputs and the server re-resolves the set from them. A new `TotalsFilterBar` component renders the three dropdowns on the TOTALS screen; the NEEDS ACTION list carries a `scope=live` marker so filtering inside it stays on the list.

**Tech Stack:** Next.js 15 App Router (server components, server actions), Prisma 6 on Neon, Vitest, TypeScript strict. Spec: `docs/superpowers/specs/2026-09-29-totals-filters-and-all-checks-design.md`.

## Global Constraints

- **Windows.** Run tests with `node node_modules/vitest/vitest.mjs run <file>` and the type check with `node node_modules/typescript/bin/tsc --noEmit` from the Bash tool. `npx.cmd` mis-tokenises `-t "a|b"` and PowerShell blocks `npx.ps1`.
- **Never run the full suite per task** (~20–30 minutes, every test crosses to ap-southeast-1). Run only the files named in each task. One agent at a time against the test database.
- **`node node_modules/typescript/bin/tsc --noEmit` before claiming any task done.** Vitest erases types.
- **The repo `.env` names the PRODUCTION database.** Do not start the dev server or run scripts to "have a look". Verification is tests, `tsc` and `next build`.
- **Amounts are decimal strings**, never JS numbers. No task here touches an amount; keep it that way.
- **Rule 4 / rule 5 untouched:** nothing here writes a status except `markReleased` inside the existing RELEASE ALL path.
- **Copy rules:** the card is labelled `ALL CHECKS`; `describeView` and the export label keep saying `ALL CHEQUES`; the URL parameter stays `scope=all`; the card id stays `TOTAL_CHECKS`. The new marker is exactly `scope=live`.
- **Commit after every task**, message ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Use `git -c core.autocrlf=false commit` to avoid the CRLF warning noise.

---

### Task 1: `scope=live` and the new screen rule

**Files:**
- Modify: `lib/dashboard-view.ts` (types `DashboardSelection`, `query`, `href`, every `*Href`, `cardHref`, `dashboardScreen`)
- Modify: `lib/dashboard-params.ts` (`DashboardQuery`, `resolveDashboardQuery`)
- Test: `tests/dashboard-view.test.ts`, `tests/export/dashboard-params.test.ts`
- Modify (fixtures only): `tests/dashboard-links.test.ts`, `tests/release-timeline.test.ts`

**Interfaces:**
- Produces: `DashboardSelection.live: boolean` (required). `resolveDashboardQuery` sets it from `params.scope === 'live'` and returns a new `narrowingDescription: string`. `dashboardScreen` answers TOTALS for a selection whose `base` holds only `company` / `cashAccount` / `eligibility`.

- [ ] **Step 1: Add `live: false` to every test fixture that builds a `DashboardSelection`**

`tests/dashboard-view.test.ts` line 20, `tests/dashboard-links.test.ts` line 7 and `tests/release-timeline.test.ts` line 11 each hold:

```ts
const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, base: {} }
```

Change all three to:

```ts
const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, live: false, base: {} }
```

`tests/dashboard-links.test.ts` builds three more without the spread (around lines 82, 115 and 123) and `tests/release-timeline.test.ts` one (around line 63). Each reads `status: …, showAll: false, incomplete: …,` on one line — add `live: false,` after `incomplete: …,` on that line in all four. Example:

```ts
    const sel: DashboardSelection = {
      status: 'READY_FOR_RELEASE', showAll: false, incomplete: false, live: false,
      base: { q: 'ACME', company: 'c1' },
    }
```

- [ ] **Step 2: Write the failing tests in `tests/dashboard-view.test.ts`**

Extend the import at the top to include `dashboardHref` and `printHref`:

```ts
import {
  isCardSelected, cardHref, incompleteHref, clearFiltersHref, describeView, viewStatusFilter,
  releaseConfirmHref, releaseCancelHref, TODAYS_RELEASE_ANCHOR,
  exportHref, EXPORT_PATH, dashboardHref, printHref,
  dashboardScreen,
  type DashboardSelection,
} from '@/lib/dashboard-view'
```

Rewrite the three deselection expectations that used to land on `/`. In `describe('deselecting a view')`:

```ts
  it('returns to the NEEDS ACTION list rather than to everything', () => {
    expect(cardHref('SIGNED', { ...NOTHING, status: 'SIGNED' })).toBe('/?scope=live')
    expect(cardHref('READY_FOR_RELEASE', { ...NOTHING, status: 'READY_FOR_RELEASE' })).toBe('/?scope=live')
    expect(cardHref('RELEASED', { ...NOTHING, status: 'RELEASED' })).toBe('/?scope=live')
  })

  it('keeps the narrowing filters, which are not part of the view', () => {
    expect(cardHref('SIGNED', { ...NARROWED, status: 'SIGNED' }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&scope=live')
  })
```

In `describe('TOTAL CHECKS')` replace `goes back to NEEDS ACTION when clicked again`:

```ts
  it('goes back to the NEEDS ACTION list when clicked again', () => {
    expect(cardHref('TOTAL_CHECKS', { ...NOTHING, showAll: true })).toBe('/?scope=live')
  })
```

Replace the whole `describe('dashboardScreen')` block:

```ts
describe('dashboardScreen', () => {
  it('opens on TOTALS when nothing narrows the view', () => {
    expect(dashboardScreen(NOTHING)).toBe('TOTALS')
  })

  /**
   * Client request 2026-09-29: "should have filter in every summary". The
   * company, bank and eligibility dropdowns now live on the TOTALS screen too,
   * and choosing one narrows the cards rather than opening the list.
   */
  it('stays on TOTALS when only the company, bank or eligibility narrows it', () => {
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1' } })).toBe('TOTALS')
    expect(dashboardScreen({ ...NOTHING, base: { cashAccount: 'a1' } })).toBe('TOTALS')
    expect(dashboardScreen({ ...NOTHING, base: { eligibility: 'SUPPLIER' } })).toBe('TOTALS')
    expect(dashboardScreen({
      ...NOTHING, base: { company: 'c1', cashAccount: 'a1', eligibility: 'SUPPLIER' },
    })).toBe('TOTALS')
  })

  it('opens the LIST for a card, all cheques, the incomplete toggle, the live list, or a search', () => {
    expect(dashboardScreen({ ...NOTHING, status: 'SIGNED' })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, showAll: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, incomplete: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, live: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { q: '6000351234' } })).toBe('LIST')
    // A search on a narrowed TOTALS screen opens the list narrowed the same way.
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1', q: '6000351234' } })).toBe('LIST')
  })
})

/**
 * `scope=live`: the NEEDS ACTION list, said out loud.
 *
 * NEEDS ACTION has no card. Before the TOTALS screen had filters it was reached
 * only by the search box, and `/?company=c1` opened it narrowed; now that URL is
 * the TOTALS for one company, so the list's filter bar carries this marker and
 * filtering inside the list cannot bounce the reader back to the totals.
 */
describe('scope=live', () => {
  const LIVE: DashboardSelection = { ...NOTHING, live: true }

  it('changes no filter and no wording: it is NEEDS ACTION, as a list', () => {
    expect(viewStatusFilter(LIVE)).toEqual(viewStatusFilter(NOTHING))
    expect(describeView(LIVE)).toBe(describeView(NOTHING))
  })

  it('is carried by every link that rebuilds the selection', () => {
    expect(dashboardHref(LIVE)).toBe('/?scope=live')
    expect(clearFiltersHref({ ...LIVE, base: { q: 'ACME', company: 'c1' } })).toBe('/?scope=live')
    expect(incompleteHref(LIVE)).toBe('/?scope=live&incomplete=1')
    expect(exportHref(LIVE)).toBe('/api/export?scope=live')
    expect(printHref(LIVE)).toBe('/print?scope=live')
    expect(dashboardHref({ ...LIVE, base: { company: 'c1' } })).toBe('/?company=c1&scope=live')
  })

  it('is not written beside a status or the all-cheques scope, which already open the list', () => {
    expect(dashboardHref({ ...LIVE, status: 'SIGNED' })).toBe('/?status=SIGNED')
    expect(dashboardHref({ ...LIVE, showAll: true })).toBe('/?scope=all')
    expect(cardHref('SIGNED', LIVE)).toBe('/?status=SIGNED')
  })

  it('is dropped by the RELEASE ALL links, which live on the totals screen', () => {
    // The panel is never rendered on the list, so a selection reaching these has live=false.
    expect(releaseConfirmHref(NOTHING)).toBe(`/?confirm=release#${TODAYS_RELEASE_ANCHOR}`)
    expect(releaseCancelHref({ ...NOTHING, base: { company: 'c1' } }))
      .toBe(`/?company=c1#${TODAYS_RELEASE_ANCHOR}`)
  })
})
```

- [ ] **Step 3: Write the failing tests in `tests/export/dashboard-params.test.ts`**

Change line 22 to include the new field:

```ts
    expect(r.selection).toEqual({ status: null, showAll: false, incomplete: false, live: false, base: {} })
```

Append inside `describe('resolveDashboardQuery')`:

```ts
  it('reads scope=live as the NEEDS ACTION list, as a list, and nothing more', () => {
    const r = resolveDashboardQuery({ scope: 'live' }, options)
    expect(r.selection.live).toBe(true)
    expect(r.selection.showAll).toBe(false)
    expect(r.filters.statusIn).toEqual(LIVE_STATUSES)
    expect(r.filters.status).toBeUndefined()
    expect(r.viewLabel).toBe('NEEDS ACTION')
  })

  it('does not read scope=all, or any other scope, as live', () => {
    expect(resolveDashboardQuery({ scope: 'all' }, options).selection.live).toBe(false)
    expect(resolveDashboardQuery({ scope: 'everything' }, options).selection.live).toBe(false)
  })

  /**
   * The line the TOTALS screen prints under its filter bar. Only the three
   * dropdowns that screen has — never the search, never the incomplete toggle,
   * which the screen states on its own line with a count.
   */
  it('describes the narrowing the totals screen applies', () => {
    const r = resolveDashboardQuery(
      { company: 'co-stk', cashAccount: 'ca-bpi', eligibility: 'SUPPLIER', q: 'henkel', incomplete: '1' },
      options,
    )
    expect(r.narrowingDescription).toBe('COMPANY: STK  ·  BANK / CASH ACCOUNT: BPI STK  ·  ELIGIBILITY: SUPPLIER')
    expect(resolveDashboardQuery({ cashAccount: 'ca-main' }, options).narrowingDescription)
      .toBe('BANK / CASH ACCOUNT: STK MAIN (BDO)')
    expect(resolveDashboardQuery({}, options).narrowingDescription).toBe('No filters applied')
  })
```

- [ ] **Step 4: Run the two files and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/export/dashboard-params.test.ts`
Expected: FAIL — type errors on `live` are erased by esbuild, so the failures are the `/?scope=live` expectations, the `dashboardScreen` TOTALS cases, and `narrowingDescription` being `undefined`.

- [ ] **Step 5: Implement in `lib/dashboard-view.ts`**

Change `DashboardSelection`:

```ts
export type DashboardSelection = {
  status: CheckStatus | null
  showAll: boolean
  incomplete: boolean
  /**
   * `scope=live`: the NEEDS ACTION list asked for AS A LIST.
   *
   * NEEDS ACTION has no card, and since 2026-09-29 the TOTALS screen has the
   * company, bank and eligibility dropdowns too, so `/?company=c1` is the
   * totals for one company and no longer the list. The list's filter bar
   * carries this marker on the NEEDS ACTION view — exactly as it carries
   * `status` or `scope=all` on every other — so that clearing the search and
   * choosing a company keeps the reader on the list they were reading.
   *
   * It changes no filter: `viewStatusFilter` never reads it, and
   * `describeView` says what it says. `status` and `scope=all` win over it.
   */
  live: boolean
  base: Readonly<Record<string, string>>
}

type ViewState = Pick<DashboardSelection, 'status' | 'showAll'>
type LinkState = ViewState & { incomplete: boolean; live?: boolean; confirmRelease?: boolean }
```

Replace `query` and `href` so they take `LinkState` and write the marker:

```ts
function query(base: Readonly<Record<string, string>>, view: LinkState): string {
  const qs = new URLSearchParams(base)
  if (view.status) qs.set('status', view.status)
  if (view.showAll) qs.set('scope', 'all')
  // The NEEDS ACTION list, said out loud — only when nothing else already
  // opens the list. `status` and `scope=all` win.
  else if (view.live && !view.status) qs.set('scope', 'live')
  if (view.incomplete) qs.set('incomplete', '1')
  // Only ever set by `releaseConfirmHref`. Every other caller omits it, which is
  // how choosing a card or clearing the filters also steps back out of a
  // half-made release rather than carrying the confirmation along.
  if (view.confirmRelease) qs.set('confirm', 'release')
  return qs.toString()
}

function href(base: Readonly<Record<string, string>>, view: LinkState): string {
  const s = query(base, view)
  return s ? `/?${s}` : '/'
}
```

`cardHref`: a deselected card goes to the NEEDS ACTION **list**; TOTAL CHECKS carries the filters (this is Task 2's behaviour but it is one line and its test in Step 2 of Task 2 will pin it — leave TOTAL CHECKS as it is for now):

```ts
export function cardHref(card: CardId, sel: DashboardSelection): string {
  const selected = isCardSelected(card, sel)

  // A deselected card lands on the NEEDS ACTION LIST, not on the totals: the
  // reader was looking at a table and clicked to widen it, not to leave it.
  if (selected) return href(sel.base, { ...NEEDS_ACTION, incomplete: sel.incomplete, live: true })

  if (card === 'TOTAL_CHECKS') return href({}, { status: null, showAll: true, incomplete: false })

  return href(sel.base, { status: card, showAll: false, incomplete: sel.incomplete })
}
```

Thread `live: sel.live` through the links that rebuild the selection — `incompleteHref`, `clearFiltersHref`, `exportHref`, `dashboardHref`, `printHref`. Each currently passes `{ status: sel.status, showAll: sel.showAll, incomplete: … }`; add `live: sel.live` to that object literal in all five. For example:

```ts
export function incompleteHref(sel: DashboardSelection): string {
  return href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: !sel.incomplete, live: sel.live,
  })
}

export function clearFiltersHref(sel: DashboardSelection): string {
  return href({}, { status: sel.status, showAll: sel.showAll, incomplete: false, live: sel.live })
}
```

`releaseConfirmHref` and `releaseCancelHref` are left alone: TODAY'S RELEASE renders only on the TOTALS screen, where `live` is false.

Replace `dashboardScreen`:

```ts
/**
 * Which of the dashboard's two screens a URL opens (client, 2026-09-25: "just
 * only show the totals. Once it is click, it will only the list so i can have
 * more space").
 *
 * The URL IS the screen. A bare `/` is the TOTALS, and so — since 2026-09-29,
 * "should have filter in every summary" — is a URL that carries only the
 * company, bank or eligibility: those three dropdowns now sit above the cards
 * and narrow the whole screen. A card, `scope=all`, the incomplete toggle, a
 * search, or the list's own `scope=live` marker opens the LIST. `base` is only
 * ever built from validated, non-empty values (`resolveDashboardQuery`), so an
 * empty search box does not count as one.
 */
export type DashboardScreen = 'TOTALS' | 'LIST'

export function dashboardScreen(sel: DashboardSelection): DashboardScreen {
  const listed = sel.status !== null || sel.showAll || sel.incomplete || sel.live || 'q' in sel.base
  return listed ? 'LIST' : 'TOTALS'
}
```

- [ ] **Step 6: Implement in `lib/dashboard-params.ts`**

Add to `DashboardQuery`:

```ts
  /**
   * The narrowing the TOTALS screen applies, in words — the three dropdowns
   * it has and nothing else. 'No filters applied' when none is set; the page
   * prints it only when one is.
   */
  narrowingDescription: string
```

In `resolveDashboardQuery`, after `const showAll = params.scope === 'all'`:

```ts
  const live = params.scope === 'live'
```

Add `live,` to the `selection` literal (between `incomplete` and `base`):

```ts
  const selection: DashboardSelection = {
    status: status ?? null,
    showAll,
    incomplete,
    live,
    base: Object.fromEntries(
```

And in the returned object, after `filterDescription: describeFilters({ … }),`:

```ts
    narrowingDescription: describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q: '',
      incomplete: undefined,
      releasedFrom: null,
      releasedTo: null,
    }),
```

(`describeFilters` already answers `'No filters applied'` for an empty set, and `incomplete: undefined` says nothing — check its `FilterDescription` type accepts `undefined` for `incomplete`; it does, the tri-state is documented there.)

- [ ] **Step 7: Run the tests and the type check**

Run: `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/export/dashboard-params.test.ts tests/dashboard-links.test.ts tests/release-timeline.test.ts`
Expected: PASS.

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output. If `app/page.tsx` or another file constructs a `DashboardSelection` without `live`, add it there — but `resolveDashboardQuery` is the only app-side constructor.

- [ ] **Step 8: Commit**

```bash
git add lib/dashboard-view.ts lib/dashboard-params.ts tests/dashboard-view.test.ts tests/export/dashboard-params.test.ts tests/dashboard-links.test.ts tests/release-timeline.test.ts
git -c core.autocrlf=false commit -m "feat(dashboard): company, bank and eligibility alone keep the TOTALS screen; scope=live names the NEEDS ACTION list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: ALL CHECKS carries the filters and joins the primary row

**Files:**
- Modify: `lib/dashboard-view.ts` (`cardHref`, the module comment's TOTAL CHECKS lines)
- Modify: `components/SummaryCards.tsx`
- Test: `tests/dashboard-view.test.ts`

**Interfaces:**
- Consumes: `DashboardSelection` with `live` from Task 1.
- Produces: `cardHref('TOTAL_CHECKS', sel)` keeps `sel.base` and `sel.incomplete`. The card id and `scope=all` are unchanged.

- [ ] **Step 1: Write the failing test**

In `tests/dashboard-view.test.ts`, `describe('TOTAL CHECKS')`, replace the case `clears every filter: …` with:

```ts
  /**
   * Client request 2026-09-29: ALL CHECKS is the cheque INVENTORY — "every
   * cheque STK holds at BPI, any status" — so it keeps the narrowing filters
   * like every other card. It used to clear them ("show me everything, start
   * again"); RESET on either filter bar is the way to do that now.
   */
  it('carries the search, the dropdowns and the incomplete toggle into the all-cheques view', () => {
    const messy: DashboardSelection = { ...NARROWED, status: 'SIGNED', incomplete: true }
    expect(cardHref('TOTAL_CHECKS', messy))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&scope=all&incomplete=1')
    expect(cardHref('TOTAL_CHECKS', NOTHING)).toBe('/?scope=all')
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts -t "carries the search, the dropdowns"`
Expected: FAIL — received `/?scope=all`.

- [ ] **Step 3: Implement the link**

In `lib/dashboard-view.ts`, `cardHref`, replace the TOTAL_CHECKS line and the doc comment above the function:

```ts
/**
 * Where a card points.
 *
 * A selected view card links back to the NEEDS ACTION list, so clicking it
 * again turns it off: a filter you can switch on and cannot switch off sends
 * people to the browser's Back button to undo a click they just made.
 *
 * ALL CHECKS (`TOTAL_CHECKS`) is no longer an exception on the way in. It used
 * to clear the search, the dropdowns and the incomplete toggle — "show me
 * everything, start again". Since 2026-09-29 it is the cheque inventory: every
 * status, narrowed by whatever the reader chose, so "every cheque STK holds at
 * BPI" is one click. RESET on the filter bar is what clears.
 */
export function cardHref(card: CardId, sel: DashboardSelection): string {
  const selected = isCardSelected(card, sel)

  if (selected) return href(sel.base, { ...NEEDS_ACTION, incomplete: sel.incomplete, live: true })

  if (card === 'TOTAL_CHECKS') return href(sel.base, { status: null, showAll: true, incomplete: sel.incomplete })

  return href(sel.base, { status: card, showAll: false, incomplete: sel.incomplete })
}
```

Also update the module comment's line `ALL CHEQUES    the TOTAL CHECKS card. Every status, and nothing else set.` to `ALL CHEQUES    the ALL CHECKS card. Every status, narrowed like any other view.`

- [ ] **Step 4: Move the card in `components/SummaryCards.tsx`**

Add an icon after `IconValue`:

```tsx
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
```

Change the primary grid to five across and insert the card between PENDING SIGNATURE and TOTAL VALUE:

```tsx
      {/* Five across since 2026-09-29: ALL CHECKS moved up from the secondary
          row, because it is the cheque inventory (client request) and an
          inventory is not a historical view. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
```

```tsx
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
```

Remove the `<SecondaryCard label="TOTAL CHECKS" …/>` line and its comment from the secondary row, and change that row's wrapper comment and grid so RELEASED stands alone:

```tsx
      {/* The historical view, at a fraction of the weight. Still a link, still
          the view selector — demoted, not removed. ALL CHECKS left this row on
          2026-09-29. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:max-w-2xl">
        <SecondaryCard label="RELEASED" value={summary.released.toLocaleString('en-PH')} {...card('RELEASED')} />
      </div>
```

Update the `hint` string in `card()` from `'VIEWING — CLICK FOR NEEDS ACTION'` to `'VIEWING — CLICK FOR THE NEEDS ACTION LIST'` (optional wording; the hint is only rendered on a selected card, which never happens on TOTALS).

- [ ] **Step 5: Run the tests and the type check**

Run: `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/release-timeline.test.ts`
Expected: PASS.

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard-view.ts components/SummaryCards.tsx tests/dashboard-view.test.ts
git -c core.autocrlf=false commit -m "feat(dashboard): ALL CHECKS is a primary card and keeps the filters — the cheque inventory view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The list's filter bar carries `scope=live`, and both bars label a bank the same way

**Files:**
- Modify: `components/FilterBar.tsx`
- Test: `tests/dashboard-links.test.ts`

**Interfaces:**
- Consumes: `bankLabel(cashAccountCode, bankCode)` from `lib/export/report.ts` (exists).
- Produces: on the NEEDS ACTION view the bar submits `scope=live`.

- [ ] **Step 1: Write the failing test**

In `tests/dashboard-links.test.ts`, `describe('filterHref')`, add:

```ts
  it('passes the list\'s hidden scope=live through unchanged, like the other hidden view fields', () => {
    expect(filterHref([['scope', 'live'], ['company', 'c1']])).toBe('/?scope=live&company=c1')
  })
```

- [ ] **Step 2: Run it**

Run: `node node_modules/vitest/vitest.mjs run tests/dashboard-links.test.ts`
Expected: PASS already (`filterHref` is generic). This case pins that nothing later special-cases the marker; keep it.

- [ ] **Step 3: Add the hidden input and reuse `bankLabel`**

In `components/FilterBar.tsx`, import the helper:

```ts
import { bankLabel } from '@/lib/export/report'
```

Replace the two hidden view inputs:

```tsx
      {status && <input type="hidden" name="status" value={status} />}
      {showAll && <input type="hidden" name="scope" value="all" />}
      {/* The NEEDS ACTION list, said out loud. Without it, clearing the search
          and choosing a company would submit `/?company=…`, which since
          2026-09-29 is the TOTALS screen for that company — the reader would
          be thrown off the list they were filtering. `status` and `scope=all`
          already open the list, so the marker is only needed when neither is
          set. See `DashboardSelection.live`. */}
      {!status && !showAll && <input type="hidden" name="scope" value="live" />}
```

Replace the cash-account option label so the two bars and the export spell an account identically:

```tsx
        {options.cashAccounts.map((a) => (
          <option key={a.id} value={a.id}>{bankLabel(a.code, a.bankCode)}</option>
        ))}
```

- [ ] **Step 4: Type check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

```bash
git add components/FilterBar.tsx tests/dashboard-links.test.ts
git -c core.autocrlf=false commit -m "feat(dashboard): the list's filter bar carries scope=live on NEEDS ACTION; bank labels from bankLabel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The summary and today's-release queries take a narrowing

**Files:**
- Modify: `lib/queries.ts` (`getSummary`, `getTodaysRelease`, `listTodaysReleaseIds`, new `SummaryNarrowing`)
- Test: `tests/queries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SummaryNarrowing = Pick<CheckFilters, 'companyId' | 'cashAccountId' | 'eligibility'>
  export async function getSummary(db: Db, narrow: SummaryNarrowing = {})
  export async function getTodaysRelease(db: Db, narrow: SummaryNarrowing = {}): Promise<TodaysRelease>
  export async function listTodaysReleaseIds(db: Db, narrow: SummaryNarrowing = {}): Promise<string[]>
  ```
  Every existing call with one argument behaves exactly as before.

- [ ] **Step 1: Write the failing tests**

`makeCheck` creates a fresh company and cash account per cheque, so each cheque's own `companyId` / `cashAccountId` is a narrowing that matches only it. Append to `tests/queries.test.ts` after the `getSummary` describe block:

```ts
/**
 * Client request 2026-09-29: "should have filter in every summary". The TOTALS
 * screen's company, bank and eligibility dropdowns narrow every card, so the
 * summary takes the same three filters the table reads — and applies them to
 * ALL of its figures, the disclosure count included, so no card can report the
 * whole company while the one beside it reports the filtered set.
 */
describe('getSummary narrowed', () => {
  it('narrows every count, the value total and the disclosure to one company', async () => {
    const mine = await makeCheck({ status: 'SIGNED', amount: '100.00' })
    await makeCheck({ status: 'SIGNED', amount: '200.00' })
    await makeCheck({ status: 'RELEASED', amount: '400.00' })
    // A cheque with no amount, in the SAME company, so the disclosure has one to count.
    await testDb.check.create({
      data: {
        companyId: mine.companyId, cashAccountId: mine.cashAccountId,
        checkNumber: '6000000001', apvNumbers: [], checkDate: new Date('2026-09-01'),
        amount: null, isIncomplete: true, currency: 'PHP', payeeName: 'X',
        eligibility: 'SUPPLIER', status: 'SIGNATURE_PENDING', isCheque: true,
      },
    })

    const s = await getSummary(testDb, { companyId: mine.companyId })
    expect(s.signed).toBe(1)
    expect(s.released).toBe(0)
    expect(s.pendingSignature).toBe(0)
    expect(s.total).toBe(1)
    expect(s.incomplete).toBe(1)
    // The currency group is deliberately NOT narrowed by completeness (see the
    // note in getSummary): the no-amount cheque is counted, its null skipped.
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '100', count: 2 }])
  })

  it('narrows to one cash account', async () => {
    const mine = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })

    const s = await getSummary(testDb, { cashAccountId: mine.cashAccountId })
    expect(s.readyForRelease).toBe(1)
    expect(s.total).toBe(1)
  })

  it('narrows to one eligibility', async () => {
    await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })

    const s = await getSummary(testDb, { eligibility: 'SUPPLIER' })
    expect(s.signed).toBe(2)
    expect(s.total).toBe(2)
  })

  it('is the whole database with no narrowing, exactly as before', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'SIGNED' })

    expect((await getSummary(testDb)).signed).toBe(2)
    expect((await getSummary(testDb, {})).signed).toBe(2)
  })
})
```

Append after the `getTodaysRelease` describe block:

```ts
describe("getTodaysRelease and listTodaysReleaseIds narrowed", () => {
  it('count the ready cheques of one company, and RELEASE ALL acts on exactly those', async () => {
    const mine = await makeCheck({ status: 'READY_FOR_RELEASE', amount: '100.00' })
    const alsoMine = await testDb.check.create({
      data: {
        companyId: mine.companyId, cashAccountId: mine.cashAccountId,
        checkNumber: '6000000002', apvNumbers: [], checkDate: new Date('2026-09-02'),
        amount: '50.00', isIncomplete: false, currency: 'PHP', payeeName: 'X',
        eligibility: 'SUPPLIER', status: 'SCHEDULED', isCheque: true,
      },
    })
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '1000.00' })

    const t = await getTodaysRelease(testDb, { companyId: mine.companyId })
    expect(t.count).toBe(2)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: '150', count: 2 }])

    const ids = await listTodaysReleaseIds(testDb, { companyId: mine.companyId })
    expect(ids).toEqual([mine.id, alsoMine.id])
  })

  it('narrow by cash account and by eligibility the same way', async () => {
    const bpi = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'BROKER' })
    await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })

    expect((await getTodaysRelease(testDb, { cashAccountId: bpi.cashAccountId })).count).toBe(1)
    expect(await listTodaysReleaseIds(testDb, { eligibility: 'BROKER' })).toEqual([bpi.id])
  })
})
```

Add `listTodaysReleaseIds` to the import from `@/lib/queries` at the top of the file.

- [ ] **Step 2: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/queries.test.ts -t "narrowed"`
Expected: FAIL — the second argument is ignored, so counts come back for the whole database.

- [ ] **Step 3: Implement in `lib/queries.ts`**

Above `getSummary`:

```ts
/**
 * The narrowing the TOTALS screen applies to every figure on it (client
 * request 2026-09-29: "should have filter in every summary") — the three
 * dropdowns that screen has, and nothing else. A `Pick` of `CheckFilters`
 * rather than a new shape, so the cards and the table cannot disagree about
 * what a company or a bank means.
 */
export type SummaryNarrowing = Pick<CheckFilters, 'companyId' | 'cashAccountId' | 'eligibility'>

function narrowingWhere(narrow: SummaryNarrowing): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = {}
  if (narrow.companyId) where.companyId = narrow.companyId
  if (narrow.cashAccountId) where.cashAccountId = narrow.cashAccountId
  if (narrow.eligibility) where.eligibility = narrow.eligibility
  return where
}
```

Change the signature and the four `where`s in `getSummary`:

```ts
export async function getSummary(db: Db, narrow: SummaryNarrowing = {}) {
  // Applied to ALL FOUR figures, the disclosure included: a narrowed screen
  // whose "excluding N with no amount" line still counted the whole database
  // would be a number nobody could reconcile with the cards above it.
  const scope = narrowingWhere(narrow)
  const [grouped, currencyAgg, total, incomplete] = await Promise.all([
    db.check.groupBy({ by: ['status'], _count: { _all: true }, where: { ...scope, ...COMPLETE_ONLY } }),
    db.check.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      _count: { _all: true },
      where: { ...scope, status: { not: 'CANCELLED' } },
    }),
    db.check.count({ where: { ...scope, ...COMPLETE_ONLY } }),
    db.check.count({ where: { ...scope, isIncomplete: true } }),
  ])
```

Keep every existing comment inside that block where it stands; only the `where` values change.

`getTodaysRelease` and `listTodaysReleaseIds`:

```ts
export async function getTodaysRelease(db: Db, narrow: SummaryNarrowing = {}): Promise<TodaysRelease> {
  // The same narrowing the cards read, spread over the same filter RELEASE ALL
  // reads below — the panel and the button are one set, narrowed or not.
  const where = buildWhere({ ...TODAYS_RELEASE_FILTER, ...narrow })
```

```ts
export async function listTodaysReleaseIds(db: Db, narrow: SummaryNarrowing = {}): Promise<string[]> {
  const rows = await db.check.findMany({
    where: buildWhere({ ...TODAYS_RELEASE_FILTER, ...narrow }),
```

- [ ] **Step 4: Run the file and the type check**

Run: `node node_modules/vitest/vitest.mjs run tests/queries.test.ts`
Expected: PASS (the whole file, so the unnarrowed cases still hold).

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/queries.ts tests/queries.test.ts
git -c core.autocrlf=false commit -m "feat(queries): getSummary, getTodaysRelease and listTodaysReleaseIds take the company/bank/eligibility narrowing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: RELEASE ALL honours the filter

**Files:**
- Modify: `app/checks/bulk-actions.ts` (`releaseAllReadyAction`)
- Modify: `components/ReleaseAllConfirm.tsx`, `components/TodaysReleasePanel.tsx`
- Test: `tests/actions/bulk-actions.test.ts`

**Interfaces:**
- Consumes: `listTodaysReleaseIds(db, narrow)` from Task 4; `getFilterOptions`, `parseOptionId`, `parseEligibilityParam` from `lib/queries.ts` (exist).
- Produces: `ReleaseAllConfirm` and `TodaysReleasePanel` take `narrow: { company: string; cashAccount: string; eligibility: string }` (empty string = not set) and write hidden inputs `company`, `cashAccount`, `eligibility`. The action reads them; a present-but-unrecognised value refuses.

- [ ] **Step 1: Write the failing tests**

In `tests/actions/bulk-actions.test.ts`, inside `describe('releaseAllReadyAction')`, append:

```ts
  /**
   * The TOTALS screen can be narrowed to one company or bank (2026-09-29), and
   * the panel then counts that company's ready cheques. The button beneath it
   * must release exactly those: a RELEASE ALL 12 that released 81 is the
   * mismatch this dashboard exists to prevent, and it is money. The server
   * re-derives the set from the same filter the panel counted.
   */
  it('releases only the ready cheques of the company on screen', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const mine = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const other = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await releaseAllReadyAction(
      null, fd([], { confirm: 'release', expectedCount: '1', company: mine.companyId }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('READY_FOR_RELEASE')
    expect(result.outcomes.some((o) => o.checkId === other.id)).toBe(false)
  })

  it('narrows by cash account and by eligibility the same way', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const broker = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'BROKER' })
    const supplier = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })

    const byAccount = await releaseAllReadyAction(
      null, fd([], { confirm: 'release', expectedCount: '1', cashAccount: broker.cashAccountId }),
    )
    expect(byAccount.ok).toBe(true)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: broker.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: supplier.id } })).status).toBe('READY_FOR_RELEASE')

    const byEligibility = await releaseAllReadyAction(
      null, fd([], { confirm: 'release', expectedCount: '1', eligibility: 'SUPPLIER' }),
    )
    expect(byEligibility.ok).toBe(true)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: supplier.id } })).status).toBe('RELEASED')
  })

  /**
   * A filter that is present but names nothing is refused, not dropped.
   * Dropping it would silently widen the set from one company to every
   * company — the one failure this step must never have.
   */
  it('refuses, and releases nothing, when the filter on the form is not recognised', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    for (const bad of [{ company: 'co-gone' }, { cashAccount: 'ca-gone' }, { eligibility: 'MAYBE' }]) {
      const result = await releaseAllReadyAction(
        null, fd([], { confirm: 'release', expectedCount: '1', ...bad }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toMatch(/filter/i)
    }
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts -t "company on screen"`
Expected: FAIL — both cheques released (the action ignores `company`), so `other` reads `RELEASED`.

- [ ] **Step 3: Implement the action**

In `app/checks/bulk-actions.ts`, extend the import from `@/lib/queries`:

```ts
import {
  listTodaysReleaseIds, getFilterOptions, parseOptionId, parseEligibilityParam,
  type SummaryNarrowing,
} from '@/lib/queries'
```

Add a helper below `str`:

```ts
/**
 * The narrowing the TOTALS screen was showing when RELEASE ALL was pressed,
 * read back off the form. `null` means a value was present and is not
 * recognised — the caller refuses, because dropping it would silently widen
 * the set from one company to every company. An absent value is no narrowing:
 * the unfiltered screen, and the behaviour before 2026-09-29.
 */
async function readReleaseNarrowing(formData: FormData): Promise<SummaryNarrowing | null> {
  const company = str(formData, 'company')
  const cashAccount = str(formData, 'cashAccount')
  const eligibility = str(formData, 'eligibility')
  if (!company && !cashAccount && !eligibility) return {}

  const options = await getFilterOptions(prisma)
  const companyId = parseOptionId(company || undefined, options.companies)
  const cashAccountId = parseOptionId(cashAccount || undefined, options.cashAccounts)
  const elig = parseEligibilityParam(eligibility || undefined)
  if ((company && !companyId) || (cashAccount && !cashAccountId) || (eligibility && !elig)) return null
  return { companyId, cashAccountId, eligibility: elig }
}
```

In `releaseAllReadyAction`, replace the line `const checkIds = await listTodaysReleaseIds(prisma)` with:

```ts
  const narrow = await readReleaseNarrowing(formData)
  if (narrow === null) {
    return {
      ok: false,
      message: 'The filter on screen was not recognised. Open TODAY’S RELEASE again and re-read the figures.',
    }
  }
  const checkIds = await listTodaysReleaseIds(prisma, narrow)
```

- [ ] **Step 4: Carry the narrowing through the panel**

`components/ReleaseAllConfirm.tsx` — add the prop and the hidden inputs:

```tsx
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
```

Inside the `<form>`, after the `expectedCount` input:

```tsx
          {narrow.company && <input type="hidden" name="company" value={narrow.company} />}
          {narrow.cashAccount && <input type="hidden" name="cashAccount" value={narrow.cashAccount} />}
          {narrow.eligibility && <input type="hidden" name="eligibility" value={narrow.eligibility} />}
```

`components/TodaysReleasePanel.tsx` — accept and pass it:

```tsx
import { ReleaseAllConfirm, type ReleaseNarrowing } from './ReleaseAllConfirm'

export function TodaysReleasePanel({
  todays, canRelease, confirming, confirmHref, cancelHref, narrow,
}: {
  todays: TodaysRelease
  canRelease: boolean
  confirming: boolean
  confirmHref: string
  cancelHref: string
  narrow: ReleaseNarrowing
}) {
```

and `<ReleaseAllConfirm count={count} cancelHref={cancelHref} narrow={narrow} />`.

`app/page.tsx` will not compile until it passes `narrow`; Task 6 wires it. To keep this task green on its own, add the prop in `app/page.tsx` now with the values already resolved there:

```tsx
        <TodaysReleasePanel
          todays={todaysRelease}
          canRelease={user.role === 'FINANCE_ADMIN'}
          confirming={params.confirm === 'release'}
          confirmHref={releaseConfirmHref(selection)}
          cancelHref={releaseCancelHref(selection)}
          narrow={{ company: companyId ?? '', cashAccount: cashAccountId ?? '', eligibility: eligibility ?? '' }}
        />
```

- [ ] **Step 5: Run the file and the type check**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts`
Expected: PASS.

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add app/checks/bulk-actions.ts components/ReleaseAllConfirm.tsx components/TodaysReleasePanel.tsx app/page.tsx tests/actions/bulk-actions.test.ts
git -c core.autocrlf=false commit -m "feat(release): RELEASE ALL releases the set the narrowed panel counted; an unrecognised filter refuses

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The TOTALS filter bar, and the page narrows everything

**Files:**
- Create: `components/TotalsFilterBar.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `getSummary(prisma, narrow)`, `getTodaysRelease(prisma, narrow)` (Task 4); `narrowingDescription` (Task 1); `bankLabel`; `FilterAutoSubmit`.
- Produces: the TOTALS screen renders `<TotalsFilterBar>` above the cards; the search form carries the three filters as hidden inputs.

- [ ] **Step 1: Create `components/TotalsFilterBar.tsx`**

```tsx
import Link from 'next/link'
import { ELIGIBILITIES } from '@/lib/queries'
import type { FilterOptions } from '@/lib/queries'
import { bankLabel } from '@/lib/export/report'
import { FilterAutoSubmit } from './FilterAutoSubmit'

const APPLY_ID = 'totals-filter-apply'

/**
 * The TOTALS screen's filter bar (client request 2026-09-29: "should have
 * filter in every summary").
 *
 * COMPANY, BANK / CASH ACCOUNT and ELIGIBILITY — the three narrowing filters
 * the list already reads, under the same parameter names, so a card on a
 * narrowed screen links to the list narrowed the same way. Submitting writes
 * `/?company=…`, which `dashboardScreen` keeps on TOTALS: every figure on the
 * screen narrows, and nothing opens the list.
 *
 * No search box here. The search form beneath the cards stays a plain submit,
 * because `FilterAutoSubmit` would navigate to the list after 400 ms of typing
 * and lose the caret; it carries these three as hidden fields instead.
 *
 * The bank label comes from `bankLabel`, which the list's bar and the export
 * use, so the three cannot spell an account differently.
 */
export function TotalsFilterBar({
  options, companyId, cashAccountId, eligibility, description,
}: {
  options: FilterOptions
  companyId: string
  cashAccountId: string
  eligibility: string
  /** `narrowingDescription` from `resolveDashboardQuery`; printed only when a filter is set. */
  description: string
}) {
  const anyFilter = Boolean(companyId || cashAccountId || eligibility)

  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <section className="space-y-2">
      <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
        <label className="sr-only" htmlFor="totals-company">COMPANY</label>
        <select id="totals-company" name="company" defaultValue={companyId} className={field}>
          <option value="">ALL COMPANIES</option>
          {options.companies.map((c) => (
            <option key={c.id} value={c.id}>{c.code}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="totals-cash-account">BANK / CASH ACCOUNT</label>
        <select id="totals-cash-account" name="cashAccount" defaultValue={cashAccountId} className={field}>
          <option value="">ALL BANKS / CASH ACCOUNTS</option>
          {options.cashAccounts.map((a) => (
            <option key={a.id} value={a.id}>{bankLabel(a.code, a.bankCode)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="totals-eligibility">ELIGIBILITY</label>
        <select id="totals-eligibility" name="eligibility" defaultValue={eligibility} className={field}>
          <option value="">ALL ELIGIBILITIES</option>
          {ELIGIBILITIES.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>

        <button id={APPLY_ID} type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium text-white">
          APPLY
        </button>

        {anyFilter && (
          <Link href="/" className="h-10 rounded-lg px-3 py-2 text-sm font-medium text-navy underline underline-offset-2 hover:text-slate-900">
            RESET
          </Link>
        )}

        <FilterAutoSubmit applyButtonId={APPLY_ID} />
      </form>

      {/* A narrowed screen that did not say so would read as the whole
          company's figures. Stated once, under the bar; the incomplete
          exclusion has its own line with a count beneath the cards. */}
      {anyFilter && (
        <p className="text-xs font-medium tracking-wide text-slate-600">
          SHOWING {description}
        </p>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Wire `app/page.tsx`**

Import the component:

```tsx
import { TotalsFilterBar } from '@/components/TotalsFilterBar'
```

The summary now depends on the resolved filters, so the fetch order changes. Replace the block from `// The summary does not depend on the filters` through the `resolveDashboardQuery(...)` destructuring with:

```tsx
  // The dropdown options and the settings do not depend on the URL, so they
  // are fetched first; the summary does, since 2026-09-29 ("should have filter
  // in every summary"), so it is fetched once the URL is resolved below.
  // `settings` rides along so the sync overview's thresholds, and everything
  // below that reads a setting, come from the same read every screen shares
  // rather than a hard-coded default nobody can change.
  const [options, settings] = await Promise.all([
    getFilterOptions(prisma),
    loadSettings(prisma),
  ])

  /**
   * Every URL parameter is validated, the view is resolved and the filters are
   * assembled — all of it in `resolveDashboardQuery`, which is the ONE place
   * that turns a dashboard URL into a query.
   *
   * It lives outside this file because `app/api/export/route.ts` and
   * `app/print/page.tsx` run it too. The Excel export and the printed sheet
   * have to hold exactly what the reader is looking at, and the only way to
   * guarantee that is for all three to run the same code: a second parser that
   * agreed today would drift the first time a filter is added to one of them.
   *
   * The company and cash account ids are checked against the options loaded
   * above — the same list the dropdowns render, so the two cannot disagree
   * about what is selectable.
   *
   * The cards share THREE narrowings with the table — company, bank and
   * eligibility (client request 2026-09-29) — and the exclusion of the cheques
   * with no recorded amount. They do NOT share the view, the search or the
   * incomplete toggle: those open the list. `getSummary` applies the
   * exclusion itself, `buildWhere` applies it for the table, and a PENDING
   * SIGNATURE card whose table opened five rows short is the drift that would
   * otherwise appear the moment the table stopped showing them. The count that
   * is left out is printed on screen with a link that shows it.
   */
  const {
    q, status, companyId, cashAccountId, eligibility, incomplete, showAll, selection, filters,
    releasedFrom, releasedTo, narrowingDescription,
  } = resolveDashboardQuery(params, options)

  const narrow = { companyId, cashAccountId, eligibility }
  const summary = await getSummary(prisma, narrow)
```

In the TOTALS branch, change `getTodaysRelease(prisma)` to `getTodaysRelease(prisma, narrow)` and delete the comment line `// TOTALS never narrows, so ...` above it (replace with `// TODAY'S RELEASE narrows with the cards; the sync overview is system-wide.`).

Render the bar between `<SyncStatusLine …/>` and `<SummaryCards …/>`:

```tsx
        <TotalsFilterBar
          options={options}
          companyId={companyId ?? ''}
          cashAccountId={cashAccountId ?? ''}
          eligibility={eligibility ?? ''}
          description={narrowingDescription}
        />
```

Add the hidden fields to the search form, before the `<label htmlFor="totals-search">`:

```tsx
          {/* A search from a narrowed TOTALS opens a list narrowed the same way. */}
          {companyId && <input type="hidden" name="company" value={companyId} />}
          {cashAccountId && <input type="hidden" name="cashAccount" value={cashAccountId} />}
          {eligibility && <input type="hidden" name="eligibility" value={eligibility} />}
```

The `<TodaysReleasePanel narrow=…/>` prop was added in Task 5 and stays.

- [ ] **Step 3: Type check and build**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

Run: `npx.cmd next build` (PowerShell) or `node node_modules/next/dist/bin/next build` (Bash)
Expected: build succeeds; `/` compiles as a dynamic route. Do not start the dev server — the local `.env` is production.

- [ ] **Step 4: Run the touched test files together**

Run: `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/export/dashboard-params.test.ts tests/dashboard-links.test.ts tests/release-timeline.test.ts tests/queries.test.ts tests/actions/bulk-actions.test.ts tests/export/report.test.ts tests/export/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/TotalsFilterBar.tsx app/page.tsx
git -c core.autocrlf=false commit -m "feat(dashboard): COMPANY / BANK / ELIGIBILITY filters on the TOTALS screen narrow every figure on it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (the "The dashboard has two screens" paragraph under *Things that will catch you out*; the test count in *State*)

- [ ] **Step 1: Update the two-screens paragraph**

Replace the paragraph beginning `**The dashboard has two screens, and the URL decides which**` with:

```md
**The dashboard has two screens, and the URL decides which** (`dashboardScreen` in
`lib/dashboard-view.ts`, client request 2026-09-25). A bare `/` is TOTALS — cards, TODAY'S
RELEASE, timeline, a search box — and loads no rows. **Since 2026-09-29 so is a URL carrying
only `company`, `cashAccount` or `eligibility`** ("should have filter in every summary"): the
TOTALS screen has those three dropdowns (`components/TotalsFilterBar.tsx`) and every figure on
it narrows — `getSummary`, `getTodaysRelease` and `listTodaysReleaseIds` take the narrowing, so
RELEASE ALL releases the set the narrowed panel counted and refuses an unrecognised filter
rather than widening. A card, `scope=all`, `incomplete=1`, a search, or **`scope=live`** opens
LIST. `scope=live` is the NEEDS ACTION list said out loud: the list's filter bar carries it on
that view so filtering inside the list cannot land on `/?company=…`, which is now the totals.
ALL CHECKS (card id `TOTAL_CHECKS`, `scope=all`) is a primary card and **keeps the filters**
like every other card — it is the cheque inventory; it no longer clears them. Export and print
read the same URL and know nothing about screens.
```

- [ ] **Step 2: Update the test count**

Count the new cases: Task 1 adds 4 in `dashboard-view` (+1 rewritten) and 3 in `dashboard-params`; Task 2 rewrites 1; Task 3 adds 1 in `dashboard-links`; Task 4 adds 6 in `queries`; Task 5 adds 3 in `bulk-actions`. Net **+17**. In the *State* section, change `**1,519 tests across 113 files**` to `**1,536 tests across 113 files**` and prepend to the history list: `1,519 across 113 before the TOTALS-screen filters and ALL CHECKS (`dashboard-view` +4, `export/dashboard-params` +3, `dashboard-links` +1, `queries` +6, `actions/bulk-actions` +3);`. If the actual numbers from the runs differ, write the measured ones.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git -c core.autocrlf=false commit -m "docs: TOTALS-screen filters, scope=live and ALL CHECKS as the inventory view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
