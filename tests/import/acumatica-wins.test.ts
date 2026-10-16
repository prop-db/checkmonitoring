import { describe, it, expect } from 'vitest'
import { refusedRegisterValues, type HeldValues } from '@/lib/import/acumatica-wins'

const held: HeldValues = {
  amount: '197715.42',
  checkDate: new Date('2026-01-19T00:00:00Z'),
  payeeName: 'HENKEL PHILIPPINES INC.',
  currency: 'PHP',
  cvNumber: 'CV-ST-004112',
  isCheque: true,
  companyCode: 'STK',
  cashAccountCode: 'BPI STK',
  checkBookCode: 'BPI-STK-4636',
}

describe('refusedRegisterValues', () => {
  it('is empty when the register agrees', () => {
    expect(refusedRegisterValues(held, { ...held })).toEqual({})
  })

  it('a value the register does not state is not a disagreement', () => {
    expect(refusedRegisterValues(held, {
      ...held, amount: null, checkDate: null, payeeName: null, currency: null, cvNumber: null,
      companyCode: null, cashAccountCode: null, checkBookCode: null,
    })).toEqual({})
  })

  it('records each differing value, kept and offered, as strings', () => {
    expect(refusedRegisterValues(held, {
      ...held, amount: '27037.94', checkDate: new Date('2026-02-01T00:00:00Z'), payeeName: 'SOMEONE ELSE',
      currency: 'USD', cvNumber: 'CV-ST-999999', isCheque: false,
      companyCode: 'A1', cashAccountCode: 'MBTC A1+', checkBookCode: 'MBT-A-4155',
    })).toEqual({
      amount: { kept: '197715.42', offered: '27037.94' },
      checkDate: { kept: '2026-01-19', offered: '2026-02-01' },
      payeeName: { kept: 'HENKEL PHILIPPINES INC.', offered: 'SOMEONE ELSE' },
      currency: { kept: 'PHP', offered: 'USD' },
      cvNumber: { kept: 'CV-ST-004112', offered: 'CV-ST-999999' },
      isCheque: { kept: 'true', offered: 'false' },
      companyId: { kept: 'STK', offered: 'A1' },
      cashAccountId: { kept: 'BPI STK', offered: 'MBTC A1+' },
      checkBookId: { kept: 'BPI-STK-4636', offered: 'MBT-A-4155' },
    })
  })

  it('compares amounts as decimals and dates by day', () => {
    expect(refusedRegisterValues(
      { ...held, amount: '100.5' },
      { ...held, amount: '100.50', checkDate: new Date('2026-01-19T15:00:00Z') },
    )).toEqual({})
  })

  it('an offered value where nothing is stored is a disagreement, kept null', () => {
    expect(refusedRegisterValues({ ...held, amount: null, checkBookCode: null }, held)).toEqual({
      amount: { kept: null, offered: '197715.42' },
      checkBookId: { kept: null, offered: 'BPI-STK-4636' },
    })
  })
})
