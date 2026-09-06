import { statusPillClass } from '@/lib/status-pill'

/**
 * A status, as a pill.
 *
 * The colour lives in `lib/status-pill.ts`, which is pure and tested for gaps —
 * this file decides the shape of the pill, never what a status means. The
 * status is always spelled out, so the colour speeds the eye up rather than
 * carrying the meaning on its own.
 */
export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide ${statusPillClass(status)}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}
