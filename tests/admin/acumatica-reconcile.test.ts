import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import {
  findClosedButDeadHere, releaseClosed, planFinanceVerdicts, applyAvailable, applyStaled, parseVerdict,
  RELEASED_FROM_CLOSED_ACTION, REINSTATED_ACTION, STALED_ACTION,
  voidedReferences, findSwappedSharedNumbers, repointToLivePayments, REPOINTED_ACTION,
} from '@/lib/admin/acumatica-reconcile'
import { markReadyForRelease } from '@/lib/domain/actions'

const NOW = new Date('2026-10-06T10:00:00+08:00')

beforeEach(resetDb)

let seq = 0
async function acumaticaCheck(
  status: 'CANCELLED' | 'VOIDED' | 'SIGNED',
  acumaticaStatus: string,
  extra: { acumaticaDocType?: string; amount?: string | null; checkNumber?: string } = {},
) {
  const c = await makeCheck({ status, amount: extra.amount, checkNumber: extra.checkNumber, apvNumbers: ['AP-ST000001'] })
  seq += 1
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: `CV-T${String(seq).padStart(6, '0')}`, acumaticaTenant: 'GOLIVE',
      acumaticaStatus, acumaticaDocType: extra.acumaticaDocType ?? 'Payment',
      sourceSheet: status === 'CANCELLED' ? 'CANCELLED' : null,
      cancelledAt: status === 'CANCELLED' ? NOW : null, cancelReason: status === 'CANCELLED' ? 'register' : null,
      voidedAt: status === 'VOIDED' ? NOW : null,
    },
  })
}

describe('findClosedButDeadHere', () => {
  it('selects register-cancelled and system-voided cheques Acumatica holds Closed, and nothing else', async () => {
    const cancelled = await acumaticaCheck('CANCELLED', 'Closed')
    const voided = await acumaticaCheck('VOIDED', 'Closed')
    await acumaticaCheck('CANCELLED', 'Balanced')
    await acumaticaCheck('SIGNED', 'Closed')
    await acumaticaCheck('VOIDED', 'Closed', { acumaticaDocType: 'Voided Payment' })
    const byUser = await acumaticaCheck('CANCELLED', 'Closed')
    const user = await makeUser()
    await testDb.check.update({ where: { id: byUser.id }, data: { cancelledById: user.id } })
    const voidedByUser = await acumaticaCheck('VOIDED', 'Closed')
    await testDb.auditLog.create({ data: { checkId: voidedByUser.id, actorType: 'USER', userId: user.id, action: 'voided' } })

    const rows = await findClosedButDeadHere(testDb)
    expect(rows.map((r) => r.id).sort()).toEqual([cancelled.id, voided.id].sort())
  })
})

describe('releaseClosed', () => {
  it('moves each to RELEASED, clears the cancel and void fields, keeps them on one audit row, and is idempotent', async () => {
    const c = await acumaticaCheck('CANCELLED', 'Closed')
    const v = await acumaticaCheck('VOIDED', 'Closed')
    expect(await releaseClosed(testDb, await findClosedButDeadHere(testDb))).toBe(2)

    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after).toMatchObject({ status: 'RELEASED', cancelledAt: null, cancelReason: null, releasedAt: null, releasedById: null })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: v.id } })).voidedAt).toBeNull()
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: RELEASED_FROM_CLOSED_ACTION } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ from: 'CANCELLED', to: 'RELEASED', cancelReason: 'register', sourceSheet: 'CANCELLED' })
    expect(await testDb.portalEvent.count()).toBe(0)

    expect(await findClosedButDeadHere(testDb)).toEqual([])
    expect(await releaseClosed(testDb, [])).toBe(0)
  })
})

