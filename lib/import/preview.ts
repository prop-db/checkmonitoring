import type { StagedReason } from '@prisma/client'
import { isLiveStatus, type CheckStatus } from '@/lib/domain/check-status'
import { DomainError } from '@/lib/domain/errors'
import type { NormalisedRow } from '@/lib/normalised-row'
import { classifyImportOutcome } from './classify'
import { resolveCompany, type CompanyReferenceData } from './company'
import { resolveImpliedStatus, type ImpliedStatusResolution } from './implied-status'
import { mapParsedRow } from './map-row'
import type { ParsedRow, ReviewItem, UnkeyedRow } from './parse'
import {
  reconcile, type Conflict, type ConflictKind, type RegisterStatus, type VendorMerge,
} from './reconcile'
import { groupByCheckNumber } from './upsert'

/**
 * What an import WILL do, computed without touching the database.
 *
 * The reason this exists is one number. Measured against the real register:
 *
 * ```
 * imported                  9,461
 * staged NO_COMPANY         2,639
 * staged AMBIGUOUS_COMPANY     61
 * staged NO_CHECK_NUMBER       66
 * ─────────────────────────────
 * total                    12,227
 * ```
 *
 * **22% of the register does not import.** A screen that reports "9,461 checks
 * imported" and stops is read as success, and the missing 2,766 surface weeks
 * later as somebody hunting a cheque that is not there. So this report is built
 * to make the two halves the same size: `willImport` and `willStage` are
 * siblings, `willImport + willStage === totalRows` is asserted by test, and
 * every staged row is carried in full so a group can be opened and read.
 *
 * Every verdict here comes from the same functions the import itself calls —
 * `mapParsedRow`, `groupByCheckNumber`, `classifyImportOutcome`,
 * `resolveImpliedStatus`. Nothing in this module decides anything on its own,
 * which is what makes the preview a promise rather than an estimate. Do not add
 * a rule here; add it where the importer reads it, and this will follow.
 *
 * Pure: no database, no clock of its own.
 */

export type StagedPreviewRow = {
  sheet: string
  row: number
  reason: StagedReason
  checkNumber: string | null
  /** What the cell held where a cheque number belongs. Null on a register row
   * that had nothing there at all, which is the usual NO_CHECK_NUMBER case. */
  statedCheckRef: string | null
  payeeName: string | null
  amount: string | null
  currency: string | null
  checkDate: Date | null
  companyCode: string | null
  cashAccountCode: string | null
  checkBookCode: string | null
  conflictingCompanies: string[]
  /**
   * Null only when this row's cheque appears on a combination of sheets Finance
   * has not ruled on — see `unruledClashes`. Never guessed.
   */
  impliedStatus: CheckStatus | null
}

export type ContradictionPreview = {
  checkNumber: string
  sheets: string[]
  /** The register statuses that clashed, in the register's own vocabulary. */
  implied: RegisterStatus[]
  /** Which one the 2026-09-03 ruling chose, and the ladder status it becomes. */
  resolvedFrom: RegisterStatus | null
  status: CheckStatus
  rows: { sheet: string; row: number }[]
}

export type UnruledClash = {
  checkNumber: string
  sheets: string[]
  rows: { sheet: string; row: number }[]
  message: string
}

export type CompanyConflictPreview = {
  sheet: string
  row: number
  checkNumber: string
  cashAccountLabel: string | null
  checkBook: string | null
  /** The cash account wins, per the 2026-09-03 ruling. */
  resolved: string
  conflictedWith: string
}

export type ImportPreview = {
  totalRows: number
  willImport: number
  willStage: number
  stagedByReason: Record<StagedReason, number>
  stagedRows: StagedPreviewRow[]
  /** The scope ruling's split: how much of the staged pile is actually work. */
  stagedLive: number
  stagedClosed: number
  /** Staged rows whose cheque appears on a sheet combination nobody has ruled
   * on, so no status could be derived for them. `stagedLive + stagedClosed +
   * stagedUnruled === willStage`; without this third figure the split would
   * quietly fail to add up to the total it sits under. Zero on the register as
   * measured, and the import refuses to run at all while it is not. */
  stagedUnruled: number
  stagedByImpliedStatus: { status: CheckStatus; count: number }[]
  contradictions: ContradictionPreview[]
  unruledClashes: UnruledClash[]
  companyConflicts: CompanyConflictPreview[]
  conflicts: Conflict[]
  conflictsByKind: Record<ConflictKind, number>
  /** Only the names that actually fold together. A list of every payee that
   * merges with nothing is not a merge list, it is the register. */
  vendorMerges: VendorMerge[]
  distinctPayees: number
  sheets: { sheet: string; rows: number }[]
}

