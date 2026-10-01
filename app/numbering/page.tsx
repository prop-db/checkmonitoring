// app/numbering/page.tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listNumberingAccounts, countChequesWithoutAccount } from '@/lib/numbering/query'
import {
  NUMBERING_PATH, NUMBERING_EXPORT_PATH, NUMBERING_SCOPE_NOTE,
  numberingHref, isMissingOnly, visibleEntries, describeNumberingFilters,
} from '@/lib/numbering-view'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { NumberingSummaryTable, NumberingEntriesTable, NotNumericTable } from '@/components/NumberingTables'

/**
 * CHEQUE NUMBERING — consecutives per cash account (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B3). Every cheque of
 * every status, in number order, with each unused number between the first and
 * last as one MISSING line. Everything shown is decided in `lib/numbering/`;
 * the export reads the same parameters, so the file and the screen agree.
 */
export default async function NumberingPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; account?: string; missing?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const options = await getFilterOptions(prisma)
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const accountParam = params.account?.trim() || undefined
  const account = options.cashAccounts.find((a) => a.id === accountParam)
  const missingOnly = isMissingOnly(params.missing)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  if (accountParam && !account) {
    return (
      <main className="mx-auto max-w-[1600px] space-y-6 p-8">
        <AppHeader user={user} title="CHEQUE NUMBERING" back={{ href: NUMBERING_PATH, label: '← ALL ACCOUNTS' }} />
        <EmptyState title="NO SUCH CASH ACCOUNT">That account is not on record. Choose one from the list.</EmptyState>
      </main>
    )
  }

  // With an account open the company filter is not applied, so it must not be described or counted either.
  const scopedCompany = account ? undefined : company
  const [accounts, noAccountCount] = await Promise.all([
    listNumberingAccounts(prisma, { companyId: scopedCompany?.id, cashAccountId: account?.id }),
    account ? Promise.resolve(0) : countChequesWithoutAccount(prisma, { companyId: scopedCompany?.id }),
  ])
  const current = { company: company?.id, account: account?.id, missing: missingOnly }
  const one = account ? accounts[0] : undefined

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="CHEQUE NUMBERING" back={{ href: '/', label: '← DASHBOARD' }} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        {NUMBERING_SCOPE_NOTE}
      </p>

      {!account && (
        <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
          <label className="sr-only" htmlFor="numbering-company">COMPANY</label>
          <select id="numbering-company" name="company" defaultValue={company?.id ?? ''} className={field}>
            <option value="">ANY COMPANY</option>
            {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
          <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
          {company && <Link href={NUMBERING_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
        </form>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {account ? account.code : `${accounts.length.toLocaleString('en-PH')} CASH ACCOUNT${accounts.length === 1 ? '' : 'S'}`}
            {' · '}{describeNumberingFilters({ company: scopedCompany?.code, account: account?.code, missingOnly })}
          </p>
          {!account && noAccountCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              NOT IN ANY SERIES: {noAccountCount.toLocaleString('en-PH')} CHEQUE{noAccountCount === 1 ? '' : 'S'} WITH NO CASH ACCOUNT.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {account && (
            <>
              <Link href={numberingHref({ company: company?.id })} className="text-sm text-slate-600 underline underline-offset-2">← ALL ACCOUNTS</Link>
              <Link href={numberingHref({ ...current, missing: !missingOnly })} className="rounded-lg px-3 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline">
                {missingOnly ? 'SHOW ALL' : 'MISSING ONLY'}
              </Link>
            </>
          )}
          <a href={numberingHref(current, NUMBERING_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">EXPORT EXCEL</a>
        </div>
      </div>

      {!account && (accounts.length === 0
        ? <EmptyState title="NO CHEQUES IN ANY CASH ACCOUNT">{company ? 'No cash account of this company holds a cheque.' : 'No cheque carries a cash account yet.'}</EmptyState>
        : <NumberingSummaryTable accounts={accounts} company={company?.id} />)}

      {account && !one && <EmptyState title="NO CHEQUES ON THIS ACCOUNT">No cheque on record carries this cash account.</EmptyState>}

      {one && (() => {
        const entries = visibleEntries(one.series.entries, missingOnly)
        return (
          <>
            {entries.length === 0 && one.series.summary.first === null && !missingOnly
              ? <EmptyState title="NO NUMERIC CHEQUES">Every cheque on this account carries a number that is not all digits; they are listed below.</EmptyState>
              : entries.length === 0
              ? <EmptyState title="NOTHING MISSING" tone="good">Every number from {one.series.summary.first ?? '—'} to {one.series.summary.last ?? '—'} is held here.</EmptyState>
              : <NumberingEntriesTable entries={entries} />}
            {!missingOnly && one.series.notNumeric.length > 0 && (
              <>
                <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">NOT NUMERIC — NOT IN THE SEQUENCE</h2>
                <NotNumericTable cheques={one.series.notNumeric} />
              </>
            )}
          </>
        )
      })()}
    </main>
  )
}
