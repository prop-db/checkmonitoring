import type { CheckStatus, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import type { CompanyReferenceData } from '@/lib/import/company'
import { resolveImpliedStatus } from '@/lib/import/implied-status'
import { mapParsedRow } from '@/lib/import/map-row'
import { excelSerialToDate } from '@/lib/import/normalise'
import { parseRows } from '@/lib/import/parse'
import type { RawRow } from '@/lib/import/workbook'

/**
 * Record as RELEASED the cheques a later copy of the register shows picked up.
 *
 * WHY THIS EXISTS AT ALL, given CLAUDE.md's "no more updating thru excel". The
 * register was retired on 2026-09-10, but Finance kept filling its RELEASED
 * sheets: `CHECK MONITORING 9.24.2026.xlsx` carries hundreds more released rows
 * than the 9 September load. Those hand-overs happened; the app does not know.
 * The user asked on 2026-09-24 for the checks picked up to be updated from the
 * new file, and this is that — a one-off catch-up, not a routine import path.
 *
 * WHY NOT RE-RUN THE IMPORT. Rule 4: an import never changes a cheque's status.
 * `IMMUTABLE_ON_UPDATE` would keep every one of these where it is, correctly.
 *
 * WHAT COUNTS AS PICKED UP. A cheque whose register rows, across EVERY sheet,
 * resolve to RELEASED under Finance's own rulings (`resolveImpliedStatus`) — so
 * a cheque on both a RELEASED and the CANCELLED sheet gets exactly the verdict
 * the historical load gave it, and a combination nobody has ruled on is
 * reported and left alone rather than guessed.
 *
 * WHAT IT WRITES. `status = RELEASED`, one SYSTEM audit row carrying the sheet,
 * row and the register's DATE RELEASED as the register stated it. Only the
 * status: this touches no amount, no company, no payee — "Acumatica wins" is
 * untouched because nothing the ERP owns is written.
 *
 * WHAT IT WILL NOT TOUCH.
 *   - A cheque already RELEASED, CANCELLED or VOIDED here.
 *   - A cheque Acumatica reports `Voided`. A void is the ERP's fact and a
 *     spreadsheet row does not overrule it.
 *   - A register cheque that matches no cheque here, or more than one. The
 *     Acumatica sync is the only way a cheque arrives; this creates nothing.
 *   - `releasedAt` / `releasedById` stay null, as on all 9,594 cheques released
 *     before the app recorded releases: `lib/recon/outstanding.ts` reads
 *     `releasedAt` as "the app recorded the release", and none did. The
 *     register's date is kept, verbatim, in the audit row.
 *   - No portal event in this transaction. The portal has been connected since
 *     2026-09-26, so the scripts that call this then run queueReleasedForStale
 *     (lib/admin/portal-backlog.ts), which queues RELEASED for every cheque
 *     the portal was told was available, once a release day is known (user
 *     report 2026-10-06: 4 cheques stayed Available in the portal).
 *
 * THE LADDER IS BYPASSED, as in `scripts/backfill-closed-released.ts` and for
 * the same reason: walking a cheque up through SIGNED and READY_FOR_RELEASE
 * would write audit rows asserting a signing and an approval nobody performed
 * here. The audit row says plainly that it records a destination.
 */

export const RELEASED_FROM_REGISTER_ACTION = 'backfilled_released_from_register'

/** Statuses a picked-up cheque may be moved from. Everything else is left. */
const MOVABLE: readonly CheckStatus[] = [
  'GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED',
]

/** Same override as `lib/import/upsert.ts` — see CLAUDE.md on Prisma's defaults. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

/** Column K on every RELEASED sheet, headed DATE RELEASED (FT & MC: DATE RELEASE). */
const DATE_RELEASED_COLUMN = 10

export type RegisterRelease = {
  checkNumber: string
  /** Every company the cheque's rows resolved to; usually exactly one. */
  companyCodes: string[]
  /** The RELEASED-sheet rows, for the audit row and for a human to go and look. */
  rows: { sheet: string; row: number; dateReleased: string | null }[]
}

export type RegisterReading = {
  released: RegisterRelease[]
  /** Cheques whose sheets clash in a way Finance has not ruled on. */
  unruled: { checkNumber: string; sheets: string[] }[]
  /** On a RELEASED sheet but resolving to something else (e.g. the CANCELLED ruling). */
  overruled: number
}

/** What the register wrote under DATE RELEASED, as a day, or verbatim. Never guessed. */
function statedDate(row: RawRow): string | null {
  const header = String(row.header?.[DATE_RELEASED_COLUMN] ?? '').toUpperCase()
  if (!header.includes('DATE RELEASE')) return null
  const v = row.cells[DATE_RELEASED_COLUMN]
  // ExcelJS yields an Invalid Date for a few malformed cells; that states nothing.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  if (typeof v === 'number' && v > 20_000 && v < 80_000) return excelSerialToDate(v).toISOString().slice(0, 10)
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Pure. Which cheques the register says were picked up. */
export function readRegisterReleases(raw: RawRow[], ref: CompanyReferenceData): RegisterReading {
  const { parsed } = parseRows(raw)
  const rawAt = new Map(raw.map((r) => [`${r.sheet}\u0000${r.row}`, r]))

  const byNumber = new Map<string, { sheets: string[]; companies: Set<string>; rows: RegisterRelease['rows'] }>()
  for (const p of parsed) {
    const mapped = mapParsedRow(p, ref)
    if (!mapped.checkNumber) continue
    const entry = byNumber.get(mapped.checkNumber) ?? { sheets: [], companies: new Set(), rows: [] }
    entry.sheets.push(p.sheet)
    if (mapped.companyCode) entry.companies.add(mapped.companyCode)
    if (resolveImpliedStatus([p.sheet]).status === 'RELEASED') {
      const r = rawAt.get(`${p.sheet}\u0000${p.row}`)
      entry.rows.push({ sheet: p.sheet, row: p.row, dateReleased: r ? statedDate(r) : null })
    }
    byNumber.set(mapped.checkNumber, entry)
  }

  const reading: RegisterReading = { released: [], unruled: [], overruled: 0 }
  for (const [checkNumber, e] of byNumber) {
    if (e.rows.length === 0) continue
    let status: CheckStatus
    try {
      status = resolveImpliedStatus(e.sheets).status
    } catch {
      reading.unruled.push({ checkNumber, sheets: [...new Set(e.sheets)] })
      continue
    }
    if (status !== 'RELEASED') { reading.overruled++; continue }
    reading.released.push({ checkNumber, companyCodes: [...e.companies].sort(), rows: e.rows })
  }
  return reading
}

export type Candidate = {
  id: string
  checkNumber: string
  companyCode: string
  status: CheckStatus
  acumaticaStatus: string | null
}

export type Verdict =
  | { kind: 'RELEASE'; check: Candidate }
  | { kind: 'ALREADY_RELEASED' }
  | { kind: 'CANCELLED_OR_VOIDED_HERE'; check: Candidate }
  | { kind: 'VOIDED_IN_ACUMATICA'; check: Candidate }
  | { kind: 'NOT_IN_SYSTEM' }
  | { kind: 'AMBIGUOUS'; count: number }

/**
 * Pure. Exactly one cheque here, or nothing is written.
 *
 * The cheque number is the identity; the register's company only breaks a tie.
 * Measured 2026-09-24 against the 9.24 register: 1,690 of its released cheque
 * numbers exist here exactly once but under a different company — the register
 * says STPP where Acumatica says STK 681 times, A1PP where it says A1+ 322 —
 * which is the 1,958-company finding again, and Acumatica is the one that is
 * right. Letting the register's company veto the match would leave every one of
 * them unreleased on the strength of a column known to be wrong. Where a number
 * IS on more than one cheque, the register's company must pick exactly one.
 */
export function judge(release: RegisterRelease, candidates: readonly Candidate[]): Verdict {
  const same = candidates.filter((c) => c.checkNumber === release.checkNumber)
  const narrowed = same.length > 1 && release.companyCodes.length === 1
    ? same.filter((c) => c.companyCode === release.companyCodes[0])
    : same
  if (same.length === 0) return { kind: 'NOT_IN_SYSTEM' }
  if (narrowed.length === 0) return { kind: 'AMBIGUOUS', count: same.length }
  if (narrowed.length > 1) return { kind: 'AMBIGUOUS', count: narrowed.length }
  const check = narrowed[0]
  if (check.status === 'RELEASED') return { kind: 'ALREADY_RELEASED' }
  if (!MOVABLE.includes(check.status)) return { kind: 'CANCELLED_OR_VOIDED_HERE', check }
  if (check.acumaticaStatus === 'Voided') return { kind: 'VOIDED_IN_ACUMATICA', check }
  return { kind: 'RELEASE', check }
}

export type ReleasePlan = {
  file: string
  toRelease: { release: RegisterRelease; check: Candidate }[]
  counts: Record<Exclude<Verdict['kind'], 'RELEASE'>, number>
  leftAlone: { checkNumber: string; kind: Verdict['kind']; status?: CheckStatus; acumaticaStatus?: string | null }[]
  reading: RegisterReading
}

export async function planRegisterReleases(
  db: PrismaClient, file: string, raw: RawRow[], ref: CompanyReferenceData,
): Promise<ReleasePlan> {
  const reading = readRegisterReleases(raw, ref)
  const numbers = reading.released.map((r) => r.checkNumber)

  const found = await db.check.findMany({
    where: { checkNumber: { in: numbers } },
    select: { id: true, checkNumber: true, status: true, acumaticaStatus: true, company: { select: { code: true } } },
  })
  const byNumber = new Map<string, Candidate[]>()
  for (const f of found) {
    const c: Candidate = {
      id: f.id, checkNumber: f.checkNumber, companyCode: f.company.code,
      status: f.status, acumaticaStatus: f.acumaticaStatus,
    }
    byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), c])
  }

  const plan: ReleasePlan = {
    file,
    toRelease: [],
    counts: { ALREADY_RELEASED: 0, CANCELLED_OR_VOIDED_HERE: 0, VOIDED_IN_ACUMATICA: 0, NOT_IN_SYSTEM: 0, AMBIGUOUS: 0 },
    leftAlone: [],
    reading,
  }
  for (const release of reading.released) {
    const v = judge(release, byNumber.get(release.checkNumber) ?? [])
    if (v.kind === 'RELEASE') { plan.toRelease.push({ release, check: v.check }); continue }
    plan.counts[v.kind]++
    if (v.kind !== 'ALREADY_RELEASED') {
      plan.leftAlone.push({
        checkNumber: release.checkNumber, kind: v.kind,
        ...('check' in v ? { status: v.check.status, acumaticaStatus: v.check.acumaticaStatus } : {}),
      })
    }
  }
  return plan
}

