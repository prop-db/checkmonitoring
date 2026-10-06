'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatAmount, compareCheckNumbers } from '@/lib/transmittal'

export type TransmittalCandidate = {
  id: string
  checkNumber: string
  cashAccount: string
  poNumber: string
  voucher: string
  payee: string
  amount: string | null
  currency: string
  status: 'SIGNATURE_PENDING' | 'SIGNED'
  company: string
}

type StatusFilter = 'ALL' | 'SIGNATURE_PENDING' | 'SIGNED'

/** Remembered between visits, per browser: who a transmittal usually goes to and who checks and approves it. */
const STORAGE_KEY = 'check-monitoring.transmittal.v1'

const todayManila = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
const formatDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return y && m && d ? `${m}/${d}/${y}` : iso
}

const field =
  'h-9 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
/** An input that reads as printed text on paper and as a fill-in line on screen. */
const line =
  'w-full bg-transparent px-1 py-0.5 outline-none border-b border-dotted border-slate-400 focus:border-navy print:border-transparent'

export function TransmittalBuilder({
  candidates, preparedBy: defaultPreparedBy, truncated,
}: { candidates: TransmittalCandidate[]; preparedBy: string; truncated: boolean }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [query, setQuery] = useState('')
  const [company, setCompany] = useState('')

  const [to, setTo] = useState('')
  const [date, setDate] = useState(todayManila)
  const [preparedBy, setPreparedBy] = useState(defaultPreparedBy)
  const [checkedBy, setCheckedBy] = useState('')
  const [approvedBy, setApprovedBy] = useState('')

  // Browser storage is a convenience only: every access is guarded and the
  // page works without it.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      if (typeof saved.to === 'string') setTo(saved.to)
      if (typeof saved.checkedBy === 'string') setCheckedBy(saved.checkedBy)
      if (typeof saved.approvedBy === 'string') setApprovedBy(saved.approvedBy)
    } catch { /* private window or blocked storage */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ to, checkedBy, approvedBy })) } catch { /* ignore */ }
  }, [to, checkedBy, approvedBy])

  const companies = useMemo(() => [...new Set(candidates.map((c) => c.company))].sort(), [candidates])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return candidates.filter((c) =>
      (status === 'ALL' || c.status === status) &&
      (!company || c.company === company) &&
      (!q || [c.checkNumber, c.payee, c.voucher, c.poNumber, c.cashAccount].some((v) => v.toLowerCase().includes(q))),
    )
  }, [candidates, status, company, query])

  const picked = useMemo(
    () => candidates.filter((c) => selected.has(c.id)).sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber)),
    [candidates, selected],
  )

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const addShown = () => setSelected((s) => new Set([...s, ...shown.map((c) => c.id)]))
  const clear = () => setSelected(new Set())
  const allShownPicked = shown.length > 0 && shown.every((c) => selected.has(c.id))

  return (
    <div className="space-y-4">
      <style>{'@media print { @page { size: letter portrait; margin: 10mm; } }'}</style>

      {/* ── PICKER (screen only) ─────────────────────────────────────── */}
      <section className="print-hide space-y-3 rounded-2xl bg-white p-4 ring-1 ring-hairline">
        <p className="text-sm leading-relaxed text-slate-600">
          Tick the cheques to put on the transmittal. The list holds cheques still at SIGNATURE PENDING or SIGNED
          with a recorded amount. Fill in the sheet below, then press PRINT — choose <strong>Save as PDF</strong> in
          the print window to keep a copy. Nothing here changes a cheque’s status.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={field}>
            <option value="ALL">SIGNATURE PENDING + SIGNED</option>
            <option value="SIGNATURE_PENDING">SIGNATURE PENDING</option>
            <option value="SIGNED">SIGNED</option>
          </select>
          <select aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)} className={field}>
            <option value="">ANY COMPANY</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input
            type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cheque no., payee, voucher, PO…" aria-label="Search" className={`${field} w-72`}
          />
          <button
            type="button" onClick={addShown} disabled={allShownPicked || shown.length === 0}
            className="h-9 rounded-lg bg-navy px-3 text-sm font-medium tracking-wide text-white disabled:opacity-40"
          >
            ADD ALL SHOWN ({shown.length.toLocaleString('en-PH')})
          </button>
          <button
            type="button" onClick={clear} disabled={picked.length === 0}
            className="h-9 rounded-lg bg-white px-3 text-sm font-medium tracking-wide text-slate-600 ring-1 ring-hairline disabled:opacity-40"
          >
            CLEAR
          </button>
          <span className="ml-auto text-xs font-medium tracking-wide text-slate-600">
            {picked.length.toLocaleString('en-PH')} SELECTED
          </span>
        </div>
        {truncated && (
          <p className="text-xs font-semibold tracking-wide text-warning-ink">
            THE LIST IS CAPPED — NARROW BY SEARCH TO FIND THE REST.
          </p>
        )}
        <div className="max-h-72 overflow-auto rounded-lg ring-1 ring-hairline">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-2 py-2 font-semibold">CHECK NUMBER</th>
                <th className="px-2 py-2 font-semibold">PAYEE</th>
                <th className="px-2 py-2 font-semibold">COMPANY</th>
                <th className="px-2 py-2 font-semibold">STATUS</th>
                <th className="px-2 py-2 text-right font-semibold">AMOUNT</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-500">NO CHEQUES MATCH.</td></tr>
              )}
              {shown.slice(0, 500).map((c) => (
                <tr key={c.id} className="cursor-pointer border-t border-slate-100 hover:bg-navy-bg" onClick={() => toggle(c.id)}>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)}
                      onClick={(e) => e.stopPropagation()} aria-label={`Select ${c.checkNumber}`}
                    />
                  </td>
                  <td className="px-2 py-1.5 font-medium">{c.checkNumber}</td>
                  <td className="px-2 py-1.5">{c.payee || '—'}</td>
                  <td className="px-2 py-1.5">{c.company}</td>
                  <td className="px-2 py-1.5">{c.status.replace(/_/g, ' ')}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatAmount(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 500 && (
            <p className="border-t border-slate-100 px-2 py-2 text-center text-xs text-slate-500">
              SHOWING THE FIRST 500 OF {shown.length.toLocaleString('en-PH')} — SEARCH OR FILTER TO NARROW, OR USE ADD ALL SHOWN.
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-3">
          <span className="text-xs text-slate-500">OR USE YOUR BROWSER’S PRINT COMMAND</span>
          {/* A POST, so a thousand ticked cheques are not squeezed into a URL. The
              server re-reads and re-checks every id; this carries only the picks and the typed names. */}
          <form method="post" action="/api/export/transmittal">
            <input type="hidden" name="ids" value={picked.map((c) => c.id).join(',')} />
            <input type="hidden" name="to" value={to} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="preparedBy" value={preparedBy} />
            <input type="hidden" name="checkedBy" value={checkedBy} />
            <input type="hidden" name="approvedBy" value={approvedBy} />
            <button
              type="submit" disabled={picked.length === 0}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-navy disabled:opacity-40"
            >
              DOWNLOAD EXCEL
            </button>
          </form>
          <button
            type="button" onClick={() => window.print()} disabled={picked.length === 0}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white disabled:opacity-40"
          >
            PRINT / SAVE AS PDF
          </button>
        </div>
      </section>

      {/* ── THE SHEET ────────────────────────────────────────────────── */}
      <section className="print-sheet mx-auto max-w-[1100px] bg-white p-6 text-slate-900 ring-1 ring-hairline print:max-w-none print:p-0 print:ring-0">
        <header className="mb-3 text-center">
          <h1 className="text-xl font-bold tracking-[0.2em]">CHECKS TRANSMITTAL</h1>
        </header>

        <table className="w-full border-collapse border border-black text-sm print:text-[10px] [&_td]:border [&_td]:border-black [&_th]:border [&_th]:border-black">
          <thead>
            <tr>
              <td colSpan={6} className="px-2 py-1.5">
                <label className="flex items-center gap-2">
                  <span className="font-medium">TO:</span>
                  <input value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className={line} />
                </label>
              </td>
              <td className="px-2 py-1.5 text-center">
                <input
                  type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date"
                  className="print-hide bg-transparent text-center outline-none"
                />
                <span className="hidden print:inline">{formatDay(date)}</span>
              </td>
            </tr>
            <tr className="text-center">
              <th className="w-10 px-2 py-2 font-medium">NO.</th>
              <th className="px-2 py-2 font-medium">CHECK NUMBER</th>
              <th className="px-2 py-2 font-medium">CASH<br />ACCOUNT</th>
              <th className="px-2 py-2 font-medium">PO NUMBER/<br />VENDOR REF</th>
              <th className="px-2 py-2 font-medium">VOUCHER<br />NUMBER</th>
              <th className="px-2 py-2 font-medium">PAYEE</th>
              <th className="px-2 py-2 font-medium">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {picked.length === 0 && (
              <tr><td colSpan={7} className="px-2 py-8 text-center text-slate-500">
                NO CHEQUES SELECTED — TICK THEM ABOVE.
              </td></tr>
            )}
            {picked.map((c, i) => (
              <tr key={c.id} className="break-inside-avoid">
                <td className="px-2 py-1 text-center">{i + 1}</td>
                <td className="px-2 py-1 text-center">{c.checkNumber}</td>
                <td className="px-2 py-1 text-center">{c.cashAccount}</td>
                <td className="px-2 py-1 text-center">{c.poNumber}</td>
                <td className="px-2 py-1 text-center">{c.voucher}</td>
                <td className="break-words px-2 py-1">{c.payee}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {formatAmount(c.amount)}{c.currency !== 'PHP' ? ` ${c.currency}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 grid break-inside-avoid grid-cols-3 gap-10 text-sm">
          {([
            ['PREPARED BY:', preparedBy, setPreparedBy],
            ['CHECKED BY:', checkedBy, setCheckedBy],
            ['APPROVED BY:', approvedBy, setApprovedBy],
          ] as const).map(([label, value, set]) => (
            <div key={label} className="space-y-1">
              <p className="font-medium">{label}</p>
              <div className="h-10" />
              <input
                value={value} onChange={(e) => set(e.target.value)} aria-label={label.replace(':', '')}
                className={`${line} text-center font-medium uppercase`}
              />
              <p className="border-t border-black pt-0.5 text-center text-[10px] tracking-widest text-slate-500">
                NAME / SIGNATURE
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
