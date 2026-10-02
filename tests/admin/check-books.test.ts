// tests/admin/check-books.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { AcumaticaClient, AcumaticaRow } from '@/lib/integrations/acumatica/client'
import { planCheckBookBackfill, applyCheckBookBackfill, CHECK_BOOK_BACKFILL_ACTION } from '@/lib/admin/check-books'

beforeEach(resetDb)

const fake = (rows: AcumaticaRow[]): AcumaticaClient => ({ fetchPage: async () => rows, fetchAll: async () => rows })
const pay = (ref: string, cash: string, type = 'Payment'): AcumaticaRow => ({ Type: type, ReferenceNbr: ref, CashAccount: cash })

/** A cheque the sync created (tenant + payment id), and a cheque book under the same company and bank. */
async function acumaticaCheque(ref: string, checkNumber: string) {
  const c = await makeCheck({ checkNumber, status: 'SIGNED' })
  return testDb.check.update({ where: { id: c.id }, data: { acumaticaTenant: 'GOLIVE', acumaticaPaymentId: ref } })
}
async function bookFor(c: { companyId: string; cashAccountId: string | null }, code: string) {
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  return testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
}

describe('planCheckBookBackfill', () => {
  it('matches each cheque to the book its payment states, and reports what it cannot set', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const b = await acumaticaCheque('CV-2', '6000000002')
    const c = await acumaticaCheque('CV-3', '6000000003')
    const d = await acumaticaCheque('CV-4', '6000000004')
    const bookA = await bookFor(a, 'BPI-S-4636')
    const other = await makeCheck({ checkNumber: '1' })
    await bookFor(other, 'MBT-A-4155') // a book under ANOTHER company
    const plan = await planCheckBookBackfill(testDb, fake([
      pay('CV-1', 'BPI-S-4636'), pay('CV-1', 'BPI-S-4636', 'Voided Payment'),
      pay('CV-2', 'PCF-SITIO'),
      pay('CV-3', 'MBT-A-4155'),
    ]), 'GOLIVE')
    expect(plan.scanned).toBe(4)
    expect(plan.candidates).toEqual([{ checkId: a.id, checkNumber: '6000000001', acumaticaPaymentId: 'CV-1', checkBookId: bookA.id, checkBookCode: 'BPI-S-4636' }])
    expect(plan.notABook).toEqual({ 'PCF-SITIO': 1 })
    expect(plan.companyMismatch).toEqual([{ checkNumber: '6000000003', checkBookCode: 'MBT-A-4155' }])
    expect(plan.notInFeed).toBe(1) // CV-4
    // A dry run writes nothing: the plan is a read.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBeNull()
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_BACKFILL_ACTION } })).toBe(0)
    void b; void c; void d
  })

  it('ignores cheques that already have a book, have no payment id, or belong to the other tenant', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const book = await bookFor(a, 'BPI-S-4636')
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: book.id } })
    await makeCheck({ checkNumber: '6000000002' }) // register-only: no payment id
    const m = await acumaticaCheque('CV-9', '6000000009')
    await testDb.check.update({ where: { id: m.id }, data: { acumaticaTenant: 'MANUFACTURING' } })
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636'), pay('CV-9', 'BPI-S-4636')]), 'GOLIVE')
    expect(plan.scanned).toBe(0)
    expect(plan.candidates).toEqual([])
  })
})

describe('applyCheckBookBackfill', () => {
  it('sets the book and writes one audit row each; status untouched; a second run is a no-op', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.checkBookId).toBe(plan.candidates[0].checkBookId)
    expect(after.status).toBe('SIGNED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: a.id, action: CHECK_BOOK_BACKFILL_ACTION } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ checkBookCode: 'BPI-S-4636', acumaticaPaymentId: 'CV-1' })
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_BACKFILL_ACTION } })).toBe(1)
  })

  it('leaves a cheque that gained a book after planning', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const book = await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    const other = await testDb.checkBook.create({ data: { code: 'BPI-S-0000', bankId: book.bankId, companyId: book.companyId } })
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: other.id } })
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBe(other.id)
  })
})