/** Every cheque about to move, as it stands — CLAUDE.md item 7, built in. */
export function snapshotOf(plan: ReleasePlan, takenAt: Date) {
  return {
    takenAt: takenAt.toISOString(),
    file: plan.file,
    rows: plan.toRelease.map(({ check }) => ({
      id: check.id, checkNumber: check.checkNumber, companyCode: check.companyCode,
      status: check.status, acumaticaStatus: check.acumaticaStatus,
    })),
  }
}

export async function applyRegisterReleases(
  db: PrismaClient, plan: ReleasePlan,
): Promise<{ released: number; raced: number }> {
  let released = 0
  let raced = 0
  for (const { release, check } of plan.toRelease) {
    await db.$transaction(async (tx) => {
      // The planned status re-asserted, so a cheque somebody moved between the
      // plan and now matches nothing and is left as they left it.
      const { count } = await tx.check.updateMany({
        where: { id: check.id, status: check.status },
        data: { status: 'RELEASED' },
      })
      if (count === 0) { raced++; return }
      await writeAudit(tx, {
        checkId: check.id,
        actorType: 'SYSTEM',
        action: RELEASED_FROM_REGISTER_ACTION,
        details: {
          from: check.status,
          to: 'RELEASED',
          file: plan.file,
          registerRows: release.rows,
          acumaticaStatusAtTheTime: check.acumaticaStatus,
        },
        remarks:
          `${plan.file} lists this cheque on a RELEASED sheet (${release.rows.map((r) => `${r.sheet} row ${r.row}`).join(', ')}). ` +
          'Recorded as picked up on the request of 2026-09-24 to update the checks picked up from that file. ' +
          'The status is set directly rather than walked up the ladder: no one signed or approved it here. ' +
          "No release date or releasing user is recorded on the cheque; the register's DATE RELEASED is kept above, as stated.",
      })
      released++
    }, TX_OPTIONS)
  }
  return { released, raced }
}
