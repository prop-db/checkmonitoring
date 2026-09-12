import { describe, it, expect } from 'vitest'
import { RECON_PATH, RECON_EXPORT_PATH, parseAsOf, reconHref, describeReconFilters, reconFilename } from '@/lib/recon-view'

const NOW = new Date('2026-09-12T01:00:00Z') // 09:00 Manila on the 12th

describe('parseAsOf', () => {
  it('accepts a day and defaults to today in Manila', () => {
    expect(parseAsOf('2026-08-31', NOW)).toBe('2026-08-31')
    expect(parseAsOf(undefined, NOW)).toBe('2026-09-12')
    expect(parseAsOf('', NOW)).toBe('2026-09-12')
    expect(parseAsOf('31/08/2026', NOW)).toBe('2026-09-12')
    expect(parseAsOf('2026-02-30', NOW)).toBe('2026-09-12')
  })
  it('names the day after midnight Manila, not UTC', () => {
    expect(parseAsOf(undefined, new Date('2026-09-11T17:30:00Z'))).toBe('2026-09-12')
  })
})

describe('reconHref', () => {
  it('carries the parameters, drops empties, and can point at the export', () => {
    expect(reconHref({})).toBe(RECON_PATH)
    expect(reconHref({ asOf: '2026-08-31', bank: 'BPI', company: '', account: 'acc1' })).toBe('/recon?asOf=2026-08-31&bank=BPI&account=acc1')
    expect(reconHref({ asOf: '2026-08-31' }, RECON_EXPORT_PATH)).toBe('/api/export/recon?asOf=2026-08-31')
  })
})

describe('describeReconFilters and reconFilename', () => {
  it('names the filters in force', () => {
    expect(describeReconFilters({ bank: 'BPI', company: 'STK', account: 'BPI STK' })).toBe('BANK: BPI  ·  COMPANY: STK  ·  ACCOUNT: BPI STK')
    expect(describeReconFilters({})).toBe('No filters applied')
  })
  it('dates the file by the as-of day', () => {
    expect(reconFilename('2026-08-31')).toBe('outstanding-cheques-2026-08-31.xlsx')
  })
})
