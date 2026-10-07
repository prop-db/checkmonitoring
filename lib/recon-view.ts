import { manilaDay } from './forecast/buckets'
import { isIsoDay } from './domain/details'
import { slugify } from './export/report'

/** The recon screen's arithmetic — parameters, hrefs, the filter line and the filename. Pure. */
export const RECON_PATH = '/recon'
export const RECON_EXPORT_PATH = '/api/export/recon'

export type ReconParams = { asOf?: string; bank?: string; company?: string; account?: string }

/** A valid `YYYY-MM-DD`, else today's Manila day. Never yesterday's UTC day. */
export function parseAsOf(value: string | undefined, now: Date): string {
  const s = (value ?? '').trim()
  return isIsoDay(s) ? s : manilaDay(now)
}

export function reconHref(params: ReconParams, path: string = RECON_PATH): string {
  const qs = new URLSearchParams()
  for (const key of ['asOf', 'bank', 'company', 'account'] as const) {
    const v = params[key]?.trim()
    if (v) qs.set(key, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function describeReconFilters(
  f: { bank?: string | null; company?: string | null; account?: string | null },
): string {
  const parts: string[] = []
  if (f.bank) parts.push(`BANK: ${f.bank}`)
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.account) parts.push(`ACCOUNT: ${f.account}`)
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

export function reconFilename(asOfDay: string): string {
  return `${slugify('outstanding checks')}-${asOfDay}.xlsx`
}
