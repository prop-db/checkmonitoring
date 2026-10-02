// lib/admin/check-books.ts
import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { PAYMENTS_FEED, type AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { paymentsInScopeFilter } from '@/lib/sync/run'

/**
 * The cheque book of every Acumatica cheque that has none (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §D2). Acumatica's
 * `CashAccount` column states the cheque-book code (`BPI-S-4636`), but until
 * 2026-10-02 the sync dropped it, so 3,844 cheques carry no book. This reads
 * the payments feed (read-only), maps each cheque's payment to a CheckBook by
 * code, and sets `checkBookId` — only when the book's company is the cheque's
 * company. Nothing else is written; status never (rule 4).
 */
export const CHECK_BOOK_BACKFILL_ACTION = 'check_book_backfilled_from_acumatica'
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export type CheckBookCandidate = { checkId: string; checkNumber: string; acumaticaPaymentId: string; checkBookId: string; checkBookCode: string }
export type CheckBookPlan = {
  scanned: number
  candidates: CheckBookCandidate[]
  notInFeed: number
  notABook: Record<string, number>
  companyMismatch: { checkNumber: string; checkBookCode: string }[]
}

export async function planCheckBookBackfill(db: PrismaClient, client: AcumaticaClient, tenant: AcumaticaTenant): Promise<CheckBookPlan> {
  const rows = await client.fetchAll(PAYMENTS_FEED, {
    select: ['Type', 'ReferenceNbr', 'CashAccount'],
    filter: paymentsInScopeFilter(),
    orderby: 'LastModifiedOn asc',
    pageSize: 2000,
  })
  // A voided cheque is two rows under one reference; the original Payment row wins.
  const codeByRef = new Map<string, string>()
  for (const r of rows) {
    const ref = text(r.ReferenceNbr)
    const code = text(r.CashAccount)
    if (!ref || !code) continue
    if (!codeByRef.has(ref) || text(r.Type) === 'Payment') codeByRef.set(ref, code)
  }

  const books = await db.checkBook.findMany({ select: { id: true, code: true, companyId: true } })
  const bookByCode = new Map(books.map((b) => [b.code, b]))
  const cheques = await db.check.findMany({
    where: { acumaticaTenant: tenant, acumaticaPaymentId: { not: null }, checkBookId: null },
    select: { id: true, checkNumber: true, acumaticaPaymentId: true, companyId: true },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
  })

  const plan: CheckBookPlan = { scanned: cheques.length, candidates: [], notInFeed: 0, notABook: {}, companyMismatch: [] }
  for (const c of cheques) {
    const code = codeByRef.get(c.acumaticaPaymentId!)
    if (!code) { plan.notInFeed++; continue }
    const book = bookByCode.get(code)
    if (!book) { plan.notABook[code] = (plan.notABook[code] ?? 0) + 1; continue }
    if (book.companyId !== c.companyId) { plan.companyMismatch.push({ checkNumber: c.checkNumber, checkBookCode: code }); continue }
    plan.candidates.push({ checkId: c.id, checkNumber: c.checkNumber, acumaticaPaymentId: c.acumaticaPaymentId!, checkBookId: book.id, checkBookCode: code })
  }
  return plan
}

/** One transaction per cheque, conditional on it still having no book. Returns how many were set. */
export async function applyCheckBookBackfill(db: PrismaClient, candidates: readonly CheckBookCandidate[]): Promise<number> {
  let set = 0
  for (const c of candidates) {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.check.updateMany({ where: { id: c.checkId, checkBookId: null }, data: { checkBookId: c.checkBookId } })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: c.checkId, actorType: 'SYSTEM', action: CHECK_BOOK_BACKFILL_ACTION,
        details: { checkBookCode: c.checkBookCode, acumaticaPaymentId: c.acumaticaPaymentId },
        remarks: `Cheque book ${c.checkBookCode} recorded from Acumatica's CashAccount for payment ${c.acumaticaPaymentId}. Status unchanged.`,
      })
      return true
    }, TX_OPTIONS)
    if (done) set++
  }
  return set
}
