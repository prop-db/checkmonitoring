// lib/numbering/query.ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { buildSeries, type AccountSeries, type SeriesCheque } from './series'

type Db = PrismaClient | Prisma.TransactionClient

export type NumberingFilters = { companyId?: string; cashAccountId?: string }
export type NumberingAccount = { accountId: string; account: string; bank: string; company: string; series: AccountSeries }

/**
 * Every cheque that holds a number in a cash account's series: `isCheque`, a
 * cash account, and EVERY status — VOIDED, CANCELLED and no-amount cheques
 * included, because the number was used whatever happened to it (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B1). The cash account is
 * the series key: the sync publishes no cheque book. One query, grouped here;
 * ~12,000 rows.
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

  const byAccount = new Map<string, { account: string; bank: string; company: string; cheques: SeriesCheque[] }>()
  for (const r of rows) {
    if (!r.cashAccount) continue
    let group = byAccount.get(r.cashAccount.id)
    if (!group) {
      group = { account: r.cashAccount.code, bank: r.cashAccount.bank.code, company: r.cashAccount.company.code, cheques: [] }
      byAccount.set(r.cashAccount.id, group)
    }
    group.cheques.push({
      id: r.id, checkNumber: r.checkNumber, checkDate: r.checkDate, payeeName: r.payeeName,
      amount: r.amount?.toString() ?? null, currency: r.currency, status: r.status,
    })
  }

  return [...byAccount.entries()]
    .map(([accountId, g]) => ({ accountId, account: g.account, bank: g.bank, company: g.company, series: buildSeries(g.cheques) }))
    .sort((a, b) => a.account.localeCompare(b.account))
}

/** Cheques in no series because they carry no cash account — stated on the page, not listed. */
export async function countChequesWithoutAccount(db: Db, f: { companyId?: string }): Promise<number> {
  return db.check.count({ where: { isCheque: true, cashAccountId: null, ...(f.companyId ? { companyId: f.companyId } : {}) } })
}
