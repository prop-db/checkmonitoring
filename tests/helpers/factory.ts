import { testDb } from './db'
import { isCheckIncomplete } from '@/lib/domain/incomplete'
import type { CheckStatus, Eligibility } from '@prisma/client'

export async function makeUser(role: 'FINANCE_USER' | 'FINANCE_ADMIN' = 'FINANCE_USER') {
  return testDb.user.create({
    data: { email: `u${Math.random().toString(36).slice(2)}@rcl.test`, name: 'Finance User', passwordHash: 'x', role },
  })
}

export async function makeCheck(overrides: {
  status?: CheckStatus
  eligibility?: Eligibility
  checkNumber?: string
  // `null` is meaningful and cannot be collapsed into the default with `??`:
  // 38 live cheques carry no check date, and the dashboard's default sort has
  // to put those last rather than first. Uses `=== undefined` below, for the
  // same reason `amount` and `payeeName` do.
  checkDate?: Date | null
  availablePickupDate?: Date | null
  isCheque?: boolean
  currency?: string
  // `null` is a distinct, meaningful value for both of these - the register
  // does not always record an amount (397 rows) or a payee (153) - so neither
  // can be collapsed into its default with `??`. Use `=== undefined` below.
  amount?: string | null
  payeeName?: string | null
} = {}) {
  const company = await testDb.company.create({
    data: { code: `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson Packaging Inc.', legalNames: [] },
  })
  const bank = await testDb.bank.create({
    data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' },
  })
  const cashAccount = await testDb.cashAccount.create({
    data: { code: `BPI STK ${Math.random().toString(36).slice(2, 7)}`, bankId: bank.id, companyId: company.id },
  })
  const amount = overrides.amount === undefined ? '197715.42' : overrides.amount
  return testDb.check.create({
    data: {
      companyId: company.id,
      cashAccountId: cashAccount.id,
      checkNumber: overrides.checkNumber ?? `600${Math.floor(Math.random() * 10_000_000)}`,
      checkDate: overrides.checkDate === undefined ? new Date('2026-09-01') : overrides.checkDate,
      amount,
      // Derived here for the same reason `upsertCheck` derives it: a fixture
      // whose flag disagrees with its own amount is a fixture that would let a
      // test pass over a state the application cannot produce. A test that
      // wants the two to disagree - the backfill's drift cases - sets the flag
      // explicitly afterwards.
      isIncomplete: isCheckIncomplete({ amount }),
      currency: overrides.currency ?? 'PHP',
      payeeName: overrides.payeeName === undefined ? 'HENKEL PHILIPPINES INC.' : overrides.payeeName,
      eligibility: overrides.eligibility ?? 'SUPPLIER',
      status: overrides.status ?? 'SIGNED',
      availablePickupDate: overrides.availablePickupDate === undefined ? null : overrides.availablePickupDate,
      isCheque: overrides.isCheque ?? true,
    },
  })
}
