import type { CheckStatus, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { isIsoDay } from '@/lib/domain/details'
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
 * calendar day; text ("SEPT 22") is listed for a human and never parsed.
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

export type StatedDay =
  | { kind: 'DAY'; day: string }
  | { kind: 'CONFLICTING_DATES'; days: string[] }
  | { kind: 'NO_USABLE_DATE'; verbatim: string[] }

/** Pure. The one calendar day a cheque's RELEASED rows state, or why there is none. */
export function statedDay(release: RegisterRelease): StatedDay {
  const stated = release.rows.map((r) => r.dateReleased).filter((d): d is string => d !== null)
  const days = [...new Set(stated.filter(isIsoDay))].sort()
  if (days.length === 1) return { kind: 'DAY', day: days[0] }
  if (days.length > 1) return { kind: 'CONFLICTING_DATES', days }
  return { kind: 'NO_USABLE_DATE', verbatim: [...new Set(stated)] }
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
export function judge(release: RegisterRelease, candidates: readonly Candidate[]): Verdict {
  const stated = statedDay(release)
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
  toWrite: { release: RegisterRelease; check: Candidate; day: string }[]
  counts: Record<Exclude<Verdict['kind'], 'WRITE'>, number>
  /** What a human should look at: everything left alone for a stated reason. */
  listed: { checkNumber: string; kind: Verdict['kind']; detail: string }[]
  reading: RegisterReading
}

export async function planStatedReleaseDates(
  db: PrismaClient, file: string, raw: RawRow[], ref: CompanyReferenceData,
): Promise<StatedPlan> {
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
    toWrite: [],
    counts: {
      NOT_IN_SYSTEM: 0, AMBIGUOUS: 0, NOT_RELEASED_HERE: 0, ALREADY_STATED: 0,
      DIFFERENT_DATE_STATED: 0, CONFLICTING_DATES: 0, NO_USABLE_DATE: 0,
    },
    listed: [],
    reading,
  }
  for (const release of reading.released) {
    const v = judge(release, byNumber.get(release.checkNumber) ?? [])
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
          `${plan.file} states DATE RELEASED ${day} for this cheque (${release.rows.map((r) => `${r.sheet} row ${r.row}`).join(', ')}). ` +
          'Recorded as the stated release day on the request of 2026-09-28 so the DATE RELEASED filter can find it. ' +
          'Only statedReleaseDate was written; releasedAt, releasedById and the status are untouched — ' +
          'the app did not record this release and does not claim to have.',
      })
      written++
    }, TX_OPTIONS)
  }
  return { written, raced }
}
