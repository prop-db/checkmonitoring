import { describe, it, expect } from 'vitest'
import {
  checkPlannedOutflowInput, normalisePlannedOutflow, diffPlannedOutflow, MONEY,
  type PlannedOutflowInput,
} from '@/lib/domain/planned-outflow'

const good: PlannedOutflowInput = {
  date: '2026-09-15', amount: '1250000.00', bankId: 'b1', companyId: 'c1',
  description: ' September 2nd-half payroll ', category: 'payroll',
}

describe('checkPlannedOutflowInput', () => {
  it('accepts a complete line', () => {
    expect(checkPlannedOutflowInput(good)).toEqual({ ok: true })
  })

  it('refuses a date that is not a day', () => {
    expect(checkPlannedOutflowInput({ ...good, date: '15/09/2026' })).toMatchObject({ ok: false, code: 'INVALID_DATE' })
    expect(checkPlannedOutflowInput({ ...good, date: '' })).toMatchObject({ ok: false, code: 'INVALID_DATE' })
  })

  it('refuses an amount that is not money, or is nothing', () => {
    for (const amount of ['', '1,250,000', '12.345', '-5', 'abc', '0', '0.00']) {
      expect(checkPlannedOutflowInput({ ...good, amount }), amount).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' })
    }
    expect(MONEY.test('0.01')).toBe(true)
  })

  it('refuses a blank description, bank or company', () => {
    expect(checkPlannedOutflowInput({ ...good, description: '  ' })).toMatchObject({ ok: false, code: 'DESCRIPTION_REQUIRED' })
    expect(checkPlannedOutflowInput({ ...good, bankId: '' })).toMatchObject({ ok: false, code: 'BANK_REQUIRED' })
    expect(checkPlannedOutflowInput({ ...good, companyId: '' })).toMatchObject({ ok: false, code: 'COMPANY_REQUIRED' })
  })

  it('refuses a category that is not on the list', () => {
    expect(checkPlannedOutflowInput({ ...good, category: 'RENT' })).toMatchObject({ ok: false, code: 'UNKNOWN_CATEGORY' })
    expect(checkPlannedOutflowInput({ ...good, category: 'RENT' }, { categories: ['RENT'] })).toEqual({ ok: true })
    expect(checkPlannedOutflowInput({ ...good, category: '' })).toEqual({ ok: true })
  })
})

describe('normalisePlannedOutflow', () => {
  it('trims, pads the amount to two decimals, upper-cases category and currency, defaults PHP', () => {
    expect(normalisePlannedOutflow({ ...good, amount: '5' })).toEqual({
      date: '2026-09-15', amount: '5.00', currency: 'PHP', bankId: 'b1', companyId: 'c1',
      description: 'September 2nd-half payroll', category: 'PAYROLL',
    })
    expect(normalisePlannedOutflow({ ...good, amount: '5.5', currency: 'usd', category: '' }).amount).toBe('5.50')
    expect(normalisePlannedOutflow({ ...good, currency: 'usd', category: '' }).currency).toBe('USD')
    expect(normalisePlannedOutflow({ ...good, category: '' }).category).toBeNull()
  })
})

describe('diffPlannedOutflow', () => {
  it('reports only what changed', () => {
    const a = normalisePlannedOutflow(good)
    expect(diffPlannedOutflow(a, { ...a, amount: '1300000.00', category: null })).toEqual({
      amount: { from: '1250000.00', to: '1300000.00' },
      category: { from: 'PAYROLL', to: null },
    })
    expect(diffPlannedOutflow(a, { ...a })).toEqual({})
  })
})
