'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ReceiptFields, EMPTY_RECEIPT, receiptTypeMissing, type ReceiptValue } from './ReceiptFields'
import {
  bulkSignAction, bulkReadyForReleaseAction, bulkReleaseAction,
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
 */
export function BulkActionBar({
  checkIds, canRelease, cap, onDone,
}: {
  checkIds: string[]
  canRelease: boolean
  cap: number
  /** Called after a batch that changed something, so the table can clear itself. */
  onDone: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<BulkActionResult | null>(null)
  const [pickupDate, setPickupDate] = useState('')
  const [receipt, setReceipt] = useState<ReceiptValue>(EMPTY_RECEIPT)
  /**
   * The cheque just released with an empty box, so the offer to record its
   * receipt can be made at the moment "I'll do it later" is decided — rather
   * than left to somebody remembering the page exists.
   */
  const [receiptPending, setReceiptPending] = useState<string | null>(null)

  const overCap = checkIds.length > cap
  const disabled = pending || overCap

  /**
   * The receipt box appears for ONE ticked cheque, which is the client's own
   * shape for it: one supplier at the counter, one receipt. `bulkReleaseAction`
   * refuses a receipt typed against a larger selection, so this is the courtesy
   * and that is the control. A batch releases with no box at all, which is what
   * makes the receipt optional.
   */
  const single = checkIds.length === 1
  const typeMissing = receiptTypeMissing(receipt)

  const submit = (
    action: (fd: FormData) => Promise<BulkActionResult>,
    extra: Record<string, string> = {},
    onSuccess?: () => void,
  ) => {
    const formData = new FormData()
    for (const id of checkIds) formData.append('checkId', id)
    for (const [k, v] of Object.entries(extra)) formData.append(k, v)
    startTransition(async () => {
      const r = await action(formData)
      setResult(r)
      if (r.ok && r.succeeded > 0) {
        // Cleared first, so a sign or a ready-for-release never leaves the
        // previous release's receipt offer standing over an unrelated cheque.
        setReceiptPending(null)
        onSuccess?.()
        // Refresh before clearing: the rows the user is looking at have new
        // statuses, and the result panel below stays on screen to say which.
        router.refresh()
        // Emptied with the selection. A reference left in the box would be
        // offered again against the next cheque ticked, which is the one way
        // this control could put a supplier's receipt on the wrong cheque.
        setReceipt(EMPTY_RECEIPT)
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
          {checkIds.length} SELECTED
        </span>

        <button
          type="button" disabled={disabled}
          onClick={() => submit(bulkSignAction)}
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
            type="button" disabled={disabled || pickupDate === ''}
            onClick={() => {
              if (!confirm(`Mark ${checkIds.length} cheque(s) READY FOR RELEASE?`)) return
              submit(bulkReadyForReleaseAction, { availablePickupDate: pickupDate })
            }}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            MARK READY FOR RELEASE
          </button>
        </div>

        {canRelease && (
          <button
            type="button" disabled={disabled || typeMissing}
            onClick={() => {
              // The highest-risk action in the system: the cheque physically
              // leaves the building and RELEASED leads only to VOIDED.
              if (!confirm(
                `Mark ${checkIds.length} cheque(s) RELEASED? This records that the cheques have ` +
                'been physically handed over and cannot be undone.',
              )) return
              // The receipt travels only with a single cheque. For a batch the
              // box is not even drawn, and the server refuses one anyway.
              const withReceipt = single && receipt.orNumber.trim() !== ''
              const releasedId = single ? checkIds[0] : null
              submit(
                bulkReleaseAction,
                single ? {
                  orNumber: receipt.orNumber,
                  orDate: receipt.orDate,
                  receiptType: receipt.receiptType,
                } : {},
                () => setReceiptPending(withReceipt ? null : releasedId),
              )
            }}
            className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            MARK RELEASED
          </button>
        )}
      </div>

      {canRelease && single && (
        <div className="mt-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="text-xs font-semibold tracking-widest text-slate-600">
            SUPPLIER RECEIPT — OPTIONAL
          </p>
          <p className="mt-1 text-xs text-slate-500">
            The Official or Collection Receipt the supplier hands over. Leave it empty to release
            now and record the receipt later.
          </p>
          <div className="mt-3">
            <ReceiptFields
              value={receipt} onChange={setReceipt} idPrefix="bulk-receipt" disabled={pending}
            />
          </div>
        </div>
      )}

      {canRelease && !single && checkIds.length > 1 && (
        // Said rather than left to be discovered by a refusal. The box is not
        // drawn for a batch, and a reader who expected it should know why.
        <p className="mt-3 text-xs text-slate-500">
          A RECEIPT REFERENCE BELONGS TO ONE CHEQUE. Tick a single cheque to record one, or release
          these together and add each receipt afterwards.
        </p>
      )}

      {overCap && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {checkIds.length} CHEQUES ARE SELECTED. A bulk action is limited to {cap}
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
              {receiptPending && (
                // The offer, at the moment "later" is chosen. Without it, "add
                // the receipt later" means remembering that a page exists.
                <>
                  {' '}
                  <Link
                    href={`/receipts/${receiptPending}`}
                    className="font-semibold underline underline-offset-2"
                  >
                    RECORD THE SUPPLIER RECEIPT
                  </Link>
                  {' when the paper reaches you.'}
                </>
              )}
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
