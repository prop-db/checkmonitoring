import { describe, it, expect } from 'vitest'
import { releaseDay } from '@/lib/release-day'
import { appSortValue, NO_ACUMATICA_POS } from '@/lib/queries'

const probe = (o: { releasedAt?: Date | null; statedReleaseDate?: Date | null }) => ({
  apvNumbers: [], releasedAt: null, statedReleaseDate: null, cashAccount: null, checkBook: null, bills: [], ...o,
})

describe('releaseDay', () => {
  it('is the typed day when present, even beside a recorded instant', () => {
    expect(releaseDay({ releasedAt: new Date('2026-10-16T10:00:00Z'), statedReleaseDate: new Date('2026-10-15T00:00:00Z') }))
      .toEqual(new Date('2026-10-15T00:00:00Z'))
  })
  it('falls back to the Manila day of the recorded instant', () => {
    expect(releaseDay({ releasedAt: new Date('2026-10-16T16:30:00Z'), statedReleaseDate: null })).toEqual(new Date('2026-10-17T00:00:00Z'))
  })
  it('is null when neither exists', () => {
    expect(releaseDay({ releasedAt: null, statedReleaseDate: null })).toBeNull()
  })
  it('orders the DATE RELEASED sort by the typed day first', () => {
    const v = appSortValue('releasedAt', probe({ releasedAt: new Date('2026-10-16T10:00:00Z'), statedReleaseDate: new Date('2026-10-15T00:00:00Z') }), NO_ACUMATICA_POS)
    expect(v).toBe(new Date('2026-10-15T00:00:00Z').getTime())
  })
})
