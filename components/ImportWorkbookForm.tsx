'use client'

import { useRef, useState, useTransition } from 'react'
import { importWorkbookAction, type ImportWorkbookResult } from '@/app/admin/actions'
import { BillPreviewReport, RegisterPreviewReport } from './ImportPreviewReport'

/**
 * Upload → preview → confirm → import.
 *
 * **The confirmation step is not optional.** The first submission returns the
 * reconciliation report and the vendor merge list, having written nothing; only
 * a second submission carrying `confirm` writes. The spec requires the merge
 * list be shown before it is applied, and the accounting deserves the same: 22%
 * of the client's register does not import, and this screen is the only moment
 * anybody can act on that.
 *
 * The file is held HERE, in the browser, and re-sent with the confirmation —
 * the server keeps nothing between the two requests. Nothing is parked on disk,
 * and a confirmation can never end up applying to a file other than the one
 * that was previewed.
 */
export function ImportWorkbookForm() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ImportWorkbookResult | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (confirm: boolean) => {
    if (!file) return
    const formData = new FormData()
    formData.append('workbook', file)
    if (confirm) formData.append('confirm', 'true')
    startTransition(async () => setResult(await importWorkbookAction(formData)))
  }

  const previewed = result?.ok === true && result.stage === 'PREVIEW'
  const imported = result?.ok === true && result.stage === 'IMPORTED'

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="text-sm font-semibold tracking-wide">CHOOSE A WORKBOOK</h2>
        <p className="text-sm text-slate-600">
          Either the cheque register or the approval-for-release list. Which one it is is worked out
          from the file itself.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          className="block text-sm"
          onChange={(e) => {
            setFile(e.currentTarget.files?.[0] ?? null)
            // A new file invalidates the report on screen. Leaving the old one
            // up next to a CONFIRM button is how somebody confirms an import of
            // a file they are no longer looking at.
            setResult(null)
          }}
        />
        <div className="flex gap-3">
          <button
            type="button"
            disabled={!file || pending}
            onClick={() => submit(false)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending && !previewed ? 'READING…' : 'PREVIEW'}
          </button>
          {previewed && (
            <button
              type="button"
              disabled={pending}
              onClick={() => submit(true)}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? 'IMPORTING…' : 'CONFIRM AND IMPORT'}
            </button>
          )}
        </div>
      </section>

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">{result.message}</p>
      )}

      {result?.ok && (
        <>
          <p
            className={`rounded-lg p-4 text-sm ${
              imported ? 'bg-emerald-50 text-emerald-900' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {imported
              ? `IMPORTED — ${result.fileName}. Nothing was written to any check's release status.`
              : `PREVIEW ONLY — ${result.fileName}. Nothing has been written. Read the report below, then confirm.`}
          </p>

          {imported && result.kind === 'REGISTER' && (
            <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
              <h2 className="text-sm font-semibold tracking-wide">WHAT WAS WRITTEN</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div><dt className="text-xs tracking-wide text-slate-500">CREATED</dt>
                  <dd className="tabular-nums">{result.summary.created.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-xs tracking-wide text-slate-500">UPDATED</dt>
                  <dd className="tabular-nums">{result.summary.updated.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-xs tracking-wide text-slate-500">HELD FOR REVIEW</dt>
                  <dd className="tabular-nums">{result.summary.staged.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-xs tracking-wide text-slate-500">ROWS IN THE FILE</dt>
                  <dd className="tabular-nums">{result.summary.rows.toLocaleString('en-PH')}</dd></div>
              </dl>
            </section>
          )}

          {imported && result.kind === 'BILLS' && (
            <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
              <h2 className="text-sm font-semibold tracking-wide">WHAT WAS WRITTEN</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div><dt className="text-xs tracking-wide text-slate-500">BILLS CREATED</dt>
                  <dd className="tabular-nums">{result.summary.created.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-xs tracking-wide text-slate-500">BILLS UPDATED</dt>
                  <dd className="tabular-nums">{result.summary.updated.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-xs tracking-wide text-slate-500">LEFT FOR REVIEW</dt>
                  <dd className="tabular-nums">{result.summary.unmatched.length.toLocaleString('en-PH')}</dd></div>
              </dl>
            </section>
          )}

          {result.kind === 'REGISTER'
            ? <RegisterPreviewReport preview={result.preview} />
            : <BillPreviewReport preview={result.preview} />}
        </>
      )}
    </div>
  )
}
