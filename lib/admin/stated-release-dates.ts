import type { CheckStatus, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { isIsoDay } from '@/lib/domain/details'
import { manilaDay } from '@/lib/forecast/buckets'
import type { CompanyReferenceData } from '@/lib/import/company'
import type { RawRow } from '@/lib/import/workbook'
import { readRegisterReleases, type RegisterReading, type RegisterRelease } from './register-releases'

/**
 * Give a cheque released outside this app the day the retired register states.
 *
 * WHY. The DATE RELEASED filter reads `releasedAt`, which only `markReleased`
 * writes. The 228 pick-ups of 25 September 2026 were moved to RELEASED by the
 * register catch-up with no timestamp — correctly, because a spreadsheet
 * cannot say when a cheque changed hands — and so the filter could not find
 * them. The user's ruling (2026-09-28): "it should have the date stated in the
 * summary". This writes that stated day into ITS OWN column,
 * `statedReleaseDate`, and never into `releasedAt`: the app's timestamp keeps
 * meaning "released through this system" (which `lib/recon/outstanding.ts`
 * relies on), and the register's day — hand-typed into a file whose amounts
 * and companies were measured wrong at scale — is shown apart and tagged.
 *
 * WHAT IT READS. `readRegisterReleases`, unchanged: every cheque the register
 * shows picked up, with each RELEASED-sheet row's DATE RELEASED as
 * `YYYY-MM-DD` when the cell was a date, verbatim text otherwise, null when
 * blank. A day is written only when the cheque's rows state exactly ONE
 * calendar day. Two spellings count as a day — see `asDay` — and anything
 * else ("SEPT 22", "CLEARED") is listed for a human and never parsed.
 *
 * WHAT IT MATCHES. The cheque number is the identity and the register's
 * company only breaks a tie — the rule `judge` in register-releases.ts
 * applies, for the measured reason given there. Only a cheque RELEASED here
 * qualifies; one already carrying the same day is skipped, one carrying a
 * different day is listed and left.
 *
 * WHAT IT WRITES. `statedReleaseDate` and one SYSTEM audit row. Nothing else.
 * Dry run by default; snapshot first on --apply; idempotent.
 */

export const STATED_RELEASE_DATE_ACTION = 'stated_release_date_from_register'

/** Same override as `lib/import/upsert.ts` — see CLAUDE.md on Prisma's defaults. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

/**
 * No cheque in this register predates 2020; a stated day before this is a
 * mis-key, as is one after the day the script runs. Measured 2026-09-28 in
 * `CHECK MONITORING 9.25.2026.xlsx`: one row states 2081-05-08.
 */
export const EARLIEST_PLAUSIBLE_DAY = '2015-01-01'

const MONTH_DAY_YEAR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * The register's DATE RELEASED as a calendar day, or null when it is not one.
 *
 * Two spellings, both unambiguous:
 *   `YYYY-MM-DD`   an Excel date cell, as `readRegisterReleases` renders it;
 *   `MM/DD/YYYY`   typed as text in the Philippine and Excel display order.
 * The second is not a guess: measured 2026-09-28, 222 of the 228 rows the 9.25
 * register dates 25 September hold the text "09/25/2026", and month/day is the
 * only order a Finance workstation here shows or types. No other text is read.
 */
export function asDay(value: string): string | null {
  const v = value.trim()
  if (isIsoDay(v)) return v
  const m = MONTH_DAY_YEAR.exec(v)
  if (!m) return null
  const day = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return isIsoDay(day) ? day : null
}

export type StatedDay =
  | { kind: 'DAY'; day: string }
  | { kind: 'CONFLICTING_DATES'; days: string[] }
  | { kind: 'NO_USABLE_DATE'; verbatim: string[] }

/**
 * Pure. The one calendar day a cheque's RELEASED rows state, or why there is
 * none. `latest` is the last acceptable day (the Manila day the script runs):
 * a stated day outside [EARLIEST_PLAUSIBLE_DAY, latest] makes the whole cheque
 * NO_USABLE_DATE, listed with what was typed, rather than being dropped so the
 * other value could win — a row that says 2081 needs a person, not a filter.
 */
export function statedDay(release: RegisterRelease, latest: string): StatedDay {
  const stated = release.rows.map((r) => r.dateReleased).filter((d): d is string => d !== null)
  const days = [...new Set(stated.map(asDay).filter((d): d is string => d !== null))].sort()
  const implausible = days.some((d) => d < EARLIEST_PLAUSIBLE_DAY || d > latest)
  if (implausible || days.length === 0) return { kind: 'NO_USABLE_DATE', verbatim: [...new Set(stated)] }
  if (days.length === 1) return { kind: 'DAY', day: days[0] }
  return { kind: 'CONFLICTING_DATES', days }
}

/** `YYYY-MM-DD` as the day's UTC midnight — the convention `checkDate` follows. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

export function dateToDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export type Candidate = {
  id: string
  checkNumber: string
  companyCode: string
  status: CheckStatus
  statedReleaseDate: Date | null
}

export type Verdict =
  | { kind: 'WRITE'; check: Candidate; day: string }
  | { kind: 'NOT_IN_SYSTEM' }
  | { kind: 'AMBIGUOUS'; count: number }
  | { kind: 'NOT_RELEASED_HERE'; check: Candidate }
  | { kind: 'ALREADY_STATED'; check: Candidate }
  | { kind: 'DIFFERENT_DATE_STATED'; check: Candidate; stated: string; day: string }
  | { kind: 'CONFLICTING_DATES'; days: string[] }
  | { kind: 'NO_USABLE_DATE'; verbatim: string[] }

/** Pure. Exactly one RELEASED cheque and exactly one stated day, or nothing is written. */
export function judge(release: RegisterRelease, candidates: readonly Candidate[], latest: string): Verdict {
  const stated = statedDay(release, latest)
  if (stated.kind !== 'DAY') return stated

  const same = candidates.filter((c) => c.checkNumber === release.checkNumber)
  const narrowed = same.length > 1 && release.companyCodes.length === 1
    ? same.filter((c) => c.companyCode === release.companyCodes[0])
    : same
  if (same.length === 0) return { kind: 'NOT_IN_SYSTEM' }
  if (narrowed.length === 0) return { kind: 'AMBIGUOUS', count: same.length }
  if (narrowed.length > 1) return { kind: 'AMBIGUOUS', count: narrowed.length }

  const check = narrowed[0]
  if (check.status !== 'RELEASED') return { kind: 'NOT_RELEASED_HERE', check }
  if (check.statedReleaseDate) {
    const existing = dateToDay(check.statedReleaseDate)
    if (existing === stated.day) return { kind: 'ALREADY_STATED', check }
    return { kind: 'DIFFERENT_DATE_STATED', check, stated: existing, day: stated.day }
  }
  return { kind: 'WRITE', check, day: stated.day }
}

export type StatedPlan = {
  file: string
  /** The last acceptable stated day — the Manila day the plan was made. */
  latest: string
  toWrite: { release: RegisterRelease; check: Candidate; day: string }[]
  counts: Record<Exclude<Verdict['kind'], 'WRITE'>, number>
  /** What a human should look at: everything left alone for a stated reason. */
  listed: { checkNumber: string; kind: Verdict['kind']; detail: string }[]
  reading: RegisterReading
}

export async function planStatedReleaseDates(
  db: PrismaClient, file: string, raw: RawRow[], ref: CompanyReferenceData, now: Date,
): Promise<StatedPlan> {
  const latest = manilaDay(now)
  const reading = readRegisterReleases(raw, ref)
  const numbers = reading.released.map((r) => r.checkNumber)

  const found = await db.check.findMany({
    where: { checkNumber: { in: numbers } },
    select: { id: true, checkNumber: true, status: true, statedReleaseDate: true, company: { select: { code: true } } },
  })
  const byNumber = new Map<string, Candidate[]>()
  for (const f of found) {
    const c: Candidate = {
      id: f.id, checkNumber: f.checkNumber, companyCode: f.company.code,
      status: f.status, statedReleaseDate: f.statedReleaseDate,
    }
    byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), c])
  }

  const plan: StatedPlan = {
    file,
    latest,
    toWrite: [],
    counts: {
      NOT_IN_SYSTEM: 0, AMBIGUOUS: 0, NOT_RELEASED_HERE: 0, ALREADY_STATED: 0,
      DIFFERENT_DATE_STATED: 0, CONFLICTING_DATES: 0, NO_USABLE_DATE: 0,
    },
    listed: [],
    reading,
  }
  for (const release of reading.released) {
    const v = judge(release, byNumber.get(release.checkNumber) ?? [], latest)
    if (v.kind === 'WRITE') { plan.toWrite.push({ release, check: v.check, day: v.day }); continue }
    plan.counts[v.kind]++
    switch (v.kind) {
      case 'NOT_RELEASED_HERE':
        plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: v.check.status }); break
      case 'DIFFERENT_DATE_STATED':
        plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: `${v.stated} here, ${v.day} in the file` }); break
      case 'CONFLICTING_DATES':
        plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: v.days.join(' / ') }); break
      case 'NO_USABLE_DATE':
        // A blank cell states nothing and needs nobody's eyes; text does.
        if (v.verbatim.length > 0) plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: v.verbatim.join(' / ') })
        break
      default:
        break
    }
  }
  return plan
}

