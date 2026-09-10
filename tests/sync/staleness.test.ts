import { describe, it, expect } from 'vitest'
import { describeStaleness, STALE_AFTER_HOURS } from '@/lib/sync/staleness'

const NOW = new Date('2026-09-12T10:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

/**
 * Pure. On a once-a-day plan this is what turns "a sync nobody ran" from an
 * invisible gap into a visible one, so the threshold and the verdicts are
 * pinned with literals rather than read off a rendered page.
 */
describe('describeStaleness', () => {
  it('is quiet at 24 hours — that is what a daily cadence looks like', () => {
    const s = describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(24) }], NOW)
    expect(s.warn).toBe(false)
    expect(s.tenants[0].hoursAgo).toBe(24)
    expect(s.tenants[0].stale).toBe(false)
  })

  it('warns once the daily run has been missed', () => {
    const s = describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(31) }], NOW)
    expect(s.warn).toBe(true)
    expect(s.oldestHours).toBe(31)
  })

  it('pins the threshold at 30 hours', () => {
    expect(STALE_AFTER_HOURS).toBe(30)
    expect(describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(29) }], NOW).warn).toBe(false)
    expect(describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(30) }], NOW).warn).toBe(true)
  })

  it('warns when either tenant is stale, and names the older', () => {
    const s = describeStaleness([
      { tenant: 'GOLIVE', lastReadAt: hoursAgo(2) },
      { tenant: 'MANUFACTURING', lastReadAt: hoursAgo(40) },
    ], NOW)
    expect(s.warn).toBe(true)
    expect(s.oldestHours).toBe(40)
    expect(s.tenants.map((t) => t.stale)).toEqual([false, true])
  })

  it('treats a tenant never read as stale, with no age to state', () => {
    const s = describeStaleness([{ tenant: 'MANUFACTURING', lastReadAt: null }], NOW)
    expect(s.warn).toBe(true)
    expect(s.tenants[0].hoursAgo).toBeNull()
    expect(s.oldestHours).toBeNull()
  })
})
