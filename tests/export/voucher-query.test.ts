import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listVoucherCandidates } from '@/lib/export/voucher-query'

beforeEach(async () => {
  await resetDb()
})

describe('listVoucherCandidates', () => {
  it('returns one candidate per (voucher, cheque) pair', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652', 'AP-ST042653'], checkNumber: '6000353106' })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks.map((c) => c.voucher).sort()).toEqual(['AP-ST042652', 'AP-ST042653'])
    expect(checks[0].checkNumber).toBe('6000353106')
  })

  it('ignores a cheque carrying no voucher', async () => {
    await makeCheck({ apvNumbers: [] })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks).toHaveLength(0)
  })

  /**
   * Client ruling, 2026-09-06. Measured cost: 17 vouchers out of ~10,985 — the
   * other 58 that sit on an incomplete cheque are also carried by a complete
   * one, so they still get a row.
   */
  it('excludes a cheque with no recorded amount', async () => {
    await makeCheck({ apvNumbers: ['AP-ST099999'], amount: null })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks).toHaveLength(0)
  })

  it('reads the bank from the cash account', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks[0].bank).not.toBeNull()
  })

  it('prefers the checkbook bank over the cash account bank', async () => {
    const check = await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const bank = await testDb.bank.create({ data: { code: 'MBTC-X', name: 'Metrobank' } })
    const book = await testDb.checkBook.create({
      data: { code: 'MBTC-S-0001', bankId: bank.id, companyId: check.companyId },
    })
    await testDb.check.update({ where: { id: check.id }, data: { checkBookId: book.id } })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks[0].bank).toBe('MBTC-X')
  })

  it('returns the cheque id alongside its number', async () => {
    const check = await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks[0].checkId).toBe(check.id)
  })

  it('returns staged rows that name a voucher', async () => {
    await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI STK', sourceRow: 412,
        reason: 'NO_COMPANY', checkNumber: '6000353110',
        apvNumbers: ['AP-A1-02663'], impliedStatus: 'SIGNED',
      },
    })
    const { staged } = await listVoucherCandidates(testDb)
    expect(staged).toHaveLength(1)
    expect(staged[0].voucher).toBe('AP-A1-02663')
    expect(staged[0].sourceSheet).toBe('BPI STK')
    expect(staged[0].sourceRow).toBe(412)
  })
})
