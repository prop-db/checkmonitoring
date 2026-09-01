import { describe, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_TEST } } })

describe('schema', () => {
  it('enforces the composite unique key on company + check number', async () => {
    const company = await prisma.company.create({
      data: { code: `T${Date.now()}`, name: 'Test Co', legalNames: [] },
    })
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
