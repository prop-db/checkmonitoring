'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  liveIds, releasedIds, draftTypeMissing, receiptEntries, EMPTY_DRAFT,
  type RowFacts, type ReceiptDraft,
} from '@/lib/row-receipts'
import {
  bulkSignAction, bulkReadyForReleaseAction, bulkReleaseAction, bulkRecordReceiptsAction,
  type BulkActionResult, type BulkOutcome,
} from '@/app/checks/bulk-actions'

/**
 * The spec's §13.1 minimum-click bar: tick several cheques, press one button.
 *
 * **It reports per cheque, never per batch.** The server processes each cheque
 * independently and returns a line for each, so a batch of twenty in which
 * three were refused shows those three by cheque number with the domain's own
 * sentence against each. "Some cheques could not be updated" would leave a
 * Finance user to find them by hand.
 *
 * **MARK RELEASED is hidden from a Finance user and refused by the server
 * anyway.** Hiding a button is presentation; `bulkReleaseAction` re-checks the
 * role because a server action is an HTTP endpoint (design decision D11).
 *
 * **The cap is enforced here only as a courtesy.** `parseSelection` refuses an
 * oversized selection server-side; this disables the buttons so the user finds
 * out before pressing one rather than after.
 *
 * **Each action acts on its own subset of the ticked rows, and carries only
 * that subset's own receipts.** SIGN, READY FOR RELEASE and RELEASE act on the
 * live ones (`liveIds`); SAVE RECEIPTS acts on the RELEASED ones (`releasedIds`).
 * Ticking a released cheque alongside a live one no longer blocks anything —
 * each button reaches only the rows it applies to. The receipt itself is no
 * longer typed here: since 2026-09-25 every ticked row that can carry one has
 * its own OR/CR box in the table, and this bar only reads what was typed there
 * (`drafts`, keyed by check id) back onto the matching action.
 */
export function BulkActionBar({
  selectedRows, drafts, canRelease, cap, onDone,
}: {
  selectedRows: RowFacts[]
  drafts: Readonly<Record<string, ReceiptDraft>>
  canRelease: boolean
  cap: number
  /** Called after a batch that changed something, so the table can clear itself. */
  onDone: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<BulkActionResult | null>(null)
  const [pickupDate, setPickupDate] = useState('')

  const live = liveIds(selectedRows)
  const released = releasedIds(selectedRows)
  const total = selectedRows.length
  const overCap = total > cap
  const disabled = pending || overCap
  const missingType = selectedRows.some((r) => draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT))
  const releasedTyped = receiptEntries(released, drafts).length > 0

  const submit = (
    action: (fd: FormData) => Promise<BulkActionResult>,
    ids: string[],
    extra: [string, string][] = [],
  ) => {
    const formData = new FormData()
    for (const id of ids) formData.append('checkId', id)
    for (const [k, v] of extra) formData.append(k, v)
    startTransition(async () => {
      const r = await action(formData)
      setResult(r)
      if (r.ok && r.succeeded > 0) {
        // Refresh before clearing: the rows the user is looking at have new
        // statuses, and the result panel below stays on screen to say which.
        router.refresh()
        onDone()
      }
    })
  }

  // A type predicate, not a bare `!o.ok`: TypeScript does not narrow a union
  // through Array.filter, and the refusal message lives only on the false arm.
  const failures = result?.ok
    ? result.outcomes.filter((o): o is Extract<BulkOutcome, { ok: false }> => !o.ok)
    : []

  return (
    <div className="sticky bottom-0 z-10 mt-4 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-300">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold tracking-wide text-slate-900">
          {total} SELECTED
        </span>

        <button
          type="button" disabled={disabled || live.length === 0}
          onClick={() => submit(bulkSignAction, live)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'WORKING…' : 'MARK SIGNED'}
        </button>

        <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ring-slate-300">
          <label htmlFor="bulk-pickup-date" className="text-xs font-medium tracking-wide text-slate-600">
            AVAILABLE PICKUP DATE
          </label>
          <input
            id="bulk-pickup-date" type="date" value={pickupDate}
            onChange={(e) => setPickupDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="button" disabled={disabled || live.length === 0 || pickupDate === ''}
            onClick={() => {
              if (!confirm(`Mark ${live.length} cheque(s) READY FOR RELEASE?`)) return
              submit(bulkReadyForReleaseAction, live, [['availablePickupDate', pickupDate]])
            }}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            MARK READY FOR RELEASE
          </button>
        </div>

        {canRelease && (
          <button
            type="button" disabled={disabled || live.length === 0 || missingType}
            onClick={() => {
              // The highest-risk action in the system: the cheque physically
              // leaves the building and RELEASED leads only to VOIDED.
              const entries = receiptEntries(live, drafts)
              const withReceipt = entries.length > 0 ? ` (${entries.length / 2} with a supplier receipt)` : ''
              if (!confirm(
                `Mark ${live.length} cheque(s) RELEASED${withReceipt}? This records that the cheques ` +
                'have been physically handed over and cannot be undone.',
              )) return
              submit(bulkReleaseAction, live, entries)
            }}
            className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            MARK RELEASED
          </button>
        )}

        {released.length > 0 && (
          <button
            type="button" disabled={disabled || missingType || !releasedTyped}
            onClick={() => submit(bulkRecordReceiptsAction, released, receiptEntries(released, drafts))}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            SAVE RECEIPTS
          </button>
        )}
      </div>

      {missingType && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Choose OR or CR for every receipt reference you typed.
        </p>
      )}

      {released.length > 0 && (
        // Said rather than left to be discovered by a refusal. The receipt
        // box lives in the row now, not here.
        <p className="mt-3 text-xs text-slate-500">
          A ticked RELEASED cheque takes its receipt in the OR / CR column. SAVE RECEIPTS records
          every one typed there.
        </p>
      )}

      {overCap && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {total} CHEQUES ARE SELECTED. A bulk action is limited to {cap}
          {' '}at a time — untick some before continuing.
        </p>
      )}

      {result && !result.ok && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}

      {result?.ok && (
        <div className="mt-3 space-y-2">
          {result.succeeded > 0 && (
            <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
              {result.succeeded} CHEQUE{result.succeeded === 1 ? '' : 'S'} UPDATED.
            </p>
          )}
          {failures.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">
                {failures.length} CHEQUE{failures.length === 1 ? ' WAS' : 'S WERE'} NOT UPDATED:
              </p>
              <ul className="mt-2 space-y-1">
                {failures.map((f) => (
                  <li key={f.checkId}>
                    <span className="font-medium">{f.checkNumber ?? f.checkId}</span>
                    {' — '}
                    {/* The domain's own sentence, passed through untouched. */}
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
