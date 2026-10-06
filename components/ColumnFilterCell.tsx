'use client'

import type { ReactNode } from 'react'
import type { FilterOptions } from '@/lib/queries'
import type { ColumnKey } from '@/lib/table-columns'
import { bankLabel } from '@/lib/export/report'
import { LIST_FILTER_FORM } from '@/lib/column-filters'
import { LIVE_STATUSES, CLOSED_STATUSES } from '@/lib/domain/check-status'

/**
 * One box of the filter row under the headers (spec 2026-10-01, part C2).
 *
 * Every control belongs to the bar's form by `form={LIST_FILTER_FORM}` — it is
 * rendered in the table head, outside the form element, and the attribute is
 * what makes a native GET submit (no JavaScript) still send it.
 * Uncontrolled (`defaultValue`): `FilterAutoSubmit` soft-navigates and the DOM
 * survives, which is what keeps the caret in a box while typing.
 * Amounts are TEXT boxes: an amount is a decimal string (rule 8), and a
 * `type="number"` box would hide an unreadable value instead of letting the
 * server refuse it beside the box.
 */

export type FilterRowState = {
  options: FilterOptions
  /** Each box's value as typed (company and bank as ids). */
  values: Readonly<Record<string, string>>
  /** Parameter → message, for the boxes the server could not read. */
  errors: Readonly<Record<string, string>>
  /** STATUS has a box on ALL CHEQUES only. */
  showStatus: boolean
  /** DATE RELEASED has boxes on RELEASED and ALL CHEQUES only. */
  showReleasedRange: boolean
  /** Columns with a box in force — never hidden. */
  filteredColumns: readonly ColumnKey[]
}

const box = 'h-8 w-full min-w-[6.5rem] rounded border bg-white px-2 text-xs font-normal normal-case tracking-normal text-slate-900 focus:border-navy focus:outline-none'
const STATUSES = [...LIVE_STATUSES, ...CLOSED_STATUSES]

function Refusal({ name, errors }: { name: string; errors: FilterRowState['errors'] }) {
  return errors[name]
    ? <p role="alert" className="mt-1 text-[10px] font-semibold normal-case text-red-700">{errors[name]}</p>
    : null
}

export function ColumnFilterCell({ column, state }: { column: Exclude<ColumnKey, 'action'>; state: FilterRowState }): ReactNode {
  const value = (name: string) => state.values[name] ?? ''
  const border = (name: string) => (state.errors[name] ? 'border-red-600' : 'border-hairline')

  const text = (name: string, label: string) => (
    <>
      <input
        type="text" form={LIST_FILTER_FORM} name={name} defaultValue={value(name)}
        aria-label={`${label} contains`} aria-invalid={Boolean(state.errors[name])}
        placeholder="contains…" className={`${box} ${border(name)}`}
      />
      <Refusal name={name} errors={state.errors} />
    </>
  )

  const range = (from: string, to: string, label: string, kind: 'date' | 'amount') => (
    <div className="flex flex-col gap-1">
      {([[from, kind === 'amount' ? 'MIN' : 'FROM'], [to, kind === 'amount' ? 'MAX' : 'TO']] as const).map(([name, edge]) => (
        <input
          key={name}
          type={kind === 'date' ? 'date' : 'text'}
          inputMode={kind === 'amount' ? 'decimal' : undefined}
          form={LIST_FILTER_FORM} name={name} defaultValue={value(name)}
          aria-label={`${label} ${edge}`} aria-invalid={Boolean(state.errors[name])}
          placeholder={kind === 'amount' ? edge : undefined}
          className={`${box} ${border(name)}`}
        />
      ))}
      <Refusal name={from} errors={state.errors} />
      <Refusal name={to} errors={state.errors} />
    </div>
  )

  switch (column) {
    case 'checkNumber': return text('f.checkNumber', 'CHECK NUMBER')
    case 'apvNumbers': return text('f.apv', 'APV NUMBER')
    case 'poNumbers': return text('f.po', 'PO NUMBER')
    case 'payeeName': return text('f.payee', 'SUPPLIER NAME')
    case 'companyCode':
      return (
        <select form={LIST_FILTER_FORM} name="company" defaultValue={value('company')} aria-label="COMPANY" className={`${box} border-hairline`}>
          <option value="">ALL</option>
          {state.options.companies.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
      )
    case 'bank':
      return (
        <select form={LIST_FILTER_FORM} name="cashAccount" defaultValue={value('cashAccount')} aria-label="BANK / CASH ACCOUNT" className={`${box} border-hairline`}>
          <option value="">ALL</option>
          {state.options.cashAccounts.map((a) => <option key={a.id} value={a.id}>{bankLabel(a.code, a.bankCode)}</option>)}
        </select>
      )
    case 'status':
      return state.showStatus ? (
        <>
          <select form={LIST_FILTER_FORM} name="f.status" defaultValue={value('f.status')} aria-label="STATUS"
            aria-invalid={Boolean(state.errors['f.status'])} className={`${box} ${border('f.status')}`}>
            <option value="">ALL</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <Refusal name="f.status" errors={state.errors} />
        </>
      ) : null
    case 'checkDate': return range('f.checkDateFrom', 'f.checkDateTo', 'CHECK DATE', 'date')
    case 'amount': return range('f.amountMin', 'f.amountMax', 'AMOUNT', 'amount')
    case 'availablePickupDate': return range('f.availablePickupDateFrom', 'f.availablePickupDateTo', 'AVAILABLE DATE', 'date')
    case 'scheduledPickupDate': return range('f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo', 'PICKUP SCHEDULE', 'date')
    case 'releasedAt':
      return state.showReleasedRange ? range('releasedFrom', 'releasedTo', 'DATE RELEASED', 'date') : null
    default: {
      const unreachable: never = column
      return unreachable
    }
  }
}
