// lib/numbering/query.ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { buildSeries, stagedSeriesNumber, type AccountSeries, type SeriesCheque, type SeriesStaged } from './series'

type Db = PrismaClient | Prisma.TransactionClient

export type NumberingFilters = { companyId?: string; cashAccountId?: string }
export type NumberingAccount = { accountId: string; account: string; bank: string; company: string; series: AccountSeries }

type Group = { account: string; bank: string; company: string; cheques: SeriesCheque[]; staged: SeriesStaged[] }
type AccountRef = { id: string; code: string; bank: { code: string }; company: { code: string } }

/**
 * Every cheque that holds a number in a cash account's series: `isCheque`, a
 * cash account, and EVERY status — VOIDED, CANCELLED and no-amount cheques
 * included, because the number was used whatever happened to it (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B1). The cash account is
 * the series key: the sync publishes no cheque book. One query, grouped here;
 * ~12,000 rows.
 *
 * Plus the staged Acumatica payments that re-used a cheque number with a
 * trailing dot (spec §C): not promoted, joined to their account by
 * `cashAccountCode`, qualifying by `stagedSeriesNumber`. Read only.
 */
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]> {
  const rows = await db.check.findMany({
    where: {
      isCheque: true,
      cashAccountId: f.cashAccountId ?? { not: null },
      ...(f.companyId ? { cashAccount: { companyId: f.companyId } } : {}),
    },
    select: {
      id: true, checkNumber: true, checkDate: true, payeeName: true, amount: true, currency: true, status: true,
      cashAccount: { select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } },
    },
  })

  const byAccount = new Map<string, Group>()
  const groupFor = (a: AccountRef): Group => {
    let g = byAccount.get(a.id)
    if (!g) {
      g = { account: a.code, bank: a.bank.code, company: a.company.code, cheques: [], staged: [] }
      byAccount.set(a.id, g)
    }
    return g
  }
  for (const r of rows) {
    if (!r.cashAccount) continue
    groupFor(r.cashAccount).cheques.push({
      id: r.id, checkNumber: r.checkNumber, checkDate: r.checkDate, payeeName: r.payeeName,
      amount: r.amount?.toFixed(2) ?? null, currency: r.currency, status: r.status,
    })
  }

  const stagedRows = await db.stagedCheck.findMany({
    where: { source: 'ACUMATICA', reason: 'NO_CHECK_NUMBER', promotedCheckId: null, cashAccountCode: { not: null } },
    select: { acumaticaRef: true, statedCheckRef: true, checkDate: true, payeeName: true, amount: true, currency: true, cashAccountCode: true },
  })
  const dotted = stagedRows.filter((s) => s.acumaticaRef && stagedSeriesNumber(s.statedCheckRef) !== null)
  const codes = [...new Set(dotted.map((s) => s.cashAccountCode!))]
  const accounts = codes.length
    ? await db.cashAccount.findMany({
      where: {
        code: { in: codes },
        ...(f.cashAccountId ? { id: f.cashAccountId } : {}),
        ...(f.companyId ? { companyId: f.companyId } : {}),
      },
      select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } },
    })
    : []
  const accountByCode = new Map(accounts.map((a) => [a.code, a]))
  for (const s of dotted) {
    const a = accountByCode.get(s.cashAccountCode!)
    if (!a) continue
    groupFor(a).staged.push({
      acumaticaRef: s.acumaticaRef!, statedCheckRef: s.statedCheckRef!, checkDate: s.checkDate, payeeName: s.payeeName,
      amount: s.amount?.toFixed(2) ?? null, currency: s.currency,
    })
  }

  return [...byAccount.entries()]
    .map(([accountId, g]) => ({ accountId, account: g.account, bank: g.bank, company: g.company, series: buildSeries(g.cheques, g.staged) }))
    .sort((a, b) => a.account.localeCompare(b.account) || a.company.localeCompare(b.company) || a.accountId.localeCompare(b.accountId))
}

/** Cheques in no series because they carry no cash account — stated on the page, not listed. */
export async function countChequesWithoutAccount(db: Db, f: { companyId?: string }): Promise<number> {
  return db.check.count({ where: { isCheque: true, cashAccountId: null, ...(f.companyId ? { companyId: f.companyId } : {}) } })
}
