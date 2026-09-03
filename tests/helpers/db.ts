import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './test-db-url'

export const testDb = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
})

export async function resetDb() {
  // Order matters: children before parents.
  await testDb.$transaction(async (tx) => {
    // The AuditLog trigger blocks DELETE. Tests are the only legitimate reason
    // to purge audit history; SET LOCAL scopes this to the transaction.
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_audit_purge = 'on'`)
    await tx.auditLog.deleteMany()
    await tx.portalEvent.deleteMany()
    await tx.notification.deleteMany()
    await tx.checkBill.deleteMany()
    await tx.check.deleteMany()
    // Not a child of Check: a staged row exists precisely because it could not
    // become one. Truncated here all the same, so a test's staging count is its
    // own.
    await tx.stagedCheck.deleteMany()
    await tx.cashAccount.deleteMany()
    await tx.checkBook.deleteMany()
    await tx.vendor.deleteMany()
    await tx.company.deleteMany()
    await tx.bank.deleteMany()
    await tx.user.deleteMany()
    await tx.syncRun.deleteMany()
    await tx.setting.deleteMany()
  })
}
