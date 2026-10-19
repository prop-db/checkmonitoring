import { manilaToday } from '@/lib/manila-day'

/**
 * A check's RELEASE DAY, the one definition behind DATE RELEASED (user ruling
 * 2026-10-19): the day a person typed (`statedReleaseDate` — the portal's
 * release date, or the retired register's) when there is one; otherwise the
 * Manila calendar day of `releasedAt`, the instant the release was recorded.
 * Returned as a UTC-midnight Date so both sources compare and format alike.
 * Pure. `lib/recon/*` deliberately does not use it: it reads only `releasedAt`.
 */
export function releaseDay(r: { releasedAt: Date | null; statedReleaseDate: Date | null }): Date | null {
  if (r.statedReleaseDate) return r.statedReleaseDate
  if (r.releasedAt) return new Date(`${manilaToday(r.releasedAt)}T00:00:00Z`)
  return null
}
