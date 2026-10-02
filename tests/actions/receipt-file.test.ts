import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { markReadyForRelease, markReleased, recordReceipt, attachReceiptFile } from '@/lib/domain/actions'

// The receipt's amount and scanned file (user request 2026-10-01), and the
// RECEIPT outbox kind that carries a late receipt to the portal.

const NOW = new Date('2026-10-02T10:00:00+08:00')
const LATER = new Date('2026-10-02T11:00:00+08:00')
const PICKUP = new Date('2026-10-02')
const pdf = () => { const b = new Uint8Array(32); b.set([0x25, 0x50, 0x44, 0x46]); return b }
const file = () => ({ fileName: 'OR-1.pdf', contentType: 'application/pdf', bytes: pdf() })

beforeEach(resetDb)

async function released(eligibility: 'SUPPLIER' | 'INTERNAL' = 'SUPPLIER') {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', eligibility, apvNumbers: ['AP-1'] })
  await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
  await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
  return { user, check }
}
const receiptEvents = (checkId: string) => testDb.portalEvent.findMany({ where: { checkId, kind: 'RECEIPT' } })

describe('recordReceipt with amount and file', () => {
  it('stores amount + file and queues one RECEIPT', async () => {
    const { user, check } = await released()
    const out = await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptAmount: '1,000.50', receiptFile: file(), now: LATER })
    expect(out.receiptAmount?.toString()).toBe('1000.5')
    const f = await testDb.checkReceiptFile.findUnique({ where: { checkId: check.id } })
    expect(f?.sizeBytes).toBe(32)
    expect(f?.contentType).toBe('application/pdf')
    const ev = await receiptEvents(check.id)
    expect(ev).toHaveLength(1)
    expect(ev[0].idempotencyKey).toBe(`${check.id}:RECEIPT:${LATER.toISOString()}`)
    expect(ev[0].payload).toEqual({ action: 'RECEIPT', checkNumber: check.checkNumber, orNumber: 'OR-1', amount: '1000.50', hasFile: true })
    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'receipt_recorded' } })
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain('JVBER') // no base64 of "%PDF"
    expect(audit[0].details).toMatchObject({ amount: '1000.50', file: { fileName: 'OR-1.pdf', contentType: 'application/pdf', sizeBytes: 32 } })
  })
  it('a cheque with no APV stores the receipt but queues nothing (it could only park)', async () => {
    const { user, check } = await released()
    await testDb.check.update({ where: { id: check.id }, data: { apvNumbers: [] } })
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptFile: file(), now: LATER })
    expect(await receiptEvents(check.id)).toHaveLength(0)
    expect(await testDb.checkReceiptFile.findUnique({ where: { checkId: check.id } })).not.toBeNull()
  })
  it('an INTERNAL cheque stores the receipt but queues nothing', async () => {
    const { user, check } = await released('INTERNAL')
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptFile: file(), now: LATER })
    expect(await receiptEvents(check.id)).toHaveLength(0)
    expect(await testDb.checkReceiptFile.findUnique({ where: { checkId: check.id } })).not.toBeNull()
  })
  it('a bad file refuses the whole receipt', async () => {
    const { user, check } = await released()
    await expect(recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptFile: { ...file(), contentType: 'image/png' }, now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_FILE_TYPE' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).orNumber).toBeNull()
  })
})

describe('markReleased with a receipt', () => {
  it('queues RELEASED and RECEIPT', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-1'] })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-9', receiptType: 'OR', receiptAmount: '5', now: LATER })
    const kinds = (await testDb.portalEvent.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })).map(e => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['RELEASED', 'RECEIPT']))
    const row = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(row.receiptAmount?.toFixed(2)).toBe('5.00')
  })
  it('a release without a receipt queues no RECEIPT', async () => {
    const { check } = await released()
    expect(await receiptEvents(check.id)).toHaveLength(0)
  })
  it('refuses an amount or file with no receipt reference, before anything is written', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-1'] })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await expect(markReleased(testDb, { checkId: check.id, userId: user.id, receiptFile: file(), now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('READY_FOR_RELEASE')
  })
})

describe('attachReceiptFile', () => {
  it('adds a file and amount to a receipt recorded without them, then refuses a second', async () => {
    const { user, check } = await released()
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER })
    await attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptAmount: '10', receiptFile: file(), now: new Date(LATER.getTime() + 1000) })
    expect(await receiptEvents(check.id)).toHaveLength(2)
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptFile: file(), now: new Date(LATER.getTime() + 2000) }))
      .rejects.toMatchObject({ code: 'RECEIPT_FILE_ALREADY_ATTACHED' })
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptAmount: '11', now: new Date(LATER.getTime() + 3000) }))
      .rejects.toMatchObject({ code: 'RECEIPT_AMOUNT_ALREADY_RECORDED' })
  })
  it('refuses when no receipt reference is recorded, or nothing is given', async () => {
    const { user, check } = await released()
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptFile: file(), now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' })
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER })
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, now: new Date(LATER.getTime() + 1000) }))
      .rejects.toMatchObject({ code: 'RECEIPT_NOTHING_TO_ATTACH' })
  })
})
