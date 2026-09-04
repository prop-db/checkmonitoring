import type { Prisma, PrismaClient } from '@prisma/client'
import { DomainError } from '@/lib/domain/errors'
import type { CompanyReferenceData } from './company'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The cash-account and checkbook tables `resolveCompany` reads, taken from the
 * DATABASE rather than from `prisma/reference-data.ts`.
 *
 * They are the same six accounts and six books today, and reading the seeded
 * rows instead of the seed file is deliberate: `upsertCheck` links a cheque to
 * the `CashAccount` and `CheckBook` rows that actually exist, so resolving the
 * company from a file the database might not match would let the importer
 * decide a company from a book it then declines to link. One source.
 */
export async function loadCompanyReferenceData(db: Db): Promise<CompanyReferenceData> {
  const [cashAccounts, checkBooks] = await Promise.all([
    db.cashAccount.findMany({ select: { code: true, company: { select: { code: true } } } }),
    db.checkBook.findMany({ select: { code: true, company: { select: { code: true } } } }),
  ])

  // An unseeded database resolves no company for any row, which would stage all
  // 12,227 of them and look exactly like a register with no checkbook column.
  // Refusing outright is the difference between a configuration error and a
  // 2,766-row data-quality problem that is not real.
  if (cashAccounts.length === 0 || checkBooks.length === 0) {
    throw new DomainError(
      'NO_REFERENCE_DATA',
      'No cash accounts or check books are registered, so no row can resolve a company. ' +
        'Seed the reference data before importing.',
    )
  }

  return {
    cashAccounts: cashAccounts.map((a) => ({ code: a.code, company: a.company.code })),
    checkBooks: checkBooks.map((b) => ({ code: b.code, company: b.company.code })),
  }
}

/** `classifyEligibility` needs the client's own legal names to tell an
 * inter-company cheque from a supplier one. */
export async function loadOwnCompanyNames(db: Db): Promise<string[]> {
  const companies = await db.company.findMany({ select: { legalNames: true } })
  return companies.flatMap((c) => c.legalNames)
}
