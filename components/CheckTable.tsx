'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatMoney } from '@/lib/money'
import { RECEIPT_TYPES } from '@/lib/domain/receipt'
import {
  isTickable, takesReceipt, draftTypeMissing, EMPTY_DRAFT, type ReceiptDraft,
} from '@/lib/row-receipts'
import {
  COLUMN_KEYS, COLUMN_LABELS, ALWAYS_ON, DEFAULT_COLUMNS, COLUMN_STORAGE_KEY,
  parseColumnPreference, serialiseColumnPreference, columnControls,
  type ColumnKey,
} from '@/lib/table-columns'
import type { SortKey, SortSpec } from '@/lib/list-sort'
import type { SortLink } from '@/lib/dashboard-view'
import { writeSortCookie } from './sort-cookie'
import { StatusPill } from './StatusPill'
import { BulkActionBar } from './BulkActionBar'
import { ColumnFilterCell, type FilterRowState } from './ColumnFilterCell'
import type { CheckTableRow } from '@/lib/queries'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/**
 * A cheque can be ticked if a bulk action could conceivably apply to it: a
 * live cheque, as before, or a RELEASED one still waiting for its receipt — a
 * late receipt is typed by ticking the row and filling its OR box.
 * `isTickable` (`lib/row-receipts.ts`) is the same predicate the domain and the
 * server actions share — restating the list here is how the two would drift.
 *
 * This is presentation, not a control. Every refusal is re-decided by
 * `lib/domain/actions.ts` on the server, which is why a hidden checkbox can
 * never be the reason a cheque was not released.
 */
const selectable = isTickable

/** Every column but ACTION, which is pinned last and rendered after OR / CR. */
type DataColumn = Exclude<ColumnKey, 'action'>

const isAlwaysOn = (k: ColumnKey) => (ALWAYS_ON as readonly ColumnKey[]).includes(k)

const headerClass = (key: DataColumn) => (key === 'amount' ? 'px-2 py-2 text-right' : 'px-2 py-2')

/**
 * A sortable header: asc → desc → default (spec C1). The link is built on the
 * server (`sortLinks`); the click writes or deletes the `cm_sort` cookie before
 * the navigation so the next render — and the next visit — use it.
 */
function SortHeader({ column, sort, link }: { column: DataColumn; sort: SortSpec; link: SortLink }) {
  const active = sort.key === column ? sort.dir : null
  return (
    <th
      className={headerClass(column)}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
    >
      <Link
        prefetch={false}
        scroll={false}
        href={link.href}
        onClick={(e) => {
          // Ctrl/cmd/shift/alt or middle click opens a new tab or window: this
          // page does not navigate, so its remembered sort must not change.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
          writeSortCookie(link.next)
        }}
        className="inline-flex items-center gap-1 hover:text-slate-900"
      >
        {COLUMN_LABELS[column]}
        <span aria-hidden className={active ? 'text-navy' : 'text-slate-300'}>
          {active === 'asc' ? '▲' : active === 'desc' ? '▼' : '↕'}
        </span>
      </Link>
    </th>
  )
}

