import { describe, it, expect } from 'vitest'
import { DETAIL_FIELDS, normaliseDetails, diffDetails, type DetailValues } from '@/lib/domain/details'

const current: DetailValues = { remarks: 'old', pointPerson: null, checksPossession: 'ANA', category: 'PAYROLL' }

describe('normaliseDetails', () => {
  it('trims, and stores an empty box as null', () => {
    expect(normaliseDetails({ remarks: '  note  ', pointPerson: '   ' }, current))
      .toEqual({ remarks: 'note', pointPerson: null, checksPossession: 'ANA', category: 'PAYROLL' })
  })

  it('leaves a field the form did not send exactly as it is', () => {
    expect(normaliseDetails({}, current)).toEqual(current)
    expect(normaliseDetails({ remarks: undefined }, current)).toEqual(current)
  })

  it('folds the category to upper case, as the import does', () => {
    expect(normaliseDetails({ category: 'local supplier' }, current).category).toBe('LOCAL SUPPLIER')
  })

  it('names the four register fields and no other', () => {
    expect([...DETAIL_FIELDS]).toEqual(['remarks', 'pointPerson', 'checksPossession', 'category'])
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
