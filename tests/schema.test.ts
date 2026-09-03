import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './helpers/test-db-url'
import { checkReadyForRelease } from '@/lib/domain/check-status'

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } })

const createdCompanyIds: string[] = []
const createdBankIds: string[] = []

// The test database is a real cloud database, not an ephemeral container.
// A test that inserts without cleaning up grows it without bound on every run.
// Order matters: children before parents, and a cash account is a child of both
// a company and a bank.
afterAll(async () => {
  await prisma.check.deleteMany({ where: { companyId: { in: createdCompanyIds } } })
  await prisma.cashAccount.deleteMany({ where: { companyId: { in: createdCompanyIds } } })
  await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } })
  await prisma.bank.deleteMany({ where: { id: { in: createdBankIds } } })
  await prisma.$disconnect()
})

describe('schema', () => {
  it('enforces the composite unique key on company + check number', async () => {
    const company = await prisma.company.create({
      data: { code: `T${Date.now()}`, name: 'Test Co', legalNames: [] },
    })
    createdCompanyIds.push(company.id)

    const base = {
      companyId: company.id,
      checkNumber: '6000000001',
      amount: '100.00',
      payeeName: 'ACME',
      eligibility: 'SUPPLIER' as const,
    }
    await prisma.check.create({ data: base })
    await expect(prisma.check.create({ data: base })).rejects.toThrow()
  })

  // The register does not always know what it is paying or to whom: 397 of its
  // 12,161 rows carry no amount and 153 no payee. Storing 0.00 would understate
  // every total the cheque appears in and storing '' would read as a cheque
  // payable to nobody, so both columns are NULL-able and NULL means exactly
  // "the register does not record it".
  it('stores a cheque whose amount and payee the register does not record', async () => {
    const company = await prisma.company.create({
      data: { code: `T${Date.now()}N`, name: 'Test Co', legalNames: [] },
    })
    createdCompanyIds.push(company.id)
    const bank = await prisma.bank.create({ data: { code: `B${Date.now()}`, name: 'BPI' } })
    createdBankIds.push(bank.id)
    const cashAccount = await prisma.cashAccount.create({
      data: { code: `BPI STK ${Date.now()}`, bankId: bank.id, companyId: company.id },
    })

    const created = await prisma.check.create({
      data: {
        companyId: company.id,
        cashAccountId: cashAccount.id,
        checkNumber: '6000000002',
        checkDate: new Date('2026-09-01'),
        amount: null,
        payeeName: null,
        eligibility: 'INTERNAL',      // which is what a null payee classifies as
        status: 'SIGNED',
      },
    })

    const row = await prisma.check.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.amount).toBeNull()
    expect(row.payeeName).toBeNull()

    // And the consequence that makes the nulls safe to store: the release guard
    // already refuses such a cheque, naming both gaps, so it imports and is
    // visible but cannot be handed to a supplier until someone fills them in.
    // The exact string is the one Plan 1 shipped - it is user-facing copy, so
    // assert it verbatim rather than matching a substring.
    const guard = checkReadyForRelease({
      status: row.status,
      checkNumber: row.checkNumber,
      payeeName: row.payeeName,
      amount: row.amount?.toString() ?? null,
      checkDate: row.checkDate,
      cashAccountCode: cashAccount.code,
      availablePickupDate: new Date('2026-09-02'),
      isCheque: row.isCheque,
    })
    expect(guard.ok).toBe(false)
    expect(guard).toEqual({
      ok: false,
      code: 'MISSING_FIELDS',
      message: 'This check cannot be released because required information is missing: PAYEE, AMOUNT.',
    })
  })
})
