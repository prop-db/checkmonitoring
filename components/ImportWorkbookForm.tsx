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
      <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">CHOOSE A WORKBOOK</h2>
        <p className="text-sm text-slate-600">
          Either the check register or the approval-for-release list. Which one it is is worked out
          from the file itself.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-navy-bg file:px-4 file:py-2 file:text-sm file:font-medium file:tracking-wide file:text-navy hover:file:bg-navy-bg/70"
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
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
          >
            {pending && !previewed ? 'READING…' : 'PREVIEW'}
          </button>
          {previewed && (
            <button
              type="button"
              disabled={pending}
              onClick={() => submit(true)}
              // The one control on this screen that writes, so it is the one
              // that is not navy: the client's own success ink, solid, beside a
              // navy PREVIEW. Distinguishable by shape and position as well as
              // by hue — it is the second button and it only exists after a
              // preview has been read.
              className="rounded-lg bg-success-ink px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-success-ink/90 disabled:opacity-50"
            >
              {pending ? 'IMPORTING…' : 'CONFIRM AND IMPORT'}
            </button>
          )}
        </div>
      </section>

      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg p-4 text-sm text-warning-ink">{result.message}</p>
      )}

      {result?.ok && (
        <>
          <p
            className={`rounded-lg p-4 text-sm ${
              imported ? 'bg-success-bg text-success-ink' : 'bg-navy-bg text-navy'
            }`}
          >
            {imported
              ? `IMPORTED — ${result.fileName}. Nothing was written to any check's release status.`
              : `PREVIEW ONLY — ${result.fileName}. Nothing has been written. Read the report below, then confirm.`}
          </p>

          {imported && result.kind === 'REGISTER' && (
            <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
              <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">WHAT WAS WRITTEN</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">CREATED</dt>
                  <dd className="tabular-nums">{result.summary.created.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">UPDATED</dt>
                  <dd className="tabular-nums">{result.summary.updated.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">HELD FOR REVIEW</dt>
                  <dd className="tabular-nums">{result.summary.staged.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">ROWS IN THE FILE</dt>
                  <dd className="tabular-nums">{result.summary.rows.toLocaleString('en-PH')}</dd></div>
              </dl>
            </section>
          )}

          {imported && result.kind === 'BILLS' && (
            <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
              <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">WHAT WAS WRITTEN</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">BILLS CREATED</dt>
                  <dd className="tabular-nums">{result.summary.created.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">BILLS UPDATED</dt>
                  <dd className="tabular-nums">{result.summary.updated.toLocaleString('en-PH')}</dd></div>
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">MATCHED BY VOUCHER</dt>
                  <dd className="tabular-nums">{result.summary.resolvedByVoucher.toLocaleString('en-PH')}</dd></div>
                {/* Not "left for review" any more. A row that is only reported
                    is a row nobody reads twice — which is how a voucher went
                    unnoticed until a supplier asked. These are on
                    /admin/staged until they attach to a cheque. */}
                <div><dt className="text-[11px] font-semibold tracking-widest text-slate-400">STAGED FOR A HUMAN</dt>
                  <dd className="tabular-nums">{result.summary.staged.toLocaleString('en-PH')}</dd></div>
              </dl>
              {result.summary.staged > 0 && (
                <p className="mt-3 text-sm text-slate-600">
                  The staged rows are on <a className="underline" href="/admin/staged">/admin/staged</a>.
                  Nothing is deleted, and re-importing this file clears a row that has since attached.
                </p>
              )}
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
