import { describe, it, expect } from 'vitest'
import {
  F_PARAMS, FILTER_MESSAGES, COLUMN_FILTER_PARAMS, parseAmountBound, parseColumnFilters,
  describeColumnFilters, columnParamsOf, describeRefusal, activeFilterColumns,
} from '@/lib/column-filters'
import { SORT_KEYS } from '@/lib/list-sort'

const read = (o: Record<string, string>) => (name: string) => o[name]

describe('parseAmountBound', () => {
  it('keeps a decimal string, commas and spaces stripped', () => {
    expect(parseAmountBound('1250.50')).toBe('1250.50')
    expect(parseAmountBound('1,250.5')).toBe('1250.5')
    expect(parseAmountBound(' 12 000 ')).toBe('12000')
  })
  it('refuses anything else', () => {
    for (const bad of ['12x', '-5', '1.234', '1e5', '₱100', '.5', '']) expect(parseAmountBound(bad), bad).toBeNull()
  })
})

describe('parseColumnFilters', () => {
  it('reads each box into its filter, trimmed', () => {
    const r = parseColumnFilters(read({
      'f.checkNumber': ' 600 ', 'f.apv': 'st04', 'f.po': 'PO-1', 'f.payee': 'henkel',
      'f.checkDateFrom': '2026-09-01', 'f.checkDateTo': '2026-09-30',
      'f.availablePickupDateFrom': '2026-09-02', 'f.scheduledPickupDateTo': '2026-09-03',
      'f.amountMin': '1,000', 'f.amountMax': '5000.50',
    }), { statusApplies: false })
    expect(r.errors).toEqual({})
    expect(r.filters).toEqual({
      checkNumberContains: '600', apvContains: 'st04', poContains: 'PO-1', payeeContains: 'henkel',
      from: new Date('2026-08-31T16:00:00.000Z'), to: new Date('2026-09-30T15:59:59.999Z'),
      availableFrom: new Date('2026-09-01T16:00:00.000Z'), pickupTo: new Date('2026-09-03T15:59:59.999Z'),
      amountMin: '1000', amountMax: '5000.50',
    })
    expect(r.values['f.checkNumber']).toBe('600')
    expect(r.values['f.amountMin']).toBe('1,000')
  })

  it('treats an empty box as no filter', () => {
    const r = parseColumnFilters(read({ 'f.payee': '   ', 'f.amountMin': '' }), { statusApplies: false })
    expect(r).toEqual({ filters: {}, status: undefined, values: {}, errors: {} })
  })

  it('refuses a value it cannot read, keeping it to render back', () => {
    const r = parseColumnFilters(read({ 'f.amountMax': '12x', 'f.checkDateFrom': '2026-02-30' }), { statusApplies: false })
    expect(r.errors).toEqual({ 'f.amountMax': FILTER_MESSAGES.amount, 'f.checkDateFrom': FILTER_MESSAGES.day })
    expect(r.values).toEqual({ 'f.amountMax': '12x', 'f.checkDateFrom': '2026-02-30' })
    expect(r.filters).toEqual({})
  })

  it('reads STATUS only where it applies, and refuses an unknown one there', () => {
    expect(parseColumnFilters(read({ 'f.status': 'SIGNED' }), { statusApplies: true }).status).toBe('SIGNED')
    const off = parseColumnFilters(read({ 'f.status': 'SIGNED' }), { statusApplies: false })
    expect(off).toEqual({ filters: {}, status: undefined, values: {}, errors: {} })
    expect(parseColumnFilters(read({ 'f.status': 'PAID' }), { statusApplies: true }).errors)
      .toEqual({ 'f.status': FILTER_MESSAGES.status })
  })
})

describe('the parameter map', () => {
  it('gives every sortable column its filter parameters, and names every f.* once', () => {
    expect(Object.keys(COLUMN_FILTER_PARAMS).sort()).toEqual([...SORT_KEYS].sort())
    const named = Object.values(COLUMN_FILTER_PARAMS).flat().filter((p) => p.startsWith('f.'))
    expect([...named].sort()).toEqual([...F_PARAMS].sort())
  })
})

describe('describeColumnFilters', () => {
  it('says each filter in words, in column order', () => {
    expect(describeColumnFilters({
      'f.payee': 'henkel', 'f.checkNumber': '600', 'f.status': 'READY_FOR_RELEASE',
      'f.amountMin': '1000', 'f.checkDateTo': '2026-09-30',
    })).toEqual([
      'CHECK NO. CONTAINS "600"', 'SUPPLIER CONTAINS "henkel"', 'CHECK DATE: TO 2026-09-30',
      'AMOUNT: FROM 1000', 'STATUS: READY FOR RELEASE',
    ])
  })
})

describe('columnParamsOf and describeRefusal', () => {
  it('picks the f.* parameters out of a base', () => {
    expect(columnParamsOf({ q: 'x', company: 'c1', 'f.payee': 'h', 'f.amountMin': '12x' }))
      .toEqual({ 'f.payee': 'h', 'f.amountMin': '12x' })
  })
  it('states every refused box', () => {
    expect(describeRefusal({ 'f.amountMin': FILTER_MESSAGES.amount }))
      .toBe(`A FILTER COULD NOT BE READ, SO NOTHING WAS LISTED.\nAMOUNT (MIN): ${FILTER_MESSAGES.amount}`)
  })
})

describe('activeFilterColumns', () => {
  it('names each column with a box in force, in column order', () => {
    expect(activeFilterColumns({ 'f.payee': 'x', company: 'c1', releasedTo: '2026-09-01', 'f.amountMin': '1' }))
      .toEqual(['payeeName', 'companyCode', 'amount', 'releasedAt'])
  })
  it('ignores the search, the eligibility and an empty value', () => {
    expect(activeFilterColumns({ q: 'x', eligibility: 'SUPPLIER', 'f.apv': '' })).toEqual([])
  })
})
