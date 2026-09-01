import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './test-db-url'

export const testDb = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
})

export async function resetDb() {
  // Order matters: children before parents.
  await testDb.$transaction([
    testDb.auditLog.deleteMany(),
    testDb.portalEvent.deleteMany(),
    testDb.notification.deleteMany(),
    testDb.checkBill.deleteMany(),
    testDb.check.deleteMany(),
    testDb.cashAccount.deleteMany(),
    testDb.checkBook.deleteMany(),
    testDb.vendor.deleteMany(),
    testDb.company.deleteMany(),
    testDb.bank.deleteMany(),
    testDb.user.deleteMany(),
    testDb.syncRun.deleteMany(),
    testDb.setting.deleteMany(),
  ])
}
