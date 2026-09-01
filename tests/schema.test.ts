import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './helpers/test-db-url'

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } })

const createdCompanyIds: string[] = []

// The test database is a real cloud database, not an ephemeral container.
// A test that inserts without cleaning up grows it without bound on every run.
afterAll(async () => {
  await prisma.check.deleteMany({ where: { companyId: { in: createdCompanyIds } } })
  await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } })
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
})
