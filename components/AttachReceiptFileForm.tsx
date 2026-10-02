'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { attachReceiptFileAction } from '@/app/checks/actions'
import type { ActionResult } from '@/app/checks/actions'
import { MAX_RECEIPT_FILE_BYTES, RECEIPT_FILE_TYPES } from '@/lib/domain/receipt'

/**
 * Adds the supplier-receipt amount and/or file to a receipt that is already
 * recorded (user request 2026-10-01). Add-only: the server refuses to replace
 * an amount or file that is already there, so each input is drawn only while
 * its half is still missing.
 */
export function AttachReceiptFileForm({
  checkId, needsAmount, needsFile,
}: { checkId: string; needsAmount: boolean; needsFile: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)
  const [amount, setAmount] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const [hasFile, setHasFile] = useState(false)

  const nothingChosen = (!needsAmount || amount.trim() === '') && !hasFile

  return (
    <form
      className="mt-4 space-y-4 border-t border-slate-200 pt-4"
      onSubmit={(e) => {
        e.preventDefault()
        const form = e.currentTarget
        const formData = new FormData(form)
        formData.set('checkId', checkId)
        startTransition(async () => {
          const r = await attachReceiptFileAction(formData)
          setResult(r)
          if (r.ok) {
            // Clear the inputs so the button is not left enabled with nothing typed.
            form.reset()
            setAmount(''); setHasFile(false); setFileError(null); setResult(null)
            router.refresh()
          }
        })
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />

      {needsAmount && (
        <label className="block text-xs font-medium tracking-wide text-slate-600" htmlFor="attach-receipt-amount">
          AMOUNT
          <input id="attach-receipt-amount" name="receiptAmount" inputMode="decimal" value={amount}
            disabled={pending} placeholder="Optional" onChange={(e) => setAmount(e.target.value)}
            className="mt-1 block w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      )}

      {needsFile && (
        <label className="block text-xs font-medium tracking-wide text-slate-600" htmlFor="attach-receipt-file">
          RECEIPT FILE (PDF, JPG OR PNG, UP TO 3 MB)
          <input id="attach-receipt-file" name="receiptFile" type="file" accept={RECEIPT_FILE_TYPES.join(',')}
            disabled={pending}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              setHasFile(!!f)
              setFileError(f && f.size > MAX_RECEIPT_FILE_BYTES ? 'That file is larger than 3 MB.' : null)
            }}
            className="mt-1 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-navy-bg file:px-4 file:py-2 file:text-sm file:font-medium file:tracking-wide file:text-navy hover:file:bg-navy-bg/70" />
        </label>
      )}
      {fileError && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{fileError}</p>}

      <button
        type="submit"
        disabled={pending || nothingChosen || fileError !== null}
        className="rounded-lg bg-navy px-5 py-2.5 text-sm font-semibold tracking-wide text-white disabled:opacity-50"
      >
        {pending ? 'SAVING…' : 'ATTACH TO RECEIPT'}
      </button>

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
