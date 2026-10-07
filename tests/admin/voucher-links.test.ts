import { describe, it, expect } from 'vitest'
import { judgeLink, type AppCheque } from '@/lib/admin/voucher-links'

const chq = (o: Partial<AppCheque> & { checkNumber: string }): AppCheque => ({
  id: o.checkNumber, status: 'SIGNED', acumaticaStatus: 'Balanced', isCheque: true, ...o,
})
const held = (...cs: AppCheque[]) => {
  const m = new Map<string, AppCheque[]>()
  for (const c of cs) m.set(c.checkNumber, [...(m.get(c.checkNumber) ?? []), c])
  return m
}

describe('judgeLink', () => {
  it('links the one live check, reading a bank-prefixed payment reference', () => {
    const v = judgeLink([{ payType: 'CHK', paymentRef: 'BPI 6000400001' }], held(chq({ checkNumber: '6000400001' })))
    expect(v).toMatchObject({ kind: 'LINK', check: { checkNumber: '6000400001' } })
  })

  it('ignores a voided predecessor, a void-check row and a debit adjustment', () => {
    const v = judgeLink(
      [
        { payType: 'CHK', paymentRef: '6000400001' },
        { payType: 'VCK', paymentRef: '6000400001' },
        { payType: 'ADR', paymentRef: null },
        { payType: 'CHK', paymentRef: '6000400002' },
      ],
      held(chq({ checkNumber: '6000400001', status: 'VOIDED', acumaticaStatus: 'Voided' }), chq({ checkNumber: '6000400002' })),
    )
    expect(v).toMatchObject({ kind: 'LINK', check: { checkNumber: '6000400002' } })
  })

  it('refuses two live checks, a number held twice, and a check Acumatica voided', () => {
    expect(judgeLink(
      [{ payType: 'CHK', paymentRef: '1' }, { payType: 'CHK', paymentRef: '2' }],
      held(chq({ checkNumber: '1' }), chq({ checkNumber: '2' })),
    ).kind).toBe('AMBIGUOUS')
    expect(judgeLink([{ payType: 'CHK', paymentRef: '1' }], held(chq({ checkNumber: '1', id: 'a' }), chq({ checkNumber: '1', id: 'b' }))).kind).toBe('AMBIGUOUS')
    expect(judgeLink([{ payType: 'CHK', paymentRef: '1' }], held(chq({ checkNumber: '1', acumaticaStatus: 'Voided' }))).kind).toBe('NO_LIVE_CHEQUE_HERE')
  })

  it('reports a voucher with no application, or whose check this system does not hold', () => {
    expect(judgeLink([], held()).kind).toBe('NO_APPLICATION')
    expect(judgeLink([{ payType: 'CHK', paymentRef: '9' }], held()).kind).toBe('NO_LIVE_CHEQUE_HERE')
  })
})
