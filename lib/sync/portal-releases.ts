import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { canonicalCheckNumber } from '@/lib/import/normalise'
import { PORTAL_RELEASES_MODE } from '@/lib/sync/modes'
import type { PortalRelease, PortalReleasesReader } from '@/lib/integrations/portal/releases'

/**
 * THE PORTAL RELEASES READ (spec 2026-10-19-portal-releases-read-back-design.md; rules 5 and 12 as
 * rewritten that day). Checks released on the Supplier Portal — handed to the vendor — become
 * RELEASED here, with the portal's release instant (or day) and OR. Match on canonical check number
 * AND a shared APV (numbers are reused: 1791379613, 2026-10-19). A live check is released in its own
 * transaction, conditional on the status it was read in; CANCELLED / VOIDED here, no match, or two
 * matches are listed for a person. No PortalEvent is written: the portal already has the release.
 * Rows this app itself sent (`releasedByService`) are skipped as the echo.
 */
type Db = PrismaClient | Prisma.TransactionClient
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const PAGE = 500
const OVERLAP_MS = 10 * 60_000
const LIVE = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const

export const PORTAL_RELEASES_FIRST_SINCE = new Date('2026-10-19T00:00:00+08:00')
export const RELEASED_ON_PORTAL_ACTION = 'released_on_supplier_portal'

export type Look = { kind: 'DEAD_HERE' | 'NOT_FOUND' | 'AMBIGUOUS'; checkNumber: string; apvNumbers: string[]; detail: string }
export type PortalReleasesResult = {
  syncRunId: string; read: number; echo: number; released: number; already: number; look: Look[]; errors: number; watermark: Date | null
}

export async function lastPortalReleasesWatermark(db: Db): Promise<Date | null> {
  const r = await db.syncRun.findFirst({
    where: { mode: PORTAL_RELEASES_MODE, watermark: { not: null } }, orderBy: { startedAt: 'desc' }, select: { watermark: true },
  })
  return r?.watermark ?? null
}

const dayDate = (d: string) => new Date(`${d}T00:00:00.000Z`)

function message(look: readonly Look[], problems: readonly string[], echo: number): string | null {
  const parts: string[] = []
  if (echo) parts.push(`${echo} echo (sent from here) skipped`)
  for (const kind of ['DEAD_HERE', 'NOT_FOUND', 'AMBIGUOUS'] as const) {
    const xs = look.filter((l) => l.kind === kind)
    if (xs.length) parts.push(`${kind} ${xs.length}: ${xs.slice(0, 10).map((l) => l.checkNumber).join(', ')}`)
  }
  if (problems.length) parts.push(`errors: ${[...new Set(problems)].slice(0, 5).join(' | ')}`)
  return parts.length ? parts.join(' · ').slice(0, 1000) : null
}

