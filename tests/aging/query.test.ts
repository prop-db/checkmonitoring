import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { loadAgingRows } from '@/lib/aging/query'

const NOW = new Date('2026-10-15T10:00:00+08:00')
const day = (d: string) => new Date(`${d}T00:00:00Z`)

beforeEach(resetDb)

describe('loadAgingRows', () => {
  it('is SIGNED real checks with an amount, nothing else', async () => {
    const keep = await makeCheck({ status: 'SIGNED', checkNumber: '6000000001' })
    await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000000002' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000000003' })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000004', isCheque: false })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000005', amount: null })
    const { rows, truncated } = await loadAgingRows(testDb, NOW)
    expect(rows.map((r) => r.id)).toEqual([keep.id])
    expect(truncated).toBe(false)
  })

  it('ages a check by the earliest Acumatica due date of its APVs', async () => {
    const c = await makeCheck({ checkNumber: '6000000010', apvNumbers: ['AP-ST000001', 'AP-ST000002'] })
    await testDb.acumaticaBillTerms.createMany({ data: [
      { apvNumber: 'AP-ST000001', tenant: 'GOLIVE', dueDate: day('2026-09-30'), termsCode: '30D' },
      { apvNumber: 'AP-ST000002', tenant: 'GOLIVE', dueDate: day('2026-07-01'), termsCode: '30D' },
    ] })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    expect(row.id).toBe(c.id)
    expect(row.dueDate).toBe('2026-07-01')
    expect(row.daysPastDue).toBe(106)
    expect(row.bucket).toBe('b90plus')
    expect(row.amount).toBe('197715.42')
  })

  it('falls back to the CheckBill due date only for an APV Acumatica gives no date', async () => {
    const c = await makeCheck({ checkNumber: '6000000020', apvNumbers: ['AP-ST000003'] })
    await testDb.checkBill.create({ data: {
      checkId: c.id, apvNumber: 'AP-ST000003', amount: '100.00', dueDate: day('2026-10-10'), termsCode: '30D',
    } })
    await testDb.acumaticaBillTerms.create({ data: { apvNumber: 'AP-ST000003', tenant: 'GOLIVE' } })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    expect(row.dueDate).toBe('2026-10-10')
    expect(row.bucket).toBe('b30')
  })

  it('prefers Acumatica over CheckBill when both state a date', async () => {
    const c = await makeCheck({ checkNumber: '6000000030', apvNumbers: ['AP-ST000004'] })
    await testDb.checkBill.create({ data: {
      checkId: c.id, apvNumber: 'AP-ST000004', amount: '100.00', dueDate: day('2026-01-01'),
    } })
    await testDb.acumaticaBillTerms.create({ data: {
      apvNumber: 'AP-ST000004', tenant: 'GOLIVE', dueDate: day('2026-10-20'), termsCode: '30D',
    } })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    expect(row.bucket).toBe('current')
    expect(row.daysPastDue).toBe(-5)
  })

  it('keeps Acumatica\'s never-aging terms when it states no date, even beside a CheckBill date', async () => {
    const c = await makeCheck({ checkNumber: '6000000050', apvNumbers: ['AP-ST000005'] })
    await testDb.checkBill.create({ data: {
      checkId: c.id, apvNumber: 'AP-ST000005', amount: '100.00', dueDate: day('2026-01-01'), termsCode: '30D',
    } })
    await testDb.acumaticaBillTerms.create({ data: { apvNumber: 'AP-ST000005', tenant: 'GOLIVE', termsCode: 'COD' } })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    // Acumatica says COD (never ages) and gives no date; the workbook's date is used,
    // but Acumatica's terms win, so the bill never ages: CURRENT, no due date.
    expect(row.bucket).toBe('current')
    expect(row.dueDate).toBeNull()
  })

  it('a check with no APV, or no known date, is NO DUE DATE', async () => {
    await makeCheck({ checkNumber: '6000000040' })
    await makeCheck({ checkNumber: '6000000041', apvNumbers: ['AP-ST000099'] })
    const { rows } = await loadAgingRows(testDb, NOW)
    expect(rows.map((r) => [r.checkNumber, r.bucket, r.dueDate])).toEqual([
      ['6000000040', 'noDue', null],
      ['6000000041', 'noDue', null],
    ])
  })
})