describe('Finance verdicts', () => {
  it('parses the three verdicts and nothing else', () => {
    expect(parseVerdict(' available ')).toBe('AVAILABLE')
    expect(parseVerdict('STALED')).toBe('STALED')
    expect(parseVerdict('CANCELLED')).toBe('CANCELLED')
    expect(parseVerdict('STALE')).toBeNull()
  })

  it('AVAILABLE: READY FOR RELEASE through the app path, with the portal told', async () => {
    const user = await makeUser()
    const c = await acumaticaCheck('CANCELLED', 'Balanced')
    const plan = await planFinanceVerdicts(testDb, [{ checkNumber: c.checkNumber, cv: c.acumaticaPaymentId!, verdict: 'AVAILABLE', row: 3 }])
    expect(plan.available).toHaveLength(1)

    const out = await applyAvailable(testDb, plan.available, { userId: user.id, now: NOW })
    expect(out).toEqual([{ checkNumber: c.checkNumber, ok: true }])
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after).toMatchObject({ status: 'READY_FOR_RELEASE', readyById: user.id, cancelledAt: null, cancelReason: null })
    expect(after.availablePickupDate?.toISOString()).toBe('2026-10-06T00:00:00.000Z')
    expect(await testDb.portalEvent.count({ where: { checkId: c.id, kind: 'MARK_AVAILABLE' } })).toBe(1)
    expect(await testDb.auditLog.count({ where: { checkId: c.id, action: REINSTATED_ACTION } })).toBe(1)

    const again = await planFinanceVerdicts(testDb, [{ checkNumber: c.checkNumber, cv: c.acumaticaPaymentId!, verdict: 'AVAILABLE', row: 3 }])
    expect(again.done).toHaveLength(1)
    expect(again.available).toHaveLength(0)
  })

  it('AVAILABLE the guard refuses (no amount) stays CANCELLED, with nothing written', async () => {
    const user = await makeUser()
    const c = await acumaticaCheck('CANCELLED', 'Balanced', { amount: null })
    const plan = await planFinanceVerdicts(testDb, [{ checkNumber: c.checkNumber, cv: c.acumaticaPaymentId!, verdict: 'AVAILABLE', row: 4 }])
    const [out] = await applyAvailable(testDb, plan.available, { userId: user.id, now: NOW })
    expect(out.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED')
    expect(await testDb.auditLog.count({ where: { checkId: c.id, action: REINSTATED_ACTION } })).toBe(0)
  })

  it('refuses a line whose cheque number disagrees with its CV, or names no cheque', async () => {
    const c = await acumaticaCheck('CANCELLED', 'Balanced')
    const plan = await planFinanceVerdicts(testDb, [
      { checkNumber: '999', cv: c.acumaticaPaymentId!, verdict: 'AVAILABLE', row: 5 },
      { checkNumber: c.checkNumber, cv: 'CV-NOPE', verdict: 'STALED', row: 6 },
    ])
    expect(plan.refused.map((r) => r.line.row)).toEqual([5, 6])
    expect(plan.available).toHaveLength(0)
    expect(plan.staled).toHaveLength(0)
  })

  it('STALED: stays CANCELLED, flagged, one audit row; CANCELLED: untouched', async () => {
    const user = await makeUser()
    const s = await acumaticaCheck('CANCELLED', 'Balanced')
    const k = await acumaticaCheck('CANCELLED', 'Balanced')
    const plan = await planFinanceVerdicts(testDb, [
      { checkNumber: s.checkNumber, cv: s.acumaticaPaymentId!, verdict: 'STALED', row: 7 },
      { checkNumber: k.checkNumber, cv: k.acumaticaPaymentId!, verdict: 'CANCELLED', row: 8 },
    ])
    expect(plan.keepCancelled).toHaveLength(1)
    expect(await applyStaled(testDb, plan.staled, { userId: user.id })).toBe(1)
    expect(await testDb.check.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: 'CANCELLED', isStale: true })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: k.id } })).toMatchObject({ status: 'CANCELLED', isStale: false })
    expect(await testDb.auditLog.count({ where: { action: STALED_ACTION } })).toBe(1)
    expect(await applyStaled(testDb, plan.staled, { userId: user.id })).toBe(0)
  })
})

