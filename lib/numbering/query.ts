// lib/numbering/query.ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { buildSeries, stagedSeriesNumber, type AccountSeries, type SeriesCheque, type SeriesStaged } from './series'

type Db = PrismaClient | Prisma.TransactionClient

export type NumberingFilters = { companyId?: string; checkBookId?: string }
/** One series. `accountId` / `account` name the cheque book (`CheckBook.id` / `.code`). */
export type NumberingAccount = { accountId: string; account: string; bank: string; company: string; series: AccountSeries }

type Group = { account: string; bank: string; company: string; cheques: SeriesCheque[]; staged: SeriesStaged[] }
type BookRef = { id: string; code: string; bank: { code: string }; company: { code: string } }

/**
 * Every cheque that holds a number in a cheque book's series: `isCheque`, a
 * cheque book, and EVERY status — VOIDED, CANCELLED and no-amount cheques
 * included, because the number was used whatever happened to it (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B1). The series key is
 * the cheque book (`CheckBook`) — the bank account Acumatica states in its
 * CashAccount column, e.g. `BPI-S-4636` (spec §D). The register's cash-account
 * label is not the series: most cheques carry none. One query, grouped here;
 * ~13,000 rows.
 *
 * Plus the staged Acumatica payments that re-used a cheque number with a
 * trailing dot (spec §C): not promoted, joined to their cheque book by
 * `CheckBook.code = StagedCheck.cashAccountCode`, qualifying by
 * `stagedSeriesNumber`. Read only.
 */
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]> {
  const rows = await db.check.findMany({
    where: {
      isCheque: true,
      checkBookId: f.checkBookId ?? { not: null },
      ...(f.companyId ? { checkBook: { companyId: f.companyId } } : {}),
    },
    select: {
      id: true, checkNumber: true, checkDate: true, payeeName: true, amount: true, currency: true, status: true,
      checkBook: { select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } },
    },
  })

  const byBook = new Map<string, Group>()
  const groupFor = (b: BookRef): Group => {
    let g = byBook.get(b.id)
    if (!g) {
      g = { account: b.code, bank: b.bank.code, company: b.company.code, cheques: [], staged: [] }
      byBook.set(b.id, g)
    }
    return g
  }
  for (const r of rows) {
    if (!r.checkBook) continue
    groupFor(r.checkBook).cheques.push({
      id: r.id, checkNumber: r.checkNumber, checkDate: r.checkDate, payeeName: r.payeeName,
      amount: r.amount?.toFixed(2) ?? null, currency: r.currency, status: r.status,
    })
  }

  const stagedRows = await db.stagedCheck.findMany({
    where: { source: 'ACUMATICA', reason: 'NO_CHECK_NUMBER', promotedCheckId: null, cashAccountCode: { not: null } },
    orderBy: [{ acumaticaTenant: 'asc' }, { acumaticaRef: 'asc' }],
    select: { acumaticaTenant: true, acumaticaRef: true, statedCheckRef: true, checkDate: true, payeeName: true, amount: true, currency: true, cashAccountCode: true },
  })
  const dotted = stagedRows.filter((s) => s.acumaticaTenant && s.acumaticaRef && stagedSeriesNumber(s.statedCheckRef) !== null)
  const codes = [...new Set(dotted.map((s) => s.cashAccountCode!))]
  const books = codes.length
    ? await db.checkBook.findMany({
      where: {
        code: { in: codes },
        ...(f.checkBookId ? { id: f.checkBookId } : {}),
        ...(f.companyId ? { companyId: f.companyId } : {}),
      },
      select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } },
    })
    : []
  const bookByCode = new Map(books.map((b) => [b.code, b]))
  for (const s of dotted) {
    const b = bookByCode.get(s.cashAccountCode!)
    if (!b) continue
    groupFor(b).staged.push({
      acumaticaTenant: s.acumaticaTenant!, acumaticaRef: s.acumaticaRef!, statedCheckRef: s.statedCheckRef!, checkDate: s.checkDate, payeeName: s.payeeName,
      amount: s.amount?.toFixed(2) ?? null, currency: s.currency,
    })
  }

  return [...byBook.entries()]
    .map(([accountId, g]) => ({ accountId, account: g.account, bank: g.bank, company: g.company, series: buildSeries(g.cheques, g.staged) }))
    .sort((a, b) => a.account.localeCompare(b.account) || a.company.localeCompare(b.company) || a.accountId.localeCompare(b.accountId))
}

/** Cheques in no series because they carry no cheque book — stated on the page, not listed. */
export async function countChequesWithoutCheckBook(db: Db, f: { companyId?: string }): Promise<number> {
  return db.check.count({ where: { isCheque: true, checkBookId: null, ...(f.companyId ? { companyId: f.companyId } : {}) } })
}

/** The cheque books, by code — the series the NUMBERING page and export accept as `account`. */
export async function listCheckBookOptions(db: Db): Promise<{ id: string; code: string; bankCode: string }[]> {
  const books = await db.checkBook.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, bank: { select: { code: true } } } })
  return books.map((b) => ({ id: b.id, code: b.code, bankCode: b.bank.code }))
}