/** One data cell. The markup of each case is the cell the table rendered before part C. */
function DataCell({ column, r }: { column: DataColumn; r: CheckTableRow }) {
  switch (column) {
    case 'checkNumber':
      return <td className="px-2 py-2 font-medium">{r.checkNumber}</td>
    case 'apvNumbers':
      return <td className="px-2 py-2 text-slate-600">{r.apvNumbers.length ? r.apvNumbers.join(', ') : '—'}</td>
    case 'poNumbers':
      return <td className="px-2 py-2 text-slate-600">{r.poNumbers.length ? r.poNumbers.join(', ') : '—'}</td>
    case 'payeeName':
      return (
        <td className="px-2 py-2">
          {/* An em dash, not the bare null React would render as nothing:
              153 register rows have no payee, and an empty cell reads as a
              rendering bug rather than as a fact about the cheque. Matches
              fmtDate and the APV column above. */}
          {r.payeeName ?? '—'}
          {r.eligibility === 'INTERNAL' && (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tracking-wide text-slate-600">
              INTERNAL
            </span>
          )}
        </td>
      )
    case 'companyCode':
      return <td className="px-2 py-2 text-slate-600">{r.companyCode}</td>
    case 'bank':
      // The cash account code, because "BPI STK" is the label Finance uses;
      // the bank code is the title, for the reader who knows the institution
      // but not the account. An em dash where no cash account is recorded —
      // the column is nullable.
      return <td className="px-2 py-2 text-slate-600" title={r.bankCode ?? undefined}>{r.cashAccountCode ?? '—'}</td>
    case 'checkDate':
      return <td className="px-2 py-2 text-slate-600">{fmtDate(r.checkDate)}</td>
    case 'amount':
      // Right-aligned and tabular, so the decimal points line up down the
      // column and an eight-figure amount is visibly an eight-figure amount.
      return <td className="px-2 py-2 text-right font-medium tabular-nums">{formatMoney(r.amount, r.currency)}</td>
    case 'status':
      // STALED: Finance's word for a cheque past its presentment life (ruling
      // 2026-10-06). It stays CANCELLED; the tag says why.
      return (
        <td className="px-2 py-2">
          <StatusPill status={r.status} />
          {r.isStale && <span className="ml-1 text-[10px] font-semibold tracking-widest text-amber-700">STALED</span>}
        </td>
      )
    case 'availablePickupDate':
      return <td className="px-2 py-2 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
    case 'scheduledPickupDate':
      return <td className="px-2 py-2 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
    case 'releasedAt':
      // The app's own timestamp when it has one; otherwise the day the retired
      // register stated, tagged so nobody reads a spreadsheet date as a release
      // this system recorded.
      return (
        <td className="px-2 py-2 text-slate-600">
          {r.releasedAt
            ? fmtDate(r.releasedAt)
            : r.statedReleaseDate
              ? <>{fmtDate(r.statedReleaseDate)}<span className="ml-1 text-[10px] font-semibold tracking-widest text-slate-400">REGISTER</span></>
              : '—'}
        </td>
      )
    default: {
      const unreachable: never = column
      return unreachable
    }
  }
}

