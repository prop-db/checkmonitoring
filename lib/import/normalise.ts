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
