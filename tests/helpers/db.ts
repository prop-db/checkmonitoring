import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './test-db-url'

export const testDb = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
})

export async function resetDb() {
  // Order matters: children before parents.
  await testDb.auditLog.deleteMany()
  await testDb.portalEvent.deleteMany()
  await testDb.notification.deleteMany()
  await testDb.checkBill.deleteMany()
  await testDb.check.deleteMany()
  await testDb.cashAccount.deleteMany()
  await testDb.checkBook.deleteMany()
  await testDb.vendor.deleteMany()
  await testDb.company.deleteMany()
  await testDb.bank.deleteMany()
  await testDb.user.deleteMany()
}
