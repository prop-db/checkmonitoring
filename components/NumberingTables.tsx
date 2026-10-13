// components/NumberingTables.tsx
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { missingLabel, numberingHref } from '@/lib/numbering-view'
import type { NumberingAccount } from '@/lib/numbering/query'
import type { SeriesCheque, SeriesEntry, SeriesStaged } from '@/lib/numbering/series'
import { KitTable, type KitRow } from './table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { dateValue } from '@/lib/table-kit/match'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtCount = (s: string) => (s.length <= 15 ? Number(s).toLocaleString('en-PH') : s)
const th = 'px-4 py-3'

const CHECK_COLUMNS: KitColumn[] = [
  { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'tabular-nums' },
  { key: 'checkDate', label: 'CHECK DATE', kind: 'date' },
  { key: 'payee', label: 'PAYEE', kind: 'text' },
  { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
  { key: 'status', label: 'STATUS', kind: 'text' },
]

function checkRow(c: SeriesCheque, note?: string): KitRow {
  return {
    key: c.id,
    values: {
      checkNumber: c.checkNumber, checkDate: dateValue(c.checkDate), payee: c.payeeName,
      amount: c.amount === null ? null : String(c.amount), status: `${c.status.replace(/_/g, ' ')}${note ? ` ${note}` : ''}`,
    },
    cells: {
      checkNumber: <Link prefetch={false} href={`/checks/${c.id}`} className="underline underline-offset-2">{c.checkNumber}</Link>,
      checkDate: fmtDay(c.checkDate),
      payee: c.payeeName ?? '—',
      amount: formatMoney(c.amount, c.currency),
      status: <><StatusPill status={c.status} />{note && <span className="ml-2 text-xs font-semibold text-amber-700">{note}</span>}</>,
    },
  }
}

function stagedRow(s: SeriesStaged): KitRow {
  return {
    key: `s-${s.acumaticaTenant}-${s.acumaticaRef}`,
    className: 'border-b border-slate-100 bg-slate-50 text-slate-600',
    values: {
      checkNumber: s.statedCheckRef, checkDate: dateValue(s.checkDate), payee: s.payeeName,
      amount: s.currency && s.amount !== null ? String(s.amount) : null, status: `STAGED ${s.acumaticaRef}`,
    },
    cells: {
      checkNumber: s.statedCheckRef,
      checkDate: fmtDay(s.checkDate),
      payee: s.payeeName ?? '—',
      amount: s.currency ? formatMoney(s.amount, s.currency) : '—',
      status: (
        <>
          <span className="inline-block whitespace-nowrap rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold tracking-wide text-slate-700">STAGED</span>
          <span className="ml-2 text-xs text-slate-500">Acumatica {s.acumaticaRef}</span>
        </>
      ),
    },
  }
}

function entryRows(entries: readonly SeriesEntry[]): KitRow[] {
  return entries.map((e): KitRow => e.kind === 'MISSING'
    ? {
        key: `m-${e.from}`, className: 'border-b border-amber-200 bg-amber-50',
        band: <div className={`${th} font-semibold tabular-nums text-amber-800`}>{missingLabel(e)}</div>,
      }
    : e.kind === 'STAGED' ? stagedRow(e.staged) : checkRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : undefined))
}

/** One row per check book. The check book links to its own series. */
export function NumberingSummaryTable({ accounts, company }: { accounts: readonly NumberingAccount[]; company?: string }) {
  const count = (key: string, label: string): KitColumn => ({ key, label, kind: 'amount', align: 'right', className: 'tabular-nums' })
  const opts = (xs: string[]) => [...new Set(xs)].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'account', label: 'CHECK BOOK', kind: 'text', locked: true },
    { key: 'bank', label: 'BANK', kind: 'enum', options: opts(accounts.map((a) => a.bank)) },
    { key: 'company', label: 'COMPANY', kind: 'enum', options: opts(accounts.map((a) => a.company)) },
    { key: 'first', label: 'FIRST', kind: 'text', className: 'tabular-nums' },
    { key: 'last', label: 'LAST', kind: 'text', className: 'tabular-nums' },
    count('held', 'HELD'), count('voided', 'VOIDED'), count('cancelled', 'CANCELLED'), count('staged', 'STAGED'),
    count('missing', 'MISSING'), count('notNumeric', 'NOT NUMERIC'), count('outOfPattern', 'OUT OF PATTERN'),
  ]
  const rows: KitRow[] = accounts.map((a) => {
    const s = a.series.summary
    return {
      key: a.accountId,
      values: {
        account: a.account, bank: a.bank, company: a.company, first: s.first ?? null, last: s.last ?? null,
        held: String(s.held), voided: String(s.voided), cancelled: String(s.cancelled), staged: String(s.staged),
        missing: s.missingNumbers, notNumeric: String(s.notNumeric), outOfPattern: String(s.outOfPattern),
      },
      cells: {
        account: <Link prefetch={false} href={numberingHref({ company, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link>,
        bank: a.bank, company: a.company, first: s.first ?? '—', last: s.last ?? '—',
        held: s.held.toLocaleString('en-PH'), voided: s.voided.toLocaleString('en-PH'),
        cancelled: s.cancelled.toLocaleString('en-PH'), staged: s.staged.toLocaleString('en-PH'),
        missing: (
          <span className={s.missingRuns ? 'font-semibold text-amber-700' : ''}>
            {fmtCount(s.missingNumbers)}{s.missingRuns ? ` (${s.missingRuns.toLocaleString('en-PH')})` : ''}
          </span>
        ),
        notNumeric: s.notNumeric.toLocaleString('en-PH'), outOfPattern: s.outOfPattern.toLocaleString('en-PH'),
      },
    }
  })
  return <KitTable tableId="numbering-books" columns={columns} rows={rows} />
}

/**
 * One account's series in number order, each MISSING run as one highlighted line
 * and each number Acumatica re-used with a trailing dot as a grey STAGED line.
 */
export function NumberingEntriesTable({ entries }: { entries: readonly SeriesEntry[] }) {
  return (
    <KitTable tableId="numbering-entries" columns={CHECK_COLUMNS} rows={entryRows(entries)}
      bandsNote="MISSING LINES ARE HIDDEN WHILE A FILTER OR SORT IS IN FORCE." />
  )
}

/** Checks whose number cannot be placed in the sequence. */
export function NotNumericTable({ cheques }: { cheques: readonly SeriesCheque[] }) {
  return <KitTable tableId="numbering-not-numeric" columns={CHECK_COLUMNS} rows={cheques.map((c) => checkRow(c))} />
}

/** Checks and staged lines whose number breaks the book's pattern (spec §F): listed, not in the sequence. */
export function OutOfPatternTable({ entries }: { entries: readonly SeriesEntry[] }) {
  return <KitTable tableId="numbering-out-of-pattern" columns={CHECK_COLUMNS} rows={entryRows(entries.filter((e) => e.kind !== 'MISSING'))} />
}
