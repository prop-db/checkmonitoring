import type { CheckStatus } from '@prisma/client'
import { LIVE_STATUSES } from './domain/check-status'
import { statusWords, slugify } from './export/report'
import { manilaDay } from './forecast/buckets'

/**
 * The forecast screen's arithmetic — parameters, hrefs, the filter line and
 * the filename. Pure, for the same reason `vouchers-view.ts` and
 * `dashboard-view.ts` are: the page reads these and decides nothing itself.
 */

export const FORECAST_PATH = '/forecast'
export const FORECAST_EXPORT_PATH = '/api/export/forecast'

/** The STAGE select: the live statuses, ladder order, as words. Read from the ladder, not restated. */
export const STAGE_OPTIONS: readonly { value: CheckStatus; label: string }[] =
  LIVE_STATUSES.map((s) => ({ value: s, label: statusWords(s) }))

export type ForecastParams = { bank?: string; company?: string; stage?: string }

/**
 * `?stage=` as the screen reads it: words or underscores, any case, LIVE only.
 * A closed status is refused rather than honoured — the population is what is
 * not yet handed over, and a filter to RELEASED would show an empty table that
 * looks like a broken one.
 */
export function parseStageParam(value: string | undefined): CheckStatus | undefined {
  if (!value) return undefined
  const key = value.trim().toUpperCase().replace(/ /g, '_')
  return (LIVE_STATUSES as readonly string[]).includes(key) ? (key as CheckStatus) : undefined
}

/** The URL a filled-in form means. Empty controls are dropped, as everywhere else. */
export function forecastHref(params: ForecastParams, path: string = FORECAST_PATH): string {
  const qs = new URLSearchParams()
  for (const key of ['bank', 'company', 'stage'] as const) {
    const v = params[key]?.trim()
    if (v) qs.set(key, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/** The filters in force, in words, for the page and the workbook's title block. */
export function describeForecastFilters(
  f: { bank?: string | null; company?: string | null; stage?: CheckStatus | null },
): string {
  const parts: string[] = []
  if (f.bank) parts.push(`BANK: ${f.bank}`)
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.stage) parts.push(`STAGE: ${statusWords(f.stage)}`)
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

/**
 * `cash-outflow-2026-09-11.xlsx`, dated in the MANILA day — the one day this
 * company operates in, and the same day the title block stamps. Local getters
 * read the server's clock, which on Vercel is UTC: between 00:00 and 08:00
 * Manila that named yesterday while the sheet inside said today. `manilaDay`
 * is the one function both the filename and the title block go through now,
 * so the name on the download and the date on the page always agree.
 */
export function forecastFilename(generatedAt: Date): string {
  return `${slugify('cash outflow')}-${manilaDay(generatedAt)}.xlsx`
}
