import type { CheckStatus, ClearingStatus } from '@/lib/domain/check-status'
import { toCentavos, fromCentavos } from '@/lib/export/report'
import { issuedOn, isOutstandingAsOf, type IssueBasis } from './outstanding'

/**
 * The account table and the list behind it, struck over one set of rows so
 * the two cannot disagree. Centavo arithmetic, per currency, never across —
 * the same discipline as `lib/forecast/matrix.ts`.
 */
export const NO_ACCOUNT = '(NO ACCOUNT)'

export type OutstandingRow = {
  id: string
  checkNumber: string
  payee: string | null
  accountId: string | null
  account: string | null
  bank: string | null
  company: string
  currency: string
  /** A decimal STRING — rule 8. */
  amount: string
  checkDate: Date | null
  releasedAt: Date | null
  clearingStatus: ClearingStatus
  clearedDate: Date | null
  status: CheckStatus
}

export type OutstandingLine = OutstandingRow & { issuedDay: string | null; basis: IssueBasis | null; days: number | null }
export type AccountTotal = { currency: string; count: number; total: string }
export type AccountLine = { accountId: string | null; account: string; bank: string | null; company: string; count: number; totals: AccountTotal[] }
export type ReconSummary = { accounts: AccountLine[]; totals: AccountTotal[]; lines: OutstandingLine[] }

const DAY_MS = 24 * 60 * 60 * 1000
const instant = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** Whole days from one `YYYY-MM-DD` to another; negative when the first is later. */
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((instant(toDay) - instant(fromDay)) / DAY_MS)
}

type Acc = Map<string, { count: number; cents: bigint }>
const add = (acc: Acc, currency: string, amount: string) => {
  const prior = acc.get(currency) ?? { count: 0, cents: 0n }
  acc.set(currency, { count: prior.count + 1, cents: prior.cents + toCentavos(amount) })
}
const seal = (acc: Acc): AccountTotal[] =>
  [...acc.entries()].sort(([x], [y]) => x.localeCompare(y))
    .map(([currency, { count, cents }]) => ({ currency, count, total: fromCentavos(cents) }))

export function summariseByAccount(rows: readonly OutstandingRow[], asOfDay: string): ReconSummary {
  const lines: OutstandingLine[] = rows
    .filter((r) => isOutstandingAsOf(r, asOfDay))
    .map((r) => {
      const issued = issuedOn(r)
      return {
        ...r,
        issuedDay: issued?.day ?? null,
        basis: issued?.basis ?? null,
        days: issued ? daysBetween(issued.day, asOfDay) : null,
      }
    })

  // Grouped by account id; the rows with none share one group. The key is
  // the id, not the code, so two accounts could never fold on a shared label.
  const groups = new Map<string, { line: Omit<AccountLine, 'count' | 'totals'>; acc: Acc; count: number }>()
  const grand: Acc = new Map()
  for (const l of lines) {
    const key = l.accountId ?? NO_ACCOUNT
    const g = groups.get(key) ?? {
      line: { accountId: l.accountId, account: l.account ?? NO_ACCOUNT, bank: l.bank, company: l.company },
      acc: new Map(), count: 0,
    }
    add(g.acc, l.currency, l.amount)
    add(grand, l.currency, l.amount)
    g.count += 1
    groups.set(key, g)
  }

  // Bank, then account code — the Cash Balance sheet's own order. No-account
  // rows last, whatever their bank.
  const accounts = [...groups.values()]
    .map((g) => ({ ...g.line, count: g.count, totals: seal(g.acc) }))
    .sort((a, b) => {
      if (a.accountId === null) return 1
      if (b.accountId === null) return -1
      return (a.bank ?? '').localeCompare(b.bank ?? '') || a.account.localeCompare(b.account)
    })

  return { accounts, totals: seal(grand), lines }
}
