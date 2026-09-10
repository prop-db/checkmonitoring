/**
 * When the dashboard should say Acumatica has not been read.
 *
 * Pure: reads in, verdicts out. On a once-a-day plan this line matters as much
 * as the cron itself — since the register was retired, a cheque the sync has
 * not read does not exist anywhere Finance can see, and a board that looked
 * current while being a day and a half old would be the quiet version of that.
 */

/**
 * A daily cadence plus slack. At 17:59 the evening run is 24 hours old and that
 * is normal; at 30 hours the run has been missed. Not shorter, or the line would
 * cry wolf every afternoon; not much longer, or a missed run would go a whole
 * second day unremarked.
 */
export const STALE_AFTER_HOURS = 30

export type TenantRead = { tenant: string; lastReadAt: Date | null }
export type TenantStaleness = TenantRead & { hoursAgo: number | null; stale: boolean }
export type Staleness = {
  tenants: TenantStaleness[]
  /** True if any tenant is stale — the board warns as a whole. */
  warn: boolean
  /** The largest known age, for the warning's headline. Null if no tenant has ever been read. */
  oldestHours: number | null
}

export function describeStaleness(
  reads: readonly TenantRead[],
  now: Date,
  staleAfterHours: number = STALE_AFTER_HOURS,
): Staleness {
  const tenants: TenantStaleness[] = reads.map((r) => {
    // Never read is the stalest a tenant can be, and has no age to state.
    if (r.lastReadAt === null) return { ...r, hoursAgo: null, stale: true }
    const hoursAgo = Math.floor((now.getTime() - r.lastReadAt.getTime()) / 3_600_000)
    return { ...r, hoursAgo, stale: hoursAgo >= staleAfterHours }
  })
  const known = tenants.flatMap((t) => (t.hoursAgo === null ? [] : [t.hoursAgo]))
  return {
    tenants,
    warn: tenants.some((t) => t.stale),
    oldestHours: known.length ? Math.max(...known) : null,
  }
}
