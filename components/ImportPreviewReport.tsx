import type { StagedReason } from '@prisma/client'
import { formatMoney } from '@/lib/money'
import type { BillPreview } from '@/lib/import/bills'
import type { ImportPreview, StagedPreviewRow } from '@/lib/import/preview'

/**
 * The reconciliation report, shown BEFORE anything is written.
 *
 * The layout carries an argument. "Will import" and "will not import" are two
 * cards of the same size, side by side, because 22% of the client's register
 * does not import and a screen that led with 9,461 and mentioned 2,766
 * somewhere below would be read as success. Nobody has to act on all 2,766 —
 * most of them are cheques already handed over — but nobody should believe
 * 9,461 was the whole register either.
 */

const n = (v: number) => v.toLocaleString('en-PH')

// Enough rows to see the shape of a group without putting 2,639 of them in the
// DOM. The rest are not hidden: they are the staged queue, which is linked.
const ROWS_SHOWN = 200

const REASON_LABEL: Readonly<Record<StagedReason, string>> = {
  NO_COMPANY: 'NO COMPANY — neither a checkbook nor a cash account says whose cheque this is',
  AMBIGUOUS_COMPANY: 'AMBIGUOUS COMPANY — this cheque number is claimed by more than one company',
  NO_CHECK_NUMBER: 'NO CHECK NUMBER — the row carries nothing that can key a cheque',
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function Figure({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' }) {
  const skin = tone === 'good' ? 'bg-emerald-50 ring-emerald-200' : 'bg-amber-50 ring-amber-200'
  return (
    <div className={`rounded-2xl p-6 ring-1 ${skin}`}>
      <p className="text-xs font-medium tracking-wide text-slate-600">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  )
}

function StagedGroup({ reason, rows }: { reason: StagedReason; rows: StagedPreviewRow[] }) {
  if (rows.length === 0) return null
  return (
    <details className="rounded-2xl bg-white ring-1 ring-slate-200">
      <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
        {n(rows.length)} · {REASON_LABEL[reason]}
      </summary>
      <div className="overflow-x-auto border-t border-slate-100">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">SHEET</th>
              <th className="px-4 py-3 text-right">ROW</th>
              <th className="px-4 py-3">CHECK NUMBER</th>
              <th className="px-4 py-3">PAYEE</th>
              <th className="px-4 py-3">CHECK DATE</th>
              <th className="px-4 py-3 text-right">AMOUNT</th>
              <th className="px-4 py-3">CASH ACCOUNT</th>
              <th className="px-4 py-3">CHECK BOOK</th>
              <th className="px-4 py-3">COMPANIES CLAIMED</th>
              <th className="px-4 py-3">REGISTER IMPLIES</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROWS_SHOWN).map((r) => (
              <tr key={`${r.sheet}#${r.row}`} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 text-slate-600">{r.sheet}</td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600">{r.row}</td>
                {/* For a NO_CHECK_NUMBER row this shows what the cell actually
                    held, which is what a human replaces with the real number. */}
                <td className="px-4 py-3 font-medium">{r.checkNumber ?? r.statedCheckRef ?? '—'}</td>
                <td className="px-4 py-3">{r.payeeName ?? '—'}</td>
                <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatMoney(r.amount, r.currency ?? 'PHP')}
                </td>
                <td className="px-4 py-3 text-slate-600">{r.cashAccountCode ?? '—'}</td>
                <td className="px-4 py-3 text-slate-600">{r.checkBookCode ?? '—'}</td>
                <td className="px-4 py-3 text-slate-600">
                  {r.conflictingCompanies.length ? r.conflictingCompanies.join(' / ') : r.companyCode ?? '—'}
                </td>
                <td className="px-4 py-3 text-slate-600">{r.impliedStatus ?? 'NOT RULED ON'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > ROWS_SHOWN && (
          <p className="px-4 py-3 text-sm text-slate-500">
            SHOWING {n(ROWS_SHOWN)} OF {n(rows.length)}. Every one of them is kept — after the
            import they are all in the staged queue.
          </p>
        )}
      </div>
    </details>
  )
}

export function RegisterPreviewReport({ preview }: { preview: ImportPreview }) {
  const reasons: StagedReason[] = ['NO_COMPANY', 'AMBIGUOUS_COMPANY', 'NO_CHECK_NUMBER']

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Figure label="WILL IMPORT" value={n(preview.willImport)} tone="good" />
        <Figure label="WILL NOT IMPORT — HELD FOR REVIEW" value={n(preview.willStage)} tone="warn" />
      </div>

      <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
        {n(preview.totalRows)} rows in the workbook, all accounted for. Of the {n(preview.willStage)}{' '}
        that will not import, {n(preview.stagedLive)} are cheques still in the release workflow and{' '}
        {n(preview.stagedClosed)} are already released or cancelled
        {preview.stagedUnruled > 0 && `, and ${n(preview.stagedUnruled)} carry a status combination nobody has ruled on`}.
        None of them is discarded.
      </p>

      {preview.unruledClashes.length > 0 && (
        <section className="rounded-2xl bg-rose-50 p-6 ring-1 ring-rose-200">
          <h3 className="text-sm font-semibold tracking-wide text-rose-900">
            {n(preview.unruledClashes.length)} CHEQUE(S) CANNOT BE IMPORTED AT ALL
          </h3>
          <p className="mt-2 text-sm text-rose-900">
            Their sheets imply a combination of statuses Finance has not ruled on, so the importer
            cannot choose one. A human has to decide before this workbook can be imported.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-rose-900">
            {preview.unruledClashes.map((c) => (
              <li key={c.checkNumber}>
                <span className="font-medium">{c.checkNumber}</span> — {c.sheets.join(' + ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {reasons.map((reason) => (
        <StagedGroup
          key={reason}
          reason={reason}
          rows={preview.stagedRows.filter((r) => r.reason === reason)}
        />
      ))}

      <details className="rounded-2xl bg-white ring-1 ring-slate-200">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {n(preview.contradictions.length)} · CONTRADICTORY STATUS — and how the Finance ruling of
          3 September 2026 settled each
        </summary>
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">CHECK NUMBER</th>
                <th className="px-4 py-3">SHEETS</th>
                <th className="px-4 py-3">THE REGISTER IMPLIES</th>
                <th className="px-4 py-3">RESOLVED TO</th>
                <th className="px-4 py-3">IMPORTED AS</th>
              </tr>
            </thead>
            <tbody>
              {preview.contradictions.slice(0, ROWS_SHOWN).map((c) => (
                <tr key={c.checkNumber} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium">{c.checkNumber}</td>
                  <td className="px-4 py-3 text-slate-600">{c.sheets.join(', ')}</td>
                  <td className="px-4 py-3 text-slate-600">{c.implied.join(' and ')}</td>
                  <td className="px-4 py-3">{c.resolvedFrom ?? '—'}</td>
                  <td className="px-4 py-3">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="rounded-2xl bg-white ring-1 ring-slate-200">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {n(preview.companyConflicts.length)} · CASH ACCOUNT AND CHECK BOOK NAME DIFFERENT
          COMPANIES — the cash account wins, and the register needs correcting
        </summary>
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">SHEET</th>
                <th className="px-4 py-3 text-right">ROW</th>
                <th className="px-4 py-3">CHECK NUMBER</th>
                <th className="px-4 py-3">CASH ACCOUNT</th>
                <th className="px-4 py-3">CHECK BOOK</th>
                <th className="px-4 py-3">IMPORTED AS</th>
                <th className="px-4 py-3">THE CHECK BOOK SAID</th>
              </tr>
            </thead>
            <tbody>
              {preview.companyConflicts.slice(0, ROWS_SHOWN).map((c) => (
                <tr key={`${c.sheet}#${c.row}`} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{c.sheet}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-600">{c.row}</td>
                  <td className="px-4 py-3 font-medium">{c.checkNumber}</td>
                  <td className="px-4 py-3">{c.cashAccountLabel ?? '—'}</td>
                  <td className="px-4 py-3">{c.checkBook ?? '—'}</td>
                  <td className="px-4 py-3">{c.resolved}</td>
                  <td className="px-4 py-3 text-slate-600">{c.conflictedWith}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h3 className="text-sm font-semibold tracking-wide">OTHER CONFLICTS</h3>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div><dt className="text-xs tracking-wide text-slate-500">DUPLICATE ACROSS SHEETS</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.DUPLICATE_ACROSS_SHEETS)}</dd></div>
          <div><dt className="text-xs tracking-wide text-slate-500">AMOUNT MISMATCH</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.AMOUNT_MISMATCH)}</dd></div>
          <div><dt className="text-xs tracking-wide text-slate-500">IMPLAUSIBLE DATE</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.IMPLAUSIBLE_DATE)}</dd></div>
          <div><dt className="text-xs tracking-wide text-slate-500">CONTRADICTORY STATUS</dt>
            <dd className="tabular-nums">{n(preview.conflictsByKind.CONTRADICTORY_STATUS)}</dd></div>
        </dl>
      </section>

      {/* The merge list, presented BEFORE the import runs — spec §8. It is
          reported and never applied: nothing in this system rewrites a payee. */}
      <details className="rounded-2xl bg-white ring-1 ring-slate-200">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {n(preview.vendorMerges.length)} · VENDOR MERGE LIST — payee spellings that fold to one
          name, out of {n(preview.distinctPayees)} spellings in the file
        </summary>
        <div className="space-y-2 border-t border-slate-100 p-6">
          <p className="text-sm text-slate-600">
            These are reported for confirmation and are never applied automatically. Importing does
            not rewrite a payee.
          </p>
          <ul className="space-y-1 text-sm">
            {preview.vendorMerges.slice(0, ROWS_SHOWN).map((m) => (
              <li key={m.canonical}>
                <span className="font-medium">{m.canonical}</span>
                <span className="text-slate-500"> ← {m.variants.join(' · ')}</span>
              </li>
            ))}
          </ul>
          {preview.vendorMerges.length > ROWS_SHOWN && (
            <p className="text-sm text-slate-500">
              SHOWING {n(ROWS_SHOWN)} OF {n(preview.vendorMerges.length)}.
            </p>
          )}
        </div>
      </details>

      <details className="rounded-2xl bg-white ring-1 ring-slate-200">
        <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
          {preview.sheets.length} SHEETS READ
        </summary>
        <ul className="space-y-1 border-t border-slate-100 p-6 text-sm">
          {preview.sheets.map((s) => (
            <li key={s.sheet} className="flex justify-between">
              <span>{s.sheet}</span>
              <span className="tabular-nums text-slate-500">{n(s.rows)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

export function BillPreviewReport({ preview }: { preview: BillPreview }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Figure label="BILLS THAT WILL BE ATTACHED" value={n(preview.willImport)} tone="good" />
        <Figure
          label="BILLS WHOSE CHEQUE IS NOT HERE"
          value={n(preview.unmatched.length + preview.review.length)}
          tone="warn"
        />
      </div>

      <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
        {n(preview.totalRows)} rows on the LIST sheet, all accounted for. This file is a snapshot of
        the approval-for-release working list, not a history: it says nothing about cheques outside
        it, and importing it changes no cheque&apos;s release status.
      </p>

      {preview.unmatched.length > 0 && (
        <details className="rounded-2xl bg-white ring-1 ring-slate-200" open>
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            {n(preview.unmatched.length)} · BILLS WITH NO CHEQUE TO ATTACH TO
          </summary>
          <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-right">ROW</th>
                  <th className="px-4 py-3">CHECK NUMBER</th>
                  <th className="px-4 py-3">APV</th>
                  <th className="px-4 py-3">WHY</th>
                  <th className="px-4 py-3">COMPANIES</th>
                </tr>
              </thead>
              <tbody>
                {preview.unmatched.map((u) => (
                  <tr key={`${u.sheet}#${u.row}`} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{u.row}</td>
                    <td className="px-4 py-3 font-medium">{u.checkNumber}</td>
                    <td className="px-4 py-3">{u.apvNumber}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {u.reason === 'NO_MATCHING_CHECK'
                        ? 'No cheque with this number is here — it may be staged for want of a company, or absent from the register'
                        : 'More than one company has a cheque with this number; a human has to say which'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{u.companies.join(' / ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {preview.review.length > 0 && (
        <details className="rounded-2xl bg-white ring-1 ring-slate-200">
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            {n(preview.review.length)} · ROWS THAT ARE NOT A USABLE BILL
          </summary>
          <ul className="space-y-1 border-t border-slate-100 p-6 text-sm">
            {preview.review.map((r) => (
              <li key={`${r.sheet}#${r.row}`}>
                {r.sheet} row {r.row} — {r.reason.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
