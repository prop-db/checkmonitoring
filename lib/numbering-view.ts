import { slugify } from './export/report'
import type { SeriesEntry } from './numbering/series'

/** The numbering screen's arithmetic — parameters, hrefs, labels, the filename. Pure. */
export const NUMBERING_PATH = '/numbering'
export const NUMBERING_EXPORT_PATH = '/api/export/numbering'

export type NumberingParams = { company?: string; account?: string; missing?: boolean }

export function numberingHref(p: NumberingParams, path: string = NUMBERING_PATH): string {
  const qs = new URLSearchParams()
  const company = p.company?.trim()
  const account = p.account?.trim()
  if (company) qs.set('company', company)
  if (account) qs.set('account', account)
  if (p.missing) qs.set('missing', '1')
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function isMissingOnly(value: string | null | undefined): boolean {
  return (value ?? '').trim() === '1'
}

export function visibleEntries(entries: readonly SeriesEntry[], missingOnly: boolean): SeriesEntry[] {
  return missingOnly ? entries.filter((e) => e.kind === 'MISSING') : [...entries]
}

export function describeNumberingFilters(
  f: { company?: string | null; account?: string | null; missingOnly?: boolean },
): string {
  const parts: string[] = []
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.account) parts.push(`ACCOUNT: ${f.account}`)
  if (f.missingOnly) parts.push('MISSING ONLY')
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

export function missingLabel(e: { from: string; to: string; count: string }): string {
  const range = e.from === e.to ? e.from : `${e.from} – ${e.to}`
  return `${range} · MISSING · ${e.count}`
}

export function numberingFilename(day: string): string {
  return `${slugify('cheque numbering')}-${day}.xlsx`
}

/** Printed on the page and in the file (spec §B2): what MISSING cannot tell you. */
export const NUMBERING_SCOPE_NOTE =
  'MISSING means no cheque in this system holds the number. The Acumatica sync reads payments dated 2026 ' +
  'onward, so an account\'s first number may sit partway through a booklet and earlier numbers are not known ' +
  'here. A cheque Acumatica holds with a memo in place of its number is on the staged queue, not here — its ' +
  'number may be one of the MISSING.'
