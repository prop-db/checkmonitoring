'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatMoney } from '@/lib/money'
import { isLiveStatus } from '@/lib/domain/check-status'
import { StatusPill } from './StatusPill'
import { BulkActionBar } from './BulkActionBar'
import type { CheckTableRow } from '@/lib/queries'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/**
 * A cheque can be ticked only if a bulk action could conceivably apply to it: a
 * real cheque that has not left the release ladder. `isLiveStatus` is the same
 * predicate the dashboard filters on — restating the list here is how the two
 * would drift.
 *
 * This is presentation, not a control. Every refusal is re-decided by
 * `lib/domain/actions.ts` on the server, which is why a hidden checkbox can
 * never be the reason a cheque was not released.
 */
const selectable = (r: CheckTableRow) => r.isCheque && isLiveStatus(r.status)

export function CheckTable({ rows, canRelease }: { rows: CheckTableRow[]; canRelease: boolean }) {
  const router = useRouter()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  if (rows.length === 0) {
    return <p className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">NO CHECKS MATCH THESE FILTERS.</p>
  }

  const selectableRows = rows.filter(selectable)
  // Only ids still on screen count. A filter change re-renders with different
  // rows, and a stale id would put a cheque the user can no longer see into a
  // batch they thought they were reading.
  const selectedIds = rows.filter((r) => selected.has(r.id)).map((r) => r.id)
  const allSelected = selectableRows.length > 0 && selectedIds.length === selectableRows.length

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableRows.map((r) => r.id)))

  const open = (id: string) => router.push(`/checks/${id}`)

  return (
    <>
      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">
                <input
                  type="checkbox" checked={allSelected} onChange={toggleAll}
                  disabled={selectableRows.length === 0}
                  aria-label="Select every actionable cheque on this page"
                />
              </th>
              <th className="px-4 py-3">CHECK NUMBER</th>
              <th className="px-4 py-3">APV NUMBER</th>
              <th className="px-4 py-3">SUPPLIER NAME</th>
              <th className="px-4 py-3">COMPANY</th>
              <th className="px-4 py-3">CHECK DATE</th>
              <th className="px-4 py-3 text-right">AMOUNT</th>
              <th className="px-4 py-3">STATUS</th>
              <th className="px-4 py-3">AVAILABLE DATE</th>
              <th className="px-4 py-3">PICKUP SCHEDULE</th>
              <th className="px-4 py-3">ACTION</th>
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
                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
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
                <td className="px-4 py-3 text-slate-600">
                  {r.apvNumbers.length ? r.apvNumbers.join(', ') : '—'}
                </td>
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
                <td className="px-4 py-3 text-slate-600">{r.companyCode}</td>
                <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                <td className="px-4 py-3 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
                <td className="px-4 py-3 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
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
          checkIds={selectedIds}
          canRelease={canRelease}
          onDone={() => setSelected(new Set())}
        />
      )}
    </>
  )
}