export function CheckTable({
  rows, canRelease, bulkCap, sort, sortLinks, filters,
}: {
  rows: CheckTableRow[]
  canRelease: boolean
  bulkCap: number
  /** The order in force (URL, cookie or default) — which header shows an arrow. */
  sort: SortSpec
  sortLinks: Readonly<Record<SortKey, SortLink>>
  /** The filter row's state, from the server: values to render back, refusals, which boxes apply. */
  filters: FilterRowState
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // Keyed by check id. A row's draft is read back on release and on SAVE
  // RECEIPTS (`lib/row-receipts.ts`'s `receiptEntries`), which is what lets a
  // batch carry more than one supplier's receipt safely — each has exactly one
  // owner, the row it was typed in.
  const [drafts, setDrafts] = useState<Record<string, ReceiptDraft>>({})

  /**
   * The viewer's columns, IN ORDER (part C3).
   *
   * Starts at the default and is corrected in an effect, never read during
   * render. `localStorage` does not exist on the server, so reading it in the
   * initial state would break the server render outright; and reading it lazily
   * on the client would make the first paint differ from the server's and
   * hydrate mismatched. Defaulting to the FULL set means a fresh browser, a
   * slow one, and one with site data blocked all show a working table rather
   * than a flash of nothing.
   */
  const [preference, setPreference] = useState<readonly ColumnKey[]>(DEFAULT_COLUMNS)

  useEffect(() => {
    try {
      const stored = parseColumnPreference(window.localStorage.getItem(COLUMN_STORAGE_KEY))
      // Null means no usable preference — absent, empty or corrupt — and the
      // full table already on screen is the right answer to that.
      if (stored) setPreference(stored)
    } catch {
      // A private window, or a browser set to block site data, throws on the
      // accessor itself. A display preference is never worth an error boundary.
    }
  }, [])

  // A column with a filter in force is never hidden (part C2).
  // Shown: the preference plus the filtered columns. Edited and saved: the
  // preference alone — see columnControls.
  const columns = columnControls(preference, filters.filteredColumns)
  const visible = columns.visible
  const shown = visible.filter((k): k is DataColumn => k !== 'action')
  const hidden = COLUMN_KEYS.filter((k): k is DataColumn => k !== 'action' && !visible.includes(k))

  const persist = (next: readonly ColumnKey[]) => {
    setPreference(next)
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, serialiseColumnPreference(next))
    } catch {
      // The choice still applies to this session; it simply will not be
      // remembered. Nothing here is worth failing the page over.
    }
  }

  const selectableRows = rows.filter(selectable)
  // Only ids still on screen count. A filter change re-renders with different
  // rows, and a stale id would put a cheque the user can no longer see into a
  // batch they thought they were reading.
  const selectedIds = rows.filter((r) => selected.has(r.id)).map((r) => r.id)
  const allSelected = selectableRows.length > 0 && selectedIds.length === selectableRows.length

  const toggle = (id: string) => {
    // Read outside the updater: a `setSelected` updater must stay pure, and
    // React can invoke it twice in development, which would fire the
    // `setDrafts` side effect below twice for one click.
    const wasSelected = selected.has(id)
    setSelected((prev) => {
      const next = new Set(prev)
      if (wasSelected) next.delete(id)
      else next.add(id)
      return next
    })
    if (wasSelected) {
      // Unticking a row throws away whatever it had typed. Left ticked, its
      // box is closed too — clearing on tick, not on close, keeps the box's
      // contents attached to the tick that opened it.
      setDrafts((d) => {
        if (!(id in d)) return d
        const { [id]: _omit, ...rest } = d
        return rest
      })
    }
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set())
      setDrafts({})
    } else {
      setSelected(new Set(selectableRows.map((r) => r.id)))
    }
  }

  const open = (id: string) => router.push(`/checks/${id}`)

  const arrow = 'h-6 w-6 rounded border border-hairline text-[10px] leading-none text-slate-600 disabled:opacity-30'

  /**
   * The column chooser: show/hide, and ◀ ▶ to move (part C3). Outside the
   * table, for the reason it always was: a reader who narrowed the table to
   * three columns must be able to widen it again.
   */
  const picker = (
    <details className="rounded-2xl bg-white p-3 ring-1 ring-hairline">
      <summary className="cursor-pointer select-none text-xs font-medium tracking-wide text-slate-600">
        COLUMNS ({visible.length} OF {COLUMN_KEYS.length})
      </summary>
      <ol className="mt-3 space-y-1 border-t border-slate-100 pt-3">
        {shown.map((key) => (
          <li key={key} className="flex items-center gap-2 text-xs tracking-wide text-slate-700">
            <button type="button" className={arrow} aria-label={`Move ${COLUMN_LABELS[key]} left`}
              disabled={!columns.canMove(key, -1)} onClick={() => persist(columns.move(key, -1))}>◀</button>
            <button type="button" className={arrow} aria-label={`Move ${COLUMN_LABELS[key]} right`}
              disabled={!columns.canMove(key, 1)} onClick={() => persist(columns.move(key, 1))}>▶</button>
            {isAlwaysOn(key) ? (
              <span>{COLUMN_LABELS[key]} <span className="text-slate-400">(ALWAYS SHOWN)</span></span>
            ) : (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox" checked onChange={() => persist(columns.toggle(key))}
                  disabled={filters.filteredColumns.includes(key)}
                  title={filters.filteredColumns.includes(key) ? 'FILTERED — CLEAR ITS FILTER TO HIDE IT' : undefined}
                />
                {COLUMN_LABELS[key]}
              </label>
            )}
          </li>
        ))}
        {hidden.map((key) => (
          <li key={key} className="flex items-center gap-2 pl-16 text-xs tracking-wide text-slate-500">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={false} onChange={() => persist(columns.toggle(key))} />
              {COLUMN_LABELS[key]}
            </label>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-slate-500">
        ◀ ▶ MOVE A COLUMN. ACTION IS ALWAYS LAST. THE ORDER IS REMEMBERED IN THIS BROWSER AND USED BY EXPORT EXCEL.
      </p>
    </details>
  )

  return (
    <div className="space-y-3">
      {picker}

      {/* Scrolls in BOTH directions, and the vertical scroll is what makes the
          sticky header work: a sticky element pins to its nearest SCROLLING
          ancestor, and a container that only scrolls sideways — height set by
          its content — gives it nothing to stick to. The capped height gives it
          one. Two hundred rows of cheque numbers under a header that has
          scrolled off the top is a table nobody can read. */}
      <div className="max-h-[80vh] overflow-auto rounded-2xl bg-white ring-1 ring-hairline">
        <table className="w-full text-[13px]">
          {/* Opaque, not tinted: a translucent header would let the banded rows
              show through it as they scroll underneath. The bottom rule is an
              inset shadow rather than a border, because a border on a sticky
              header scrolls away with the cell box in some browsers. */}
          <thead className="sticky top-0 z-10 bg-white text-left text-xs tracking-wide text-slate-500 shadow-[inset_0_-1px_0_#E5E7EB]">
            <tr>
              <th className="px-2 py-2">
                <input
                  type="checkbox" checked={allSelected} onChange={toggleAll}
                  disabled={selectableRows.length === 0}
                  aria-label="Select every actionable check on this page"
                />
              </th>
              {shown.map((key) => <SortHeader key={key} column={key} sort={sort} link={sortLinks[key]} />)}
              <th className="px-2 py-2">OR / CR</th>
              <th className="px-2 py-2">{COLUMN_LABELS.action}</th>
            </tr>
            {/* THE FILTER ROW (part C2). Keyed on the dropdown values for the
                reason FilterBar's form is: a soft navigation that changes them
                from elsewhere leaves a mounted <select> showing the old one. */}
            <tr key={`${filters.values.company ?? ''}|${filters.values.cashAccount ?? ''}|${filters.values['f.status'] ?? ''}`} className="align-top">
              <th className="px-2 pb-2" />
              {shown.map((key) => (
                <th key={key} className="px-2 pb-2 font-normal">
                  <ColumnFilterCell column={key} state={filters} />
                </th>
              ))}
              <th className="px-2 pb-2" />
              <th className="px-2 pb-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              // Kept inside the table (part C2): the headers — and, from the
              // filter row, the boxes — must survive a filter that matches nothing.
              <tr>
                <td colSpan={shown.length + 3} className="p-8 text-center text-sm text-slate-500">
                  NO CHECKS MATCH THESE FILTERS.
                </td>
              </tr>
            ) : rows.map((r) => (
              // The whole row navigates: the cheque number alone was a
              // few-pixel target in a table this wide. The row is focusable and
              // answers Enter, and the OPEN link at the end survives as the
              // real anchor — a div with an onClick is not a link to a screen
              // reader, and middle-click and "open in new tab" have to keep
              // working.
              <tr
                key={r.id}
                onClick={() => open(r.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') open(r.id) }}
                tabIndex={0}
                // Banded, so the eye can carry a row across eleven columns
                // without losing its place. Hover and focus are declared after
                // the bands so they win on both the odd and the even rows —
                // a hover tint the banding beats is a hover tint that flickers.
                className="cursor-pointer border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg focus:bg-navy-bg focus:outline-none"
              >
                {/* The tick-box must not navigate. Stopping the event on the
                    cell, not just the input, keeps the generous click target
                    the padding gives it. */}
                <td
                  className="px-2 py-2"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {selectable(r) ? (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select check ${r.checkNumber}`}
                    />
                  ) : (
                    // Deliberately not a disabled checkbox: a released or
                    // cancelled cheque is not a thing the user failed to tick,
                    // and an empty cell says so more quietly.
                    <span className="sr-only">Not actionable</span>
                  )}
                </td>
                {shown.map((key) => <DataCell key={key} column={key} r={r} />)}
                {/* The supplier's receipt. A ticked row that can carry one gets
                    its own box, which is what lets a batch carry receipts safely:
                    every reference has exactly one cheque. Keys and clicks stop
                    here so typing never opens the cheque (the row navigates on
                    click and on Enter). */}
                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {/* A live (READY/SCHEDULED) row's box is useful only to
                      someone who can press MARK RELEASED — that is the only
                      action that reads it. A RELEASED row keeps its box for
                      everyone, because SAVE RECEIPTS is open to any Finance
                      user. */}
                  {selected.has(r.id) && takesReceipt(r) && (r.status === 'RELEASED' || canRelease) ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Receipt type for check ${r.checkNumber}`}
                        aria-invalid={draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT)}
                        value={(drafts[r.id] ?? EMPTY_DRAFT).receiptType}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...(d[r.id] ?? EMPTY_DRAFT), receiptType: e.target.value as ReceiptDraft['receiptType'] } }))}
                        className={`rounded-lg border px-2 py-1 text-sm ${draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT) ? 'border-amber-500' : 'border-slate-300'}`}
                      >
                        <option value="">OR / CR</option>
                        {RECEIPT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input
                        aria-label={`Receipt reference for check ${r.checkNumber}`}
                        value={(drafts[r.id] ?? EMPTY_DRAFT).orNumber}
                        placeholder="Reference"
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...(d[r.id] ?? EMPTY_DRAFT), orNumber: e.target.value } }))}
                        className="w-32 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                  ) : r.orNumber ? (
                    <span>{r.orNumber} <span className="text-xs text-slate-500">({r.receiptType ?? '?'})</span></span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                  <Link prefetch={false} href={`/checks/${r.id}`} className="text-sm font-medium text-slate-900 underline underline-offset-2">
                    OPEN
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedRows={rows.filter((r) => selected.has(r.id))}
          drafts={drafts}
          canRelease={canRelease}
          cap={bulkCap}
          onDone={() => { setSelected(new Set()); setDrafts({}) }}
        />
      )}
    </div>
  )
}
