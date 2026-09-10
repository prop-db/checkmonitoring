'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { recordReceiptAction } from '@/app/checks/actions'
import type { ActionResult } from '@/app/checks/actions'
import { ReceiptFields, EMPTY_RECEIPT, receiptTypeMissing, type ReceiptValue } from './ReceiptFields'

/**
 * Recording the supplier's receipt after the cheque has already been handed
 * over — the other half of "the box is optional".
 *
 * An optional field with nowhere to fill it in later is not optional, it is
 * skipped. This is that somewhere.
 *
 * It adds; it does not amend. `recordReceipt` refuses a cheque that already
 * records a receipt, so this form is only ever drawn for one that does not.
 */
export function ReceiptForm({ checkId }: { checkId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)
  const [receipt, setReceipt] = useState<ReceiptValue>(EMPTY_RECEIPT)

  const nothingTyped = receipt.orNumber.trim() === ''
  const typeMissing = receiptTypeMissing(receipt)

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        formData.set('checkId', checkId)
        startTransition(async () => {
          const r = await recordReceiptAction(formData)
          setResult(r)
          // The page re-reads the cheque, so a success replaces this form with
          // the recorded receipt rather than leaving a filled box behind that
          // looks like it still needs submitting.
          if (r.ok) router.refresh()
        })
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />

      <ReceiptFields
        value={receipt} onChange={setReceipt} idPrefix="record-receipt" disabled={pending}
      />

      <button
        type="submit"
        disabled={pending || nothingTyped || typeMissing}
        className="rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold tracking-wide text-white disabled:opacity-50"
      >
        {pending ? 'SAVING…' : 'RECORD RECEIPT'}
      </button>

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
