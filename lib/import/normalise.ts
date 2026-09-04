export function cleanCell(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim().replace(/\s+/g, ' ')
  if (s === '' || s.toUpperCase() === '#N/A') return null
  return s
}

// The register spells the same company several ways: with and without a
// trailing period, INC vs INCORPORATED, inconsistent casing and spacing. Fold
// them to one key so a vendor is not created twice. The `+` in "A1+" is part of
// the name and must survive.
export function canonicalVendor(name: string): string {
  return String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,']/g, '')
    .replace(/\bINCORPORATED\b/g, 'INC')
    .replace(/\bCORPORATION\b/g, 'CORP')
    .trim()
}

// Known mis-keyings in the register, confirmed by Finance. The letter in a
// checkbook code encodes the company — S for a Starkson entity, A for an A1+
// one — so a wrong letter files a cheque's checkbook under a sibling company.
// Left uncorrected, `MBT-S-9048` would also create a seventh checkbook that
// does not exist.
const CHECKBOOK_ALIASES: Readonly<Record<string, string>> = {
  'MBT-S-9048': 'MBT-A-9048',   // confirmed 2026-09-03: mis-keyed A as S
}

export function canonicalCheckBook(code: string | null | undefined): string | null {
  const c = cleanCell(code)?.toUpperCase() ?? null
  if (!c) return null
  return CHECKBOOK_ALIASES[c] ?? c
}

// Excel's 1900 date system, with the well-known leap-year bug: serial 60 is a
// day that never existed, so everything from 61 onward is offset by one. The
// 1899-12-30 epoch below already accounts for it, and is therefore correct only
// for serials above 60 — which every date in this register is, the range being
// roughly 44000 to 48000. Verified against two independent reference points:
// serial 44927 is 2023-01-01 and serial 45658 is 2025-01-01.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000

export function excelSerialToDate(serial: number): Date {
  const wholeDays = Math.floor(serial)
  return new Date(EXCEL_EPOCH_UTC + wholeDays * MS_PER_DAY)
}

// The two ingestion paths write the same physical cheque differently, and until
// 2026-09-04 nothing reconciled them. The register writes a cheque number bare
// (`6000308584`); Acumatica's `PaymentRef` is bank-prefixed (`BPI 6000240287`)
// on 1,789 of 1,987 live rows — 90.0% — and bare on only 82 (4.1%). Because the
// dedup key is `(companyId, checkNumber)`, one physical cheque was stored TWICE,
// once per source: staged register rows could never be promoted, and every
// cheque present in both sources double-counted in the dashboard totals.
//
// The bare form is canonical because it is the register's and the one a human
// reads off the cheque itself.
//
// The prefixes measured across 2,000 live rows are exactly three known banks —
// MBTC 1059, BPI 729, BDO 1 — and stripping merges ZERO distinct original refs
// onto one key, so this cannot silently collide two different cheques.
//
// Anchored, and deliberately narrow: a known bank code, whitespace, then a
// cheque number of exactly the two lengths this register uses. Everything else
// is left alone. A blind `replace(/\D/g, '')` would turn the free text 80 real
// cheques carry in this field ("Oct interest", "pay 12 25 2nd", "MBTC 1791 to
// 1795") into a plausible-looking cheque number, which is inventing a fact
// about money. A bank we have not measured is left alone for the same reason.
// Do not widen either the bank list or the digit lengths without re-measuring.
const BANK_PREFIXED_CHECK_NUMBER = /^(?:MBTC|BPI|BDO)\s+(\d{6}|\d{10})$/i

/**
 * The single place the cheque-number rule lives. Both `lib/import/map-row.ts`
 * and `lib/integrations/acumatica/map.ts` call it, which is what makes a
 * register row and its Acumatica counterpart resolve to the same dedup key.
 * Do not add a second normalisation anywhere.
 */
export function canonicalCheckNumber(value: string | null | undefined): string | null {
  const c = cleanCell(value)
  if (!c) return null
  return BANK_PREFIXED_CHECK_NUMBER.exec(c)?.[1] ?? c
}

/**
 * Whether a canonical reference can actually key a cheque.
 *
 * 80 live rows are `PaymentMethod: CHK` — genuinely cheques — but carry a memo
 * where the cheque number belongs. They cannot be keyed on
 * `(company, checkNumber)` at all, and Finance ruled on 2026-09-04 that they
 * are staged for a human to supply the real number rather than being invented a
 * key or dropped.
 *
 * Digits only. `map.ts` warns, correctly, that cheque numbering is a bank's
 * business and nothing guarantees a future format stays numeric — which is
 * exactly why a reference that fails this test is STAGED rather than discarded:
 * the payment is kept whole and put in front of somebody, and no cheque is lost
 * if the assumption ever stops holding. Apply it only after
 * `canonicalCheckNumber`, or a bank-prefixed number reads as free text.
 */
export function isBareCheckNumber(value: string | null | undefined): boolean {
  return value != null && /^\d+$/.test(value)
}
