import { describe, it, expect, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { mergeDuplicateCheques, MERGE_RULING_BASIS } from '@/lib/admin/merge-duplicates'

const NOW = new Date('2026-09-06T10:00:00+08:00')

beforeEach(resetDb)

async function companies() {
  const stk = await testDb.company.create({
    data: { code: 'STK', name: 'Starkson Packaging Inc.', legalNames: [] },
  })
  const a1 = await testDb.company.create({
    data: { code: 'A1+', name: 'A1+ Multinational Packaging Inc.', legalNames: [] },
  })
  return { stk, a1 }
}

/** The register half: it carries the sheet, the status and the history. */
function registerRow(
  companyId: string,
  overrides: Partial<Prisma.CheckUncheckedCreateInput> = {},
) {
  return testDb.check.create({
    data: {
      companyId,
      checkNumber: '6000308848',
      amount: '197715.42',
      payeeName: 'HENKEL PHILIPPINES INC.',
      eligibility: 'SUPPLIER',
      status: 'RELEASED',
      releasedAt: new Date('2026-02-06T04:00:00Z'),
      sourceSheet: 'BPI RELEASED',
      sourceRow: 412,
      ...overrides,
    },
  })
}

/** The Acumatica half: no sheet, no row, and the branch that named its company. */
function acumaticaRow(
  companyId: string,
  overrides: Partial<Prisma.CheckUncheckedCreateInput> = {},
) {
  return testDb.check.create({
    data: {
      companyId,
      checkNumber: '6000308848',
      amount: '197715.42',
      payeeName: 'HENKEL PHILIPPINES INC.',
      eligibility: 'SUPPLIER',
      status: 'SIGNATURE_PENDING',
      sourceSheet: null,
      sourceRow: null,
      acumaticaPaymentId: 'CV-A1-004112',
      acumaticaBranch: 'A1+',
      acumaticaTenant: 'GOLIVE',
      acumaticaDocType: 'Payment',
      acumaticaStatus: 'Closed',
      ...overrides,
    },
  })
}

const merge = (dryRun = false) => mergeDuplicateCheques(testDb, { dryRun, now: NOW })

describe('mergeDuplicateCheques', () => {
  it('keeps the register row, moves it to Acumatica\'s company and deletes the duplicate', async () => {
    const { stk, a1 } = await companies()
    const survivor = await registerRow(stk.id)
    await acumaticaRow(a1.id)

    const summary = await merge()

    expect(summary.merged).toBe(1)
    expect(summary.refused).toEqual([])
    expect(summary.duplicateNumbersAfter).toBe(0)

    expect(await testDb.check.count()).toBe(1)
    const kept = await testDb.check.findUniqueOrThrow({ where: { id: survivor.id } })
    // The ruling: Acumatica's branch decides who owns the cheque.
    expect(kept.companyId).toBe(a1.id)
    // ...and nothing else the register established moved with it.
    expect(kept.status).toBe('RELEASED')
    expect(kept.releasedAt).toEqual(new Date('2026-02-06T04:00:00Z'))
    expect(kept.sourceSheet).toBe('BPI RELEASED')
    expect(kept.sourceRow).toBe(412)
    expect(kept.amount?.toString()).toBe('197715.42')
  })

  it('carries the absorbed row\'s Acumatica identity onto the survivor', async () => {
    const { stk, a1 } = await companies()
    const survivor = await registerRow(stk.id)
    await acumaticaRow(a1.id)

    await merge()

    const kept = await testDb.check.findUniqueOrThrow({ where: { id: survivor.id } })
    // Otherwise the ERP link dies with the deleted row: the sync's watermark
    // means an unchanged payment is never read again.
    expect(kept.acumaticaPaymentId).toBe('CV-A1-004112')
    expect(kept.acumaticaBranch).toBe('A1+')
    expect(kept.acumaticaTenant).toBe('GOLIVE')
  })

  it('writes the merge audit on the survivor, naming what it absorbed', async () => {
    const { stk, a1 } = await companies()
    const survivor = await registerRow(stk.id)
    const absorbed = await acumaticaRow(a1.id)

    await merge()

    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { action: 'duplicate_check_merged', checkId: survivor.id },
    })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
    expect(audit.details).toMatchObject({
      checkNumber: '6000308848',
      previousCompanyCode: 'STK',
      companyCode: 'A1+',
      absorbedCheckId: absorbed.id,
      absorbedAcumaticaPaymentId: 'CV-A1-004112',
      basis: MERGE_RULING_BASIS,
    })
  })

  it('detaches the absorbed row\'s audit history rather than destroying it', async () => {
    const { stk, a1 } = await companies()
    await registerRow(stk.id)
    const absorbed = await acumaticaRow(a1.id)
    await testDb.auditLog.create({
      data: {
        checkId: absorbed.id, actorType: 'SYSTEM', action: 'imported',
        remarks: 'Imported from ACUMATICA at SIGNATURE_PENDING.',
      },
    })

    await merge()

    const detached = await testDb.auditLog.findFirstOrThrow({ where: { action: 'imported' } })
    expect(detached.checkId).toBeNull()
    expect(detached.remarks).toBe('Imported from ACUMATICA at SIGNATURE_PENDING.')
  })

  // `StagedCheck.promotedCheckId` is a plain column with no foreign key, so
  // nothing in the database would catch this: the pointer would simply dangle
  // and the staged queue would go on reporting the row as promoted into a
  // cheque that no longer exists. It is repointed rather than refused because a
  // merge is not a deletion — the cheque still exists, as the survivor, and it
  // is the same physical cheque the staged row was promoted into.
  it('repoints a staged row promoted into the duplicate onto the survivor', async () => {
    const { stk, a1 } = await companies()
    const survivor = await registerRow(stk.id)
    const absorbed = await acumaticaRow(a1.id)
    const staged = await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI RELEASED', sourceRow: 999,
        reason: 'NO_COMPANY', impliedStatus: 'RELEASED',
        checkNumber: '6000308848', promotedCheckId: absorbed.id,
      },
    })

    const summary = await merge()
    expect(summary.merged).toBe(1)
    expect(summary.refused).toEqual([])

    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).toBe(survivor.id)
    // The staging record is the evidence of why the cheque was held. Repointing
    // it never deletes it, and never changes why it was staged.
    expect(after.reason).toBe('NO_COMPANY')

    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { action: 'duplicate_check_merged' },
    })
    expect(audit.details).toMatchObject({ repointedStagedRows: 1 })
  })

  it('a dry run reports the same numbers and writes nothing', async () => {
    const { stk, a1 } = await companies()
    const survivor = await registerRow(stk.id)
    await acumaticaRow(a1.id)

    const dry = await merge(true)
    expect(dry.merged).toBe(1)
    expect(dry.duplicateNumbersBefore).toBe(1)
    expect(dry.duplicateNumbersAfter).toBe(0)

    expect(await testDb.check.count()).toBe(2)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: survivor.id } })).companyId)
      .toBe(stk.id)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('refuses a duplicate the supplier portal outbox holds an event for', async () => {
    const { stk, a1 } = await companies()
    await registerRow(stk.id)
    const absorbed = await acumaticaRow(a1.id)
    await testDb.portalEvent.create({
      data: {
        checkId: absorbed.id, direction: 'OUT', kind: 'MARK_AVAILABLE', payload: {},
        idempotencyKey: `${absorbed.id}:MARK_AVAILABLE:probe`,
      },
    })

    const summary = await merge()
    expect(summary.merged).toBe(0)
    expect(summary.refused).toMatchObject([{ checkNumber: '6000308848', reason: 'PORTAL_EVENT' }])
    expect(await testDb.check.count()).toBe(2)
  })

  it('refuses a duplicate a Finance user has acted on — that is history, not import residue', async () => {
    const user = await makeUser()
    const { stk, a1 } = await companies()
    await registerRow(stk.id)
    await acumaticaRow(a1.id, {
      status: 'SIGNED', signedById: user.id, signedAt: new Date('2026-03-01T00:00:00Z'),
    })

    const summary = await merge()
    expect(summary.merged).toBe(0)
    expect(summary.refused).toMatchObject([{ checkNumber: '6000308848', reason: 'FINANCE_ACTION' }])
    expect(await testDb.check.count()).toBe(2)
  })

  it('refuses a number two register rows claim, rather than picking one', async () => {
    const { stk, a1 } = await companies()
    await registerRow(stk.id)
    await registerRow(a1.id, { sourceRow: 900 })

    const summary = await merge()
    expect(summary.merged).toBe(0)
    expect(summary.refused).toMatchObject([
      { checkNumber: '6000308848', reason: 'NOT_ONE_REGISTER_AND_ONE_ACUMATICA_ROW' },
    ])
    expect(await testDb.check.count()).toBe(2)
  })

  it('refuses when the survivor already carries a different Acumatica payment', async () => {
    const { stk, a1 } = await companies()
    await registerRow(stk.id, { acumaticaPaymentId: 'CV-ST-000001' })
    await acumaticaRow(a1.id)

    const summary = await merge()
    expect(summary.merged).toBe(0)
    expect(summary.refused).toMatchObject([
      { checkNumber: '6000308848', reason: 'TWO_ACUMATICA_PAYMENTS' },
    ])
  })

  it('leaves a cheque number only one row carries alone', async () => {
    const { stk, a1 } = await companies()
    await registerRow(stk.id)
    await acumaticaRow(a1.id, { checkNumber: '6000399999' })

    const summary = await merge()
    expect(summary.duplicateNumbersBefore).toBe(0)
    expect(summary.merged).toBe(0)
    expect(await testDb.check.count()).toBe(2)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('is idempotent: a second run finds nothing left to merge', async () => {
    const { stk, a1 } = await companies()
    await registerRow(stk.id)
    await acumaticaRow(a1.id)

    await merge()
    const second = await merge()
    expect(second).toMatchObject({ duplicateNumbersBefore: 0, merged: 0, duplicateNumbersAfter: 0 })
    expect(await testDb.check.count()).toBe(1)
  })
})
