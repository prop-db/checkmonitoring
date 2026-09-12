import { describe, it, expect } from 'vitest'
import {
  DETAIL_FIELDS, normaliseDetails, diffDetails, dayToDate, isoDay, isIsoDay, type DetailValues,
} from '@/lib/domain/details'
import { DomainError } from '@/lib/domain/errors'

const current: DetailValues = {
  remarks: 'old', pointPerson: null, checksPossession: 'ANA', category: 'PAYROLL', expectedOutflowDate: null,
}

describe('normaliseDetails', () => {
  it('trims, and stores an empty box as null', () => {
    expect(normaliseDetails({ remarks: '  note  ', pointPerson: '   ' }, current))
      .toEqual({ remarks: 'note', pointPerson: null, checksPossession: 'ANA', category: 'PAYROLL', expectedOutflowDate: null })
  })

  it('leaves a field the form did not send exactly as it is', () => {
    expect(normaliseDetails({}, current)).toEqual(current)
    expect(normaliseDetails({ remarks: undefined }, current)).toEqual(current)
  })

  it('folds the category to upper case, as the import does', () => {
    expect(normaliseDetails({ category: 'local supplier' }, current).category).toBe('LOCAL SUPPLIER')
  })

  it('names the four register fields and the expected outflow date, and no other', () => {
    expect([...DETAIL_FIELDS]).toEqual(['remarks', 'pointPerson', 'checksPossession', 'category', 'expectedOutflowDate'])
  })

  it('keeps the expected outflow date as an ISO day, and refuses anything that is not one', () => {
    expect(normaliseDetails({ expectedOutflowDate: ' 2026-09-20 ' }, current).expectedOutflowDate).toBe('2026-09-20')
    expect(normaliseDetails({ expectedOutflowDate: '' }, current).expectedOutflowDate).toBeNull()
    expect(() => normaliseDetails({ expectedOutflowDate: '20/09/2026' }, current)).toThrow(DomainError)
    expect(() => normaliseDetails({ expectedOutflowDate: '2026-02-30' }, current)).toThrow(DomainError)
  })

  it('keeps a category that has since left the list, as long as it is unchanged', () => {
    const withOld: DetailValues = { ...current, category: 'RENT' }
    expect(normaliseDetails({ category: 'RENT', remarks: 'note' }, withOld, { categories: ['PAYROLL'] }))
      .toMatchObject({ category: 'RENT', remarks: 'note' })
    expect(() => normaliseDetails({ category: 'RENT' }, current, { categories: ['PAYROLL'] })).toThrow(DomainError)
  })

  it('refuses a category that is not on the list, and accepts one that is', () => {
    expect(() => normaliseDetails({ category: 'RENT' }, current)).toThrow(DomainError)
    expect(normaliseDetails({ category: 'rent' }, current, { categories: ['RENT'] }).category).toBe('RENT')
    expect(normaliseDetails({ category: '' }, current).category).toBeNull()
  })
})

describe('day helpers', () => {
  it('round-trips a day through a UTC-midnight instant', () => {
    expect(dayToDate('2026-09-20').toISOString()).toBe('2026-09-20T00:00:00.000Z')
    expect(isoDay(dayToDate('2026-09-20'))).toBe('2026-09-20')
    expect(isoDay(null)).toBeNull()
    expect(isIsoDay('2026-09-31')).toBe(false)
  })
})

describe('diffDetails', () => {
  it('reports only what changed, as from → to', () => {
    expect(diffDetails(current, { ...current, remarks: 'new', pointPerson: 'BEN' })).toEqual({
      remarks: { from: 'old', to: 'new' },
      pointPerson: { from: null, to: 'BEN' },
    })
  })

  it('reports nothing when nothing changed', () => {
    expect(diffDetails(current, { ...current })).toEqual({})
  })
})
