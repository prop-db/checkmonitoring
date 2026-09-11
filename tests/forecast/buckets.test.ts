import { describe, it, expect } from 'vitest'
import { BUCKETS, bucketFor, daysPresentable, manilaDay } from '@/lib/forecast/buckets'

/**
 * Pure. The buckets are the report, so every edge is pinned with a literal.
 *
 * TODAY is Wednesday 16 September 2026, 10:00 Manila. A cheque "N days ago" is
 * dated at UTC midnight N days before the 16th — the way both ingestion paths
 * store a date — and a Manila reader must see it as that calendar day.
 */
const TODAY = new Date('2026-09-16T02:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 8, 16 - n))

describe('manilaDay', () => {
  it('is the Manila calendar day, not the UTC one', () => {
    // 16:30 UTC on the 10th is 00:30 on the 11th in Manila.
    expect(manilaDay(new Date('2026-09-10T16:30:00Z'))).toBe('2026-09-11')
    expect(manilaDay(new Date('2026-09-11T00:00:00Z'))).toBe('2026-09-11')
  })
})

describe('daysPresentable', () => {
  it('counts whole calendar days, past positive, future negative', () => {
    expect(daysPresentable(daysAgo(0), TODAY)).toBe(0)
    expect(daysPresentable(daysAgo(7), TODAY)).toBe(7)
    expect(daysPresentable(daysAgo(-3), TODAY)).toBe(-3)
  })
})

describe('bucketFor — the past', () => {
  it.each([
    [0, 'TODAY'],
    [1, '1–7 DAYS'], [7, '1–7 DAYS'],
    [8, '8–30 DAYS'], [30, '8–30 DAYS'],
    [31, '31–60 DAYS'], [60, '31–60 DAYS'],
    [61, '61–90 DAYS'], [90, '61–90 DAYS'],
    [91, 'OVER 90 DAYS'], [400, 'OVER 90 DAYS'],
  ] as const)('%i days ago → %s', (n, bucket) => {
    expect(bucketFor(daysAgo(n), TODAY)).toBe(bucket)
  })
})

describe('bucketFor — the future', () => {
  // Wednesday: this week's Sunday is 4 days away.
  it('THIS WEEK runs up to and including Sunday', () => {
    expect(bucketFor(daysAgo(-1), TODAY)).toBe('THIS WEEK')
    expect(bucketFor(daysAgo(-4), TODAY)).toBe('THIS WEEK')
  })

  it('NEXT WEEK is the following Monday to Sunday', () => {
    expect(bucketFor(daysAgo(-5), TODAY)).toBe('NEXT WEEK')
    expect(bucketFor(daysAgo(-11), TODAY)).toBe('NEXT WEEK')
  })

  it('LATER is anything after that', () => {
    expect(bucketFor(daysAgo(-12), TODAY)).toBe('LATER')
  })

  it('on a Sunday, tomorrow is already NEXT WEEK', () => {
    const sunday = new Date('2026-09-13T02:00:00Z')
    expect(bucketFor(new Date(Date.UTC(2026, 8, 14)), sunday)).toBe('NEXT WEEK')
  })
})

describe('bucketFor — no date', () => {
  it('is its own bucket, never a time one', () => {
    expect(bucketFor(null, TODAY)).toBe('NO DATE')
  })
})

describe('BUCKETS', () => {
  it('runs oldest first and ends with NO DATE', () => {
    expect(BUCKETS[0]).toBe('OVER 90 DAYS')
    expect(BUCKETS[BUCKETS.length - 1]).toBe('NO DATE')
    expect(BUCKETS).toHaveLength(10)
  })
})