export async function runPortalReleasesSync(
  db: PrismaClient,
  args: { reader: PortalReleasesReader; since: Date | null; now: Date; trigger: 'MANUAL' | 'SCHEDULED' },
): Promise<PortalReleasesResult> {
  const since = args.since ?? PORTAL_RELEASES_FIRST_SINCE
  const run = await db.syncRun.create({ data: { mode: PORTAL_RELEASES_MODE, startedAt: args.now, trigger: args.trigger } })
  let read = 0, echo = 0, released = 0, already = 0, errors = 0
  const look: Look[] = []
  const problems: string[] = []
  let maxSeen: Date | null = null

  const finish = (watermark: Date | null) => db.syncRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), imported: released, updated: already, staged: look.length, errors, watermark, message: message(look, problems, echo) },
  })

  let cursor = since
  try {
    for (;;) {
      const page = await args.reader.list(cursor, PAGE)
      for (const r of page.rows) {
        read++
        if (!maxSeen || r.updatedAt > maxSeen) maxSeen = r.updatedAt
        if (r.releasedByService) { echo++; continue }
        try {
          const outcome = await applyOne(db, r)
          if (outcome === 'RELEASED') released++
          else if (outcome === 'ALREADY') already++
          else look.push(outcome)
        } catch (e) {
          errors++
          problems.push(`${r.checkNumber}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
        }
      }
      if (!page.next) break
      cursor = page.next
    }
  } catch (e) {
    errors++
    problems.push(e instanceof Error ? e.message.slice(0, 300) : String(e))
    try { await finish(null) } catch { /* keep the original error */ }
    throw e
  }
  const watermark = errors > 0 || !maxSeen ? null : new Date(maxSeen.getTime() - OVERLAP_MS)
  await finish(watermark)
  return { syncRunId: run.id, read, echo, released, already, look, errors, watermark }
}

const MAX_TRIES = 3

async function applyOne(db: PrismaClient, r: PortalRelease): Promise<'RELEASED' | 'ALREADY' | Look> {
  const number = canonicalCheckNumber(r.checkNumber) ?? r.checkNumber
  const apvs = new Set(r.apvNumbers.map((a) => a.toUpperCase()))
  const base = { checkNumber: number, apvNumbers: r.apvNumbers }
  // A conditional write that matches nothing means Finance (or a receipt) got there between our read
  // and our write. Decide again from what is there now; the watermark would otherwise move past this
  // row for good. After MAX_TRIES we throw, so the row counts as an error and the watermark is held.
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const same = await db.check.findMany({
      where: { checkNumber: number },
      select: { id: true, status: true, orNumber: true, apvNumbers: true, bills: { select: { apvNumber: true } } },
    })
    const matched = same.filter((c) => [...c.apvNumbers, ...c.bills.map((b) => b.apvNumber)].some((a) => apvs.has(a.toUpperCase())))
    if (matched.length === 0) return { kind: 'NOT_FOUND', ...base, detail: same.length ? `${same.length} check(s) with this number, none paying ${r.apvNumbers.join(', ')}` : 'no check with this number' }
    if (matched.length > 1) return { kind: 'AMBIGUOUS', ...base, detail: `${matched.length} checks with this number pay these APVs` }
    const c = matched[0]
    if (c.status === 'RELEASED') return 'ALREADY'
    if (!(LIVE as readonly string[]).includes(c.status)) return { kind: 'DEAD_HERE', ...base, detail: `${c.status} here, released on the portal ${r.releaseDate ?? ''}`.trim() }

    const takeReceipt = !c.orNumber && !!r.orNumber
    const done = await db.$transaction(async (tx) => {
      const moved = await tx.check.updateMany({
        // rule 11: a receipt recorded since the read makes this match nothing; the retry re-decides.
        where: { id: c.id, status: c.status, ...(takeReceipt ? { orNumber: null } : {}) },
        data: {
          status: 'RELEASED',
          releasedById: null,
          ...(r.releasedAt ? { releasedAt: r.releasedAt } : r.releaseDate ? { statedReleaseDate: dayDate(r.releaseDate) } : {}),
          ...(takeReceipt ? { orNumber: r.orNumber, orDate: r.orDate ? dayDate(r.orDate) : null, receiptType: null } : {}),
        },
      })
      if (!moved.count) return false
      await writeAudit(tx, {
        checkId: c.id, actorType: 'SYSTEM', action: RELEASED_ON_PORTAL_ACTION,
        details: {
          from: c.status, to: 'RELEASED', domain: r.domain, releaseId: r.releaseId, releaseDate: r.releaseDate,
          releasedAt: r.releasedAt?.toISOString() ?? null, orNumber: r.orNumber, orDate: r.orDate,
          receiptTaken: takeReceipt, releasedByName: r.releasedByName,
        },
        remarks: `Released on the Supplier Portal${r.releasedByName ? ` by ${r.releasedByName}` : ''}${r.releaseDate ? ` on ${r.releaseDate}` : ''}. Read back by the PORTAL RELEASES read (rule 5, 2026-10-19).`,
      })
      return true
    }, TX_OPTIONS)
    if (done) return 'RELEASED'
  }
  throw new Error(`release of ${number} raced ${MAX_TRIES} times; will be re-read`)
}

export type ScheduledPortalReleasesOutcome =
  | { outcome: 'RAN'; syncRunId: string; released: number; already: number; look: number; errors: number }
  | { outcome: 'SKIPPED_NOT_CONFIGURED' }
  | { outcome: 'SKIPPED_TIME_BUDGET' }
  | { outcome: 'FAILED'; message: string }

/** The cron's and SYNC NOW's entry point. Never throws. */
export async function runScheduledPortalReleases(
  db: PrismaClient, args: { now: Date; reader: () => PortalReleasesReader },
): Promise<ScheduledPortalReleasesOutcome> {
  let reader: PortalReleasesReader
  try { reader = args.reader() } catch { return { outcome: 'SKIPPED_NOT_CONFIGURED' } }
  try {
    const since = await lastPortalReleasesWatermark(db)
    const r = await runPortalReleasesSync(db, { reader, since, now: args.now, trigger: 'SCHEDULED' })
    return { outcome: 'RAN', syncRunId: r.syncRunId, released: r.released, already: r.already, look: r.look.length, errors: r.errors }
  } catch (e) {
    return { outcome: 'FAILED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
  }
}