const EMPTY_BY_REASON: Record<StagedReason, number> = {
  NO_COMPANY: 0, NO_CHECK_NUMBER: 0, AMBIGUOUS_COMPANY: 0, SHARED_NUMBER: 0,
}

const EMPTY_BY_KIND: Record<ConflictKind, number> = {
  DUPLICATE_ACROSS_SHEETS: 0, CONTRADICTORY_STATUS: 0, AMOUNT_MISMATCH: 0, IMPLAUSIBLE_DATE: 0,
}

export function previewRegisterImport(args: {
  parsed: readonly ParsedRow[]
  review: readonly ReviewItem[]
  ref: CompanyReferenceData
  today: Date
}): ImportPreview {
  const { parsed, review, ref, today } = args

  // Parsed rows first, then the ones that could not be keyed — the same order
  // the CLI feeds `importRows`, so the sheet tally below reads in register
  // order rather than in an order this module invented.
  const sources: { source: ParsedRow | UnkeyedRow; normalised: NormalisedRow }[] = [
    ...parsed.map((p) => ({ source: p, normalised: mapParsedRow(p, ref) })),
    ...review.map((r) => ({ source: r.unkeyed, normalised: mapParsedRow(r.unkeyed, ref) })),
  ]

  // The same grouping `importRows` does, over the same rows, before anything is
  // classified. Both rulings this reports are properties of a cheque NUMBER
  // across every row that mentions it, not of a row.
  const groups = groupByCheckNumber(sources.map((s) => s.normalised))

  const rowsByCheckNumber = new Map<string, { sheet: string; row: number }[]>()
  for (const { source, normalised } of sources) {
    if (normalised.checkNumber === null) continue
    const list = rowsByCheckNumber.get(normalised.checkNumber) ?? []
    list.push({ sheet: source.sheet, row: source.row })
    rowsByCheckNumber.set(normalised.checkNumber, list)
  }

  // `resolveImpliedStatus` throws on a combination nobody has ruled on. In the
  // importer that is correct and deliberate — the run stops and a human
  // decides. In a preview it would replace the accounting with a stack trace,
  // and the operator would learn nothing about the other twelve thousand rows.
  // So it is caught here, reported as a blocker, and the row's status is left
  // null rather than guessed.
  const resolutions = new Map<string, ImpliedStatusResolution>()
  // The resolution is cached on the sheet set, because that is all it depends
  // on. The CLASH, though, is recorded per cheque OUTSIDE the cache miss:
  // recording it on the miss would report one cheque per distinct sheet
  // combination and silently swallow every other cheque sharing it, which on a
  // report whose entire purpose is that nothing is hidden is the worst bug
  // available.
  const unresolvable = new Map<string, string>()
  const unruled = new Map<string, UnruledClash>()

  const resolve = (sheets: readonly string[], checkNumber: string | null): ImpliedStatusResolution | null => {
    const key = sheets.join(' ')
    if (!resolutions.has(key) && !unresolvable.has(key)) {
      try {
        resolutions.set(key, resolveImpliedStatus(sheets))
      } catch (e) {
        if (!(e instanceof DomainError)) throw e
        unresolvable.set(key, e.message)
      }
    }

    const message = unresolvable.get(key)
    if (message === undefined) return resolutions.get(key) ?? null

    if (checkNumber !== null && !unruled.has(checkNumber)) {
      unruled.set(checkNumber, {
        checkNumber,
        sheets: [...new Set(sheets)],
        rows: rowsByCheckNumber.get(checkNumber) ?? [],
        message,
      })
    }
    return null
  }

  const stagedByReason = { ...EMPTY_BY_REASON }
  const stagedRows: StagedPreviewRow[] = []
  const byImplied = new Map<CheckStatus, number>()
  const sheetTally = new Map<string, number>()
  const companyConflicts: CompanyConflictPreview[] = []
  let willImport = 0
  let stagedLive = 0
  let stagedClosed = 0
  let stagedUnruled = 0

  for (const { source, normalised } of sources) {
    sheetTally.set(source.sheet, (sheetTally.get(source.sheet) ?? 0) + 1)

    // Exactly what `upsertCheck` is handed by `importRows`: the whole group's
    // sheets when the row has a cheque number, its own sheet when it does not.
    const group = normalised.checkNumber !== null ? groups.get(normalised.checkNumber) : undefined
    const sheets = group?.sheets ?? (normalised.sourceSheet ? [normalised.sourceSheet] : [])
    const implied = resolve(sheets, normalised.checkNumber)

    // The 17 rows whose cash account and checkbook name different companies.
    // `resolveCompany` is pure, so calling it a second time here costs nothing
    // and keeps the losing signal out of `NormalisedRow`, where it would be a
    // reporting concern living in the shape the upsert reads.
    const company = resolveCompany(source, ref)
    if (company.ok && company.conflictedWith !== null && normalised.checkNumber !== null) {
      companyConflicts.push({
        sheet: source.sheet,
        row: source.row,
        checkNumber: normalised.checkNumber,
        cashAccountLabel: source.cashAccountLabel,
        checkBook: source.checkBook,
        resolved: company.companyCode,
        conflictedWith: company.conflictedWith,
      })
    }

    const outcome = classifyImportOutcome(normalised, group?.companies)
    if (outcome.write) {
      willImport++
      continue
    }

    stagedByReason[outcome.reason]++
    if (implied) {
      byImplied.set(implied.status, (byImplied.get(implied.status) ?? 0) + 1)
      if (isLiveStatus(implied.status)) stagedLive++
      else stagedClosed++
    } else {
      stagedUnruled++
    }
    stagedRows.push({
      sheet: source.sheet,
      row: source.row,
      reason: outcome.reason,
      checkNumber: normalised.checkNumber,
      statedCheckRef: normalised.statedCheckRef,
      payeeName: normalised.payeeName,
      amount: normalised.amount,
      currency: normalised.currency,
      checkDate: normalised.checkDate,
      companyCode: normalised.companyCode,
      cashAccountCode: normalised.cashAccountCode,
      checkBookCode: normalised.checkBookCode,
      conflictingCompanies: outcome.conflictingCompanies,
      impliedStatus: implied?.status ?? null,
    })
  }

  // How the 2026-09-03 ruling settled each cheque whose sheets disagree — 102
  // of them in the real register. Reported per cheque, with the sheets and the
  // chosen verdict, so each one is traceable to the decision that settled it
  // rather than to "the importer chose".
  const contradictions: ContradictionPreview[] = []
  for (const [checkNumber, group] of groups) {
    const implied = resolve(group.sheets, checkNumber)
    if (!implied || implied.implied.length <= 1) continue
    contradictions.push({
      checkNumber,
      sheets: implied.sheets,
      implied: implied.implied,
      resolvedFrom: implied.resolvedFrom,
      status: implied.status,
      rows: rowsByCheckNumber.get(checkNumber) ?? [],
    })
  }

  // Duplicates across sheets, amount mismatches, implausible dates and the
  // vendor merge list. Fed only the keyed rows, because `reconcile` groups by
  // cheque number and a row without one cannot join a group — the 66 unkeyed
  // rows are accounted for above, under NO_CHECK_NUMBER, not here.
  const { conflicts, vendorMerges } = reconcile(parsed, { today })
  const conflictsByKind = { ...EMPTY_BY_KIND }
  for (const c of conflicts) conflictsByKind[c.kind]++

  const willStage = stagedRows.length

  return {
    totalRows: sources.length,
    willImport,
    willStage,
    stagedByReason,
    stagedRows,
    stagedLive,
    stagedClosed,
    stagedUnruled,
    stagedByImpliedStatus: [...byImplied].map(([status, count]) => ({ status, count })),
    contradictions,
    unruledClashes: [...unruled.values()],
    companyConflicts,
    conflicts,
    conflictsByKind,
    // A "merge list" of names that merge with nothing is the register with
    // extra steps. Only the groups a confirmation actually decides anything
    // about are offered; the total is reported separately so nobody reads a
    // short merge list as a short register.
    vendorMerges: vendorMerges.filter((m) => m.variants.length > 1),
    distinctPayees: vendorMerges.reduce((n, m) => n + m.variants.length, 0),
    sheets: [...sheetTally].map(([sheet, rows]) => ({ sheet, rows })),
  }
}