describe('markReadyForRelease: the account', () => {
  it('accepts a cheque with a cheque book and no register cash-account label', async () => {
    const user = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    const bank = await testDb.bank.create({ data: { code: `BK${Date.now() % 100000}`, name: 'BPI' } })
    const book = await testDb.checkBook.create({ data: { code: `BPI-S-${Date.now() % 10000}`, bankId: bank.id, companyId: c.companyId } })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null, checkBookId: book.id } })

    await markReadyForRelease(testDb, { checkId: c.id, userId: user.id, availablePickupDate: new Date('2026-10-07'), now: NOW })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('still refuses a cheque with neither, naming both', async () => {
    const user = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null } })
    await expect(markReadyForRelease(testDb, { checkId: c.id, userId: user.id, availablePickupDate: new Date('2026-10-07'), now: NOW }))
      .rejects.toThrow(/CASH ACCOUNT \/ CHEQUE BOOK/)
  })
})

describe('live voids and swapped shared numbers (2026-10-07)', () => {
  it('voidedReferences reads a Voided Payment row or a Voided status, whatever the original says', async () => {
    const refs = voidedReferences([
      { ReferenceNbr: 'CV-PEND', Type: 'Voided Payment', Status: 'Balanced' },
      { ReferenceNbr: 'CV-PEND', Type: 'Payment', Status: 'Closed' },
      { ReferenceNbr: 'CV-DONE', Type: 'Payment', Status: 'Voided' },
      { ReferenceNbr: 'CV-LIVE', Type: 'Payment', Status: 'Closed' },
    ])
    expect([...refs].sort()).toEqual(['CV-DONE', 'CV-PEND'])
  })

  it('never releases a cheque whose payment carries a void in the live feed', async () => {
    const pending = await acumaticaCheck('VOIDED', 'Closed')
    const plain = await acumaticaCheck('CANCELLED', 'Closed')
    const rows = await findClosedButDeadHere(testDb, new Set([pending.acumaticaPaymentId!]))
    expect(rows.map((r) => r.id)).toEqual([plain.id])
  })

  it('re-points a cheque holding the voided payment to the live one staged on its number, status untouched', async () => {
    const held = await acumaticaCheck('CANCELLED', 'Voided', { checkNumber: '1791361448' })
    const staged = await testDb.stagedCheck.create({
      data: {
        source: 'ACUMATICA', reason: 'SHARED_NUMBER', acumaticaRef: 'CV-LIVE-1', acumaticaTenant: 'GOLIVE',
        checkNumber: '1791361448', impliedStatus: 'SIGNATURE_PENDING', apvNumbers: [], poNumbers: [], conflictingCompanies: [],
      },
    })
    const voided = new Set([held.acumaticaPaymentId!])
    const found = await findSwappedSharedNumbers(testDb, voided)
    expect(found).toEqual([{ checkId: held.id, checkNumber: '1791361448', heldRef: held.acumaticaPaymentId, liveRef: 'CV-LIVE-1', stagedId: staged.id }])

    expect(await repointToLivePayments(testDb, found)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: held.id } })
    expect(after).toMatchObject({ acumaticaPaymentId: 'CV-LIVE-1', status: 'CANCELLED' })
    expect((await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })).promotedCheckId).toBe(held.id)
    expect(await testDb.auditLog.count({ where: { checkId: held.id, action: REPOINTED_ACTION } })).toBe(1)
    expect(await findSwappedSharedNumbers(testDb, voided)).toEqual([])
    expect(await repointToLivePayments(testDb, found)).toBe(0)
  })

  it('leaves a shared number alone when the held payment is the live one', async () => {
    const held = await acumaticaCheck('RELEASED' as 'SIGNED', 'Closed', { checkNumber: '6000338856' })
    await testDb.stagedCheck.create({
      data: {
        source: 'ACUMATICA', reason: 'SHARED_NUMBER', acumaticaRef: 'CV-OTHER', acumaticaTenant: 'GOLIVE',
        checkNumber: held.checkNumber, impliedStatus: 'SIGNATURE_PENDING', apvNumbers: [], poNumbers: [], conflictingCompanies: [],
      },
    })
    expect(await findSwappedSharedNumbers(testDb, new Set())).toEqual([])
  })
})