/** Every cheque about to change, as it stands — CLAUDE.md item 7, built in. */
export function snapshotOf(plan: StatedPlan, takenAt: Date) {
  return {
    takenAt: takenAt.toISOString(),
    file: plan.file,
    rows: plan.toWrite.map(({ check }) => ({
      id: check.id, checkNumber: check.checkNumber, companyCode: check.companyCode,
      status: check.status, statedReleaseDate: check.statedReleaseDate?.toISOString() ?? null,
    })),
  }
}

export async function applyStatedReleaseDates(
  db: PrismaClient, plan: StatedPlan,
): Promise<{ written: number; raced: number }> {
  let written = 0
  let raced = 0
  for (const { release, check, day } of plan.toWrite) {
    await db.$transaction(async (tx) => {
      // The planned state re-asserted: still RELEASED, still no stated day. A
      // cheque somebody changed between the plan and now matches nothing.
      const { count } = await tx.check.updateMany({
        where: { id: check.id, status: 'RELEASED', statedReleaseDate: null },
        data: { statedReleaseDate: dayToDate(day) },
      })
      if (count === 0) { raced++; return }
      await writeAudit(tx, {
        checkId: check.id,
        actorType: 'SYSTEM',
        action: STATED_RELEASE_DATE_ACTION,
        details: {
          file: plan.file,
          statedReleaseDate: day,
          registerRows: release.rows,
        },
        remarks:
          `${plan.file} states DATE RELEASED ${day} for this check (${release.rows.map((r) => `${r.sheet} row ${r.row}`).join(', ')}). ` +
          'Recorded as the stated release day on the request of 2026-09-28 so the DATE RELEASED filter can find it. ' +
          'Only statedReleaseDate was written; releasedAt, releasedById and the status are untouched — ' +
          'the app did not record this release and does not claim to have.',
      })
      written++
    }, TX_OPTIONS)
  }
  return { written, raced }
}
