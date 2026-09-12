'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { previewClearingAction, confirmClearingAction, type ClearingPreviewResult } from '@/app/clearing/actions'
import type { BulkActionResult } from '@/lib/bulk-run'
import type { PreviewVerdict } from '@/lib/clearing-preview'

const VERDICT: Record<PreviewVerdict, { words: string; tone: string }> = {
  WILL_CLEAR: { words: 'WILL BE CLEARED', tone: 'text-success-ink' },
  ALREADY_CLEARED: { words: 'ALREADY CLEARED', tone: 'text-slate-500' },
  NOT_RELEASED: { words: 'NOT RELEASED', tone: 'text-warning-ink' },
  UNKNOWN: { words: 'UNKNOWN NUMBER', tone: 'text-danger-ink' },
  AMBIGUOUS: { words: 'TWO COMPANIES — NOT CLEARED', tone: 'text-danger-ink' },
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'

/**
 * Paste, preview, confirm. Nothing is written until CONFIRM, and the preview
 * says per line what CONFIRM will do. The text is re-sent on confirm and the
 * server decides again; this component holds no ids.
 */
export function ClearingPaste({ maxLines }: { maxLines: number }) {
  const [pending, startTransition] = useTransition()
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ClearingPreviewResult | null>(null)
  const [result, setResult] = useState<BulkActionResult | null>(null)

  const willClear = preview?.ok ? preview.rows.filter((r) => r.verdict === 'WILL_CLEAR').length : 0
  const field = 'w-full rounded-lg border border-hairline bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  const doPreview = () => {
    const f = new FormData()
    f.append('lines', text)
    startTransition(async () => {
      const r = await previewClearingAction(f)
      setPreview(r)
      setResult(null)
    })
  }

  const doConfirm = () => {
    const f = new FormData()
    f.append('lines', text)
    startTransition(async () => {
      const r = await confirmClearingAction(f)
      setResult(r)
    })
  }

  if (result?.ok) {
    return (
      <div className="space-y-4">
        <p className="rounded-xl bg-success-bg px-4 py-3 text-sm text-success-ink">
          {result.succeeded} cheque{result.succeeded === 1 ? '' : 's'} marked CLEARED
          {result.failed > 0 ? `; ${result.failed} refused` : ''}.
        </p>
        <ul className="divide-y divide-hairline rounded-xl bg-white ring-1 ring-hairline">
          {result.outcomes.map((o) => (
            <li key={o.checkId} className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm">
              <Link href={`/checks/${o.checkId}`} className="tabular-nums underline underline-offset-2">{o.checkNumber ?? o.checkId}</Link>
              <span className={o.ok ? 'text-success-ink' : 'text-danger-ink'}>{o.ok ? 'CLEARED' : o.message}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => { setText(''); setPreview(null); setResult(null) }}
          className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground">
          START AGAIN
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <label htmlFor="clearing-lines" className="block text-[11px] font-semibold tracking-widest text-slate-400">
        ONE CHEQUE PER LINE — NUMBER, OR NUMBER, DATE, BANK REFERENCE
      </label>
      <textarea id="clearing-lines" rows={10} value={text} disabled={pending}
        onChange={(e) => { setText(e.target.value); setPreview(null) }}
        placeholder={'6000319079\n6000319080, 2026-09-10, BPI 88123'} className={field} />
      <p className="text-[11px] text-slate-500">
        Up to {maxLines} lines at a time. Dates as YYYY-MM-DD or DD/MM/YYYY. Nothing is written until you confirm.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending || text.trim() === ''}
          onClick={doPreview}
          className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50">
          {pending ? 'WORKING…' : 'PREVIEW'}
        </button>
        {preview?.ok && (
          <button type="button" disabled={pending || willClear === 0}
            onClick={doConfirm}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white hover:bg-navy/90 disabled:opacity-50">
            CONFIRM — MARK {willClear} CLEARED
          </button>
        )}
      </div>

      {preview && !preview.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{preview.message}</p>
      )}
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}

      {preview?.ok && (
        <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-hairline">
          <table className="w-full text-sm">
            <thead className="text-[11px] font-semibold tracking-widest text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">LINE</th>
                <th className="px-4 py-2 text-left">CHEQUE</th>
                <th className="px-4 py-2 text-left">PAYEE</th>
                <th className="px-4 py-2 text-left">DATE</th>
                <th className="px-4 py-2 text-left">BANK REF</th>
                <th className="px-4 py-2 text-left">WHAT CONFIRM DOES</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {preview.rows.map((r) => (
                <tr key={r.line}>
                  <td className="px-4 py-2 tabular-nums text-slate-500">{r.line}</td>
                  <td className="px-4 py-2 tabular-nums">
                    {r.checkId
                      ? <Link href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
                      : r.checkNumber}
                    {r.companyCode && <span className="ml-2 text-xs text-slate-500">{r.companyCode}</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{r.payeeName ?? '—'}</td>
                  <td className="px-4 py-2">{fmtDate(r.clearedDate)}</td>
                  <td className="px-4 py-2">{r.crNumber ?? '—'}</td>
                  <td className={`px-4 py-2 font-medium ${VERDICT[r.verdict].tone}`}>
                    {VERDICT[r.verdict].words}{r.detail ? ` · ${r.detail}` : ''}
                  </td>
                </tr>
              ))}
              {preview.errors.map((e) => (
                <tr key={`e${e.line}`}>
                  <td className="px-4 py-2 tabular-nums text-slate-500">{e.line}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500" colSpan={4}>{e.raw}</td>
                  <td className="px-4 py-2 font-medium text-danger-ink">NOT READ · {e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
