import { describe, it, expect } from 'vitest'
import {
  resolveVoucherRows, describeVoucherScope, VOUCHER_HEADERS,
  CONTESTED, ALL_CANCELLED, NOT_KEYED,
  type CheckCandidate, type StagedCandidate,
} from '@/lib/export/voucher-index'

/**
 * The resolver decides which cheque answers a voucher. Every case here was
 * measured against production on 2026-09-10 over the Executive Report's
 * `AP Local` sheet — see the spec. No database: candidates in, rows out.
 */
function candidate(overrides: Partial<CheckCandidate> & { voucher: string }): CheckCandidate {
  return {
    checkId: 'chk_0001',
    checkNumber: '6000353106',
    status: 'SIGNED',
    bank: 'BPI',
    company: 'STK',
    checkDate: new Date('2026-08-13'),
    payee: 'HENKEL PHILIPPINES INC.',
    releasedAt: null,
    ...overrides,
  }
}

function stagedCandidate(overrides: Partial<StagedCandidate> & { voucher: string }): StagedCandidate {
  return {
    sourceSheet: 'BPI STK',
    sourceRow: 412,
    statedCheckRef: null,
    checkNumber: '6000353110',
    acumaticaRef: null,
    ...overrides,
  }
}

describe('resolveVoucherRows — one row per voucher', () => {
  it('answers a voucher naming a single live cheque', () => {
    const [row] = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-ST042652' })],
      staged: [],
    })
    expect(row.voucher).toBe('AP-ST042652')
    expect(row.checkNumber).toBe('6000353106')
    expect(row.status).toBe('SIGNED')
    expect(row.bank).toBe('BPI')
    expect(row.supersedes).toBeNull()
    expect(row.remarks).toBeNull()
  })

  it('names the live cheque and lists its dead predecessors — 46 measured re-issues', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-A1033692', checkNumber: '6000300001', status: 'VOIDED' }),
        candidate({ voucher: 'AP-A1033692', checkNumber: '6000300002', status: 'READY_FOR_RELEASE' }),
      ],
      staged: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000300002')
    expect(rows[0].status).toBe('READY FOR RELEASE')
    expect(rows[0].supersedes).toBe('6000300001 (VOIDED)')
  })

  it('refuses to pick when two LIVE cheques name the voucher — 6 measured', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST036567', checkNumber: '6000300003', status: 'SIGNED' }),
        candidate({ voucher: 'AP-ST036567', checkNumber: '6000300004', status: 'READY_FOR_RELEASE' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(CONTESTED)
    expect(rows[0].remarks).toContain('6000300003')
    expect(rows[0].remarks).toContain('6000300004')
  })

  it('answers a voucher whose same cheque arrives twice, rather than reporting CONTESTED', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-DUP000001', checkNumber: '6000300007', company: 'STK', status: 'SIGNED' }),
        candidate({ voucher: 'AP-DUP000001', checkNumber: '6000300007', company: 'STK', status: 'SIGNED' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBe('6000300007')
    expect(rows[0].status).toBe('SIGNED')
  })

  it('still reports CONTESTED for the same check number issued by two different companies', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-DUP000002', checkNumber: '6000300008', company: 'STK', status: 'SIGNED' }),
        candidate({ voucher: 'AP-DUP000002', checkNumber: '6000300008', company: 'A1+', status: 'SIGNED' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(CONTESTED)
    // The shared cheque number alone does not tell a human which two cheques to
    // go reconcile — @@unique([companyId, checkNumber]) means both candidates
    // are legitimately "6000300008". The remarks must name the company on each.
    expect(rows[0].remarks).toContain('6000300008 · STK (SIGNED)')
    expect(rows[0].remarks).toContain('6000300008 · A1+ (SIGNED)')
  })

  it('still answers when the only cheque was cancelled — 35 measured', () => {
    const rows = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-HF000123', status: 'CANCELLED' })],
      staged: [],
    })
    expect(rows[0].checkNumber).toBe('6000353106')
    expect(rows[0].status).toBe('CANCELLED')
  })

  it('blanks the number when EVERY cheque naming the voucher is dead — 2 measured', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST042976', checkNumber: '6000300005', status: 'VOIDED' }),
        candidate({ voucher: 'AP-ST042976', checkNumber: '6000300006', status: 'CANCELLED' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(ALL_CANCELLED)
    expect(rows[0].remarks).toContain('6000300005')
  })

  it('reports a staged voucher without giving a cheque number — 51 measured', () => {
    const rows = resolveVoucherRows({
      checks: [],
      staged: [stagedCandidate({ voucher: 'AP-A1-02663' })],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(NOT_KEYED)
    expect(rows[0].remarks).toContain('/admin/staged')
    expect(rows[0].remarks).toContain('BPI STK row 412')
  })

  it('prefers the cheque over a staged row naming the same voucher', () => {
    const rows = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-ST042652' })],
      staged: [stagedCandidate({ voucher: 'AP-ST042652' })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000353106')
  })

  it('sorts by voucher, so two runs produce the same file', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST000002' }),
        candidate({ voucher: 'AP-A1000001' }),
      ],
      staged: [],
    })
    expect(rows.map((r) => r.voucher)).toEqual(['AP-A1000001', 'AP-ST000002'])
  })

  it('carries the cheque id so a screen can link the number', () => {
    const [row] = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-ST042652', checkId: 'chk_link' })],
      staged: [],
    })
    expect(row.checkId).toBe('chk_link')
  })

  it('has no cheque id when it has no cheque number', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST036567', checkId: 'chk_a', checkNumber: '6000300003', status: 'SIGNED' }),
        candidate({ voucher: 'AP-ST036567', checkId: 'chk_b', checkNumber: '6000300004', status: 'SIGNED' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].checkId).toBeNull()
  })
})

describe('the sheet is shaped for VLOOKUP', () => {
  it('puts VOUCHER in the first column', () => {
    expect(VOUCHER_HEADERS[0]).toBe('VOUCHER')
  })

  it('carries no amount column', () => {
    expect(VOUCHER_HEADERS.some((h) => h.includes('AMOUNT'))).toBe(false)
  })
})

describe('describeVoucherScope', () => {
  it('says so when the cap bites', () => {
    expect(describeVoucherScope(15_000, 20_100)).toBe('FIRST 15,000 OF 20,100 VOUCHERS')
  })

  it('states the count when it does not', () => {
    expect(describeVoucherScope(10_985, 10_985)).toBe('10,985 VOUCHERS')
  })

  it('does not leave an empty file silent', () => {
    expect(describeVoucherScope(0, 0)).toBe('NO VOUCHERS')
  })
})
