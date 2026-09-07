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
    // Not a child of Check either: a staged bill exists precisely because it
    // attaches to no cheque. Truncated here so one file's refused rows are not
    // another file's staged count.
    await tx.stagedBill.deleteMany()
    await tx.cashAccount.deleteMany()
    await tx.checkBook.deleteMany()
    await tx.vendor.deleteMany()
    await tx.company.deleteMany()
    await tx.bank.deleteMany()
    await tx.user.deleteMany()
    // Not a child of User and deliberately so — the throttle counts attempts
    // against addresses no account exists under. It is truncated here all the
    // same: a failure count that leaked in from another file's fixtures would
    // lock a login test out of an account it just created.
    await tx.loginAttempt.deleteMany()
    await tx.syncRun.deleteMany()
    await tx.setting.deleteMany()
  })
}
