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
  normaliseColumns, parseColumnPreference, serialiseColumnPreference,
  type ColumnKey,
} from '@/lib/table-columns'
import { StatusPill } from './StatusPill'
import { BulkActionBar } from './BulkActionBar'
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

const OPTIONAL_COLUMNS = COLUMN_KEYS.filter(
  (key) => !(ALWAYS_ON as readonly ColumnKey[]).includes(key),
)

export function CheckTable({
  rows, canRelease, bulkCap,
}: {
  rows: CheckTableRow[]
  canRelease: boolean
  bulkCap: number
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // Keyed by check id. A row's draft is read back on release and on SAVE
  // RECEIPTS (`lib/row-receipts.ts`'s `receiptEntries`), which is what lets a
  // batch carry more than one supplier's receipt safely — each has exactly one
  // owner, the row it was typed in.
  const [drafts, setDrafts] = useState<Record<string, ReceiptDraft>>({})

  /**
   * Which columns to draw.
   *
   * Starts at every column and is corrected in an effect, never read during
   * render. `localStorage` does not exist on the server, so reading it in the
   * initial state would break the server render outright; and reading it lazily
   * on the client would make the first paint differ from the server's and
   * hydrate mismatched. Defaulting to the FULL set means a fresh browser, a
   * slow one, and one with site data blocked all show a working table rather
   * than a flash of nothing.
   */
  const [visible, setVisible] = useState<readonly ColumnKey[]>(DEFAULT_COLUMNS)

  useEffect(() => {
    try {
      const stored = parseColumnPreference(window.localStorage.getItem(COLUMN_STORAGE_KEY))
      // Null means no usable preference — absent, empty or corrupt — and the
      // full table already on screen is the right answer to that.
      if (stored) setVisible(stored)
    } catch {
      // A private window, or a browser set to block site data, throws on the
      // accessor itself. A display preference is never worth an error boundary.
    }
  }, [])

  const shows = (key: ColumnKey) => visible.includes(key)

  const toggleColumn = (key: ColumnKey) => {
    // Computed from the current value rather than inside the state updater: the
    // updater must stay pure, and React invokes it twice in development.
    const next = normaliseColumns(
      visible.includes(key) ? visible.filter((c) => c !== key) : [...visible, key],
    )
    setVisible(next)
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

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.delete(id)) {
      // Unticking a row throws away whatever it had typed. Left ticked, its
      // box is closed too — clearing on tick, not on close, keeps the box's
      // contents attached to the tick that opened it.
      setDrafts((d) => {
        if (!(id in d)) return d
        const { [id]: _omit, ...rest } = d
        return rest
      })
    } else {
      next.add(id)
    }
    return next
  })

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set())
      setDrafts({})
    } else {
      setSelected(new Set(selectableRows.map((r) => r.id)))
    }
  }

  const open = (id: string) => router.push(`/checks/${id}`)

  /**
   * The column chooser sits outside the empty-table branch on purpose. Hiding
   * it when nothing matched would strand a user who had narrowed the table to
   * three columns with no way to widen it again.
   */
  const picker = (
    <details className="rounded-2xl bg-white p-3 ring-1 ring-hairline">
      <summary className="cursor-pointer select-none text-xs font-medium tracking-wide text-slate-600">
        COLUMNS ({visible.length} OF {COLUMN_KEYS.length})
      </summary>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-100 pt-3">
        {OPTIONAL_COLUMNS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-xs tracking-wide text-slate-700">
            <input type="checkbox" checked={shows(key)} onChange={() => toggleColumn(key)} />
            {COLUMN_LABELS[key]}
          </label>
        ))}
        {/* Shown, not offered. A row whose number, status or action is hidden
            cannot be identified, read or opened — that is not a narrower table.
            Stated here rather than rendered as three disabled tick-boxes,
            which would read as choices the user failed to make. */}
        <p className="w-full text-xs text-slate-500">
          {ALWAYS_ON.map((key) => COLUMN_LABELS[key]).join(', ')} ARE ALWAYS SHOWN.
        </p>
      </div>
    </details>
  )

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        {picker}
        <p className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 ring-1 ring-hairline">NO CHECKS MATCH THESE FILTERS.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {picker}

      {/* Scrolls in BOTH directions, and the vertical scroll is what makes the
          sticky header work: a sticky element pins to its nearest SCROLLING
          ancestor, and a container that only scrolls sideways — height set by
          its content — gives it nothing to stick to. The capped height gives it
          one. Two hundred rows of cheque numbers under a header that has
          scrolled off the top is a table nobody can read. */}
      <div className="max-h-[70vh] overflow-auto rounded-2xl bg-white ring-1 ring-hairline">
        <table className="w-full text-sm">
          {/* Opaque, not tinted: a translucent header would let the banded rows
              show through it as they scroll underneath. The bottom rule is an
              inset shadow rather than a border, because a border on a sticky
              header scrolls away with the cell box in some browsers. */}
          <thead className="sticky top-0 z-10 bg-white text-left text-xs tracking-wide text-slate-500 shadow-[inset_0_-1px_0_#E5E7EB]">
            <tr>
              <th className="px-4 py-3">
                <input
                  type="checkbox" checked={allSelected} onChange={toggleAll}
                  disabled={selectableRows.length === 0}
                  aria-label="Select every actionable cheque on this page"
                />
              </th>
              <th className="px-4 py-3">{COLUMN_LABELS.checkNumber}</th>
              {shows('apvNumbers') && <th className="px-4 py-3">{COLUMN_LABELS.apvNumbers}</th>}
              {shows('payeeName') && <th className="px-4 py-3">{COLUMN_LABELS.payeeName}</th>}
              {shows('companyCode') && <th className="px-4 py-3">{COLUMN_LABELS.companyCode}</th>}
              {shows('bank') && <th className="px-4 py-3">{COLUMN_LABELS.bank}</th>}
              {shows('checkDate') && <th className="px-4 py-3">{COLUMN_LABELS.checkDate}</th>}
              {shows('amount') && <th className="px-4 py-3 text-right">{COLUMN_LABELS.amount}</th>}
              <th className="px-4 py-3">{COLUMN_LABELS.status}</th>
              {shows('availablePickupDate') && <th className="px-4 py-3">{COLUMN_LABELS.availablePickupDate}</th>}
              {shows('scheduledPickupDate') && <th className="px-4 py-3">{COLUMN_LABELS.scheduledPickupDate}</th>}
              <th className="px-4 py-3">OR / CR</th>
              <th className="px-4 py-3">{COLUMN_LABELS.action}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
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
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
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
                <td className="px-4 py-3 font-medium">{r.checkNumber}</td>
                {shows('apvNumbers') && (
                  <td className="px-4 py-3 text-slate-600">
                    {r.apvNumbers.length ? r.apvNumbers.join(', ') : '—'}
                  </td>
                )}
                {shows('payeeName') && (
                  <td className="px-4 py-3">
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
                )}
                {shows('companyCode') && <td className="px-4 py-3 text-slate-600">{r.companyCode}</td>}
                {/* The cash account code, because "BPI STK" is the label
                    Finance uses; the bank code is the title, for the reader who
                    knows the institution but not the account. An em dash where
                    no cash account is recorded — the column is nullable. */}
                {shows('bank') && (
                  <td className="px-4 py-3 text-slate-600" title={r.bankCode ?? undefined}>
                    {r.cashAccountCode ?? '—'}
                  </td>
                )}
                {shows('checkDate') && <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>}
                {shows('amount') && (
                  // Right-aligned and tabular, so the decimal points line up
                  // down the column and an eight-figure amount is visibly an
                  // eight-figure amount.
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                )}
                <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                {shows('availablePickupDate') && (
                  <td className="px-4 py-3 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
                )}
                {shows('scheduledPickupDate') && (
                  <td className="px-4 py-3 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
                )}
                {/* The supplier's receipt. A ticked row that can carry one gets
                    its own box, which is what lets a batch carry receipts safely:
                    every reference has exactly one cheque. Keys and clicks stop
                    here so typing never opens the cheque (the row navigates on
                    click and on Enter). */}
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {selected.has(r.id) && takesReceipt(r) ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Receipt type for check ${r.checkNumber}`}
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
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <Link href={`/checks/${r.id}`} className="text-sm font-medium text-slate-900 underline underline-offset-2">
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
