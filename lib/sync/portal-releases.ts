import { Prisma, type PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { canonicalCheckNumber } from '@/lib/import/normalise'
import { PORTAL_RELEASES_MODE } from '@/lib/sync/modes'
import type { PortalRelease, PortalReleasesReader, RejectedRelease } from '@/lib/integrations/portal/releases'

/**
 * THE PORTAL RELEASES READ (spec 2026-10-19-portal-releases-read-back-design.md; rules 5 and 12 as
 * rewritten that day). Checks released on the Supplier Portal — handed to the vendor — become
 * RELEASED here, with the portal's release instant (or day) and OR. Match on canonical check number
 * AND a shared APV (numbers are reused: 1791379613, 2026-10-19). A live check is released in its own
 * transaction, conditional on the status it was read in; CANCELLED / VOIDED here, no match, two
 * matches, or a release from before go-live are listed for a person. No PortalEvent is written: the
 * portal already has the release. Rows this app itself sent (`releasedByService`) are skipped as the
 * echo.
 *
 * The look list lasts (final review 2026-10-19): each item is one SYSTEM audit row
 * (`portal_release_needs_look`), written once per (domain, releaseId, kind). Every run re-decides the
 * open NOT_FOUND / AMBIGUOUS items from their stored details, so a check whose APV is linked later
 * is released then. `/admin/portal` lists the open items (listOpenPortalReleaseLooks).
 */
type Db = PrismaClient | Prisma.TransactionClient
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const PAGE = 500
const OVERLAP_MS = 10 * 60_000
const LIVE = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const
const DEAD = ['CANCELLED', 'VOIDED'] as const
/** Re-decided each run: open NOT_FOUND / AMBIGUOUS items from this many days back, at most this many. */
const REEVALUATE_DAYS = 60
const REEVALUATE_MAX = 200

export const PORTAL_RELEASES_FIRST_SINCE = new Date('2026-10-19T00:00:00+08:00')
export const RELEASED_ON_PORTAL_ACTION = 'released_on_supplier_portal'
export const NEEDS_LOOK_ACTION = 'portal_release_needs_look'
export const RECEIPT_FROM_PORTAL_ACTION = 'receipt_from_supplier_portal'

export type LookKind = 'DEAD_HERE' | 'NOT_FOUND' | 'AMBIGUOUS' | 'BEFORE_GO_LIVE'
export type Look = {
  kind: LookKind; domain: PortalRelease['domain']; releaseId: number; checkNumber: string; apvNumbers: string[]
  detail: string; checkId: string | null
}
export type PortalReleasesResult = {
  syncRunId: string; read: number; echo: number; released: number; healed: number; already: number; receipts: number
  look: Look[]; rejected: RejectedRelease[]; errors: number; stoppedAtDeadline: boolean; watermark: Date | null
}

export async function lastPortalReleasesWatermark(db: Db): Promise<Date | null> {
  const r = await db.syncRun.findFirst({
    where: { mode: PORTAL_RELEASES_MODE, watermark: { not: null } }, orderBy: { startedAt: 'desc' }, select: { watermark: true },
  })
  return r?.watermark ?? null
}

const dayDate = (d: string) => new Date(`${d}T00:00:00.000Z`)

/** A release recorded before releasing moved to the portal (I4): never replayed onto a check here. */
function beforeGoLive(r: PortalRelease): boolean {
  const at = r.releasedAt ?? (r.releaseDate ? dayDate(r.releaseDate) : null)
  return at !== null && at < PORTAL_RELEASES_FIRST_SINCE
}

function message(
  look: readonly Look[], problems: readonly string[], echo: number,
  extra: { healed: number; receipts: number; rejected: readonly RejectedRelease[]; stopped: boolean },
): string | null {
  const parts: string[] = []
  if (extra.stopped) parts.push('stopped at the time budget; the rest is read next run')
  if (echo) parts.push(`${echo} echo (sent from here) skipped`)
  if (extra.healed) parts.push(`${extra.healed} earlier look item(s) released`)
  if (extra.receipts) parts.push(`${extra.receipts} OR(s) taken onto checks already released`)
  for (const kind of ['DEAD_HERE', 'NOT_FOUND', 'AMBIGUOUS', 'BEFORE_GO_LIVE'] as const) {
    const xs = look.filter((l) => l.kind === kind)
    if (xs.length) parts.push(`${kind} ${xs.length}: ${xs.slice(0, 10).map((l) => l.checkNumber).join(', ')}`)
  }
  if (extra.rejected.length) {
    parts.push(`rejected ${extra.rejected.length}: ${extra.rejected.slice(0, 10).map((x) => `${x.domain}#${x.releaseId}`).join(', ')}`)
  }
  if (problems.length) parts.push(`errors: ${[...new Set(problems)].slice(0, 5).join(' | ')}`)
  return parts.length ? parts.join(' · ').slice(0, 1000) : null
}

export async function runPortalReleasesSync(
  db: PrismaClient,
  args: { reader: PortalReleasesReader; since: Date | null; now: Date; trigger: 'MANUAL' | 'SCHEDULED'; deadline?: Date },
): Promise<PortalReleasesResult> {
  const since = args.since ?? PORTAL_RELEASES_FIRST_SINCE
  const run = await db.syncRun.create({ data: { mode: PORTAL_RELEASES_MODE, startedAt: args.now, trigger: args.trigger } })
  let read = 0, echo = 0, released = 0, healed = 0, already = 0, receipts = 0, errors = 0
  let stopped = false
  const look: Look[] = []
  const rejected: RejectedRelease[] = []
  const problems: string[] = []
  const seenKeys = new Set<string>()
  let maxSeen: Date | null = null
  const pastDeadline = () => !!args.deadline && Date.now() >= args.deadline.getTime()

  const finish = (watermark: Date | null) => db.syncRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(), imported: released, updated: already, staged: look.length, errors, watermark,
      message: message(look, problems, echo, { healed, receipts, rejected, stopped }),
    },
  })

  const apply = async (r: PortalRelease, fromLook: boolean) => {
    try {
      const outcome = await applyOne(db, r)
      if (outcome === 'RELEASED') { released++; if (fromLook) healed++ }
      else if (outcome === 'ALREADY') already++
      else if (outcome === 'RECEIPT') { already++; receipts++ }
      else {
        await recordLook(db, outcome, r)
        if (!fromLook) look.push(outcome)
      }
    } catch (e) {
      errors++
      problems.push(`${r.checkNumber}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
    }
  }

  let cursor = since
  try {
    let first = true
    pages: for (;;) {
      // Between pages (I3). The first page is always read, so every run makes progress.
      if (!first && pastDeadline()) { stopped = true; break }
      first = false
      const page = await args.reader.list(cursor, PAGE)
      rejected.push(...(page.rejected ?? []))
      for (let i = 0; i < page.rows.length; i++) {
        // Between rows (I3). Rows arrive in updatedAt order, so the watermark from the rows done so
        // far, minus the overlap, re-reads everything not yet done.
        if (i > 0 && pastDeadline()) { stopped = true; break pages }
        const r = page.rows[i]
        read++
        if (!maxSeen || r.updatedAt > maxSeen) maxSeen = r.updatedAt
        if (r.releasedByService) { echo++; continue }
        seenKeys.add(`${r.domain}:${r.releaseId}`)
        await apply(r, false)
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

  // The open NOT_FOUND / AMBIGUOUS items of earlier runs, re-decided from their stored details (I2).
  if (!stopped) {
    try {
      const open = await openLooks(db, {
        from: new Date(args.now.getTime() - REEVALUATE_DAYS * 86_400_000), kinds: ['NOT_FOUND', 'AMBIGUOUS'], limit: REEVALUATE_MAX,
      })
      for (const item of open) {
        if (pastDeadline()) { stopped = true; break }
        if (seenKeys.has(`${item.domain}:${item.releaseId}`)) continue
        await apply(releaseFromLook(item), true)
      }
    } catch (e) {
      errors++
      problems.push(`re-evaluating look items: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
    }
  }

  const watermark = errors > 0 || !maxSeen ? null : new Date(maxSeen.getTime() - OVERLAP_MS)
  await finish(watermark)
  return { syncRunId: run.id, read, echo, released, healed, already, receipts, look, rejected, errors, stoppedAtDeadline: stopped, watermark }
}

const MAX_TRIES = 3
type Outcome = 'RELEASED' | 'ALREADY' | 'RECEIPT' | Look

async function applyOne(db: PrismaClient, r: PortalRelease): Promise<Outcome> {
  const number = canonicalCheckNumber(r.checkNumber) ?? r.checkNumber
  const apvs = new Set(r.apvNumbers.map((a) => a.toUpperCase()))
  const pre = beforeGoLive(r)
  const lookOf = (kind: LookKind, detail: string, checkId: string | null = null): Look =>
    ({ kind, domain: r.domain, releaseId: r.releaseId, checkNumber: number, apvNumbers: r.apvNumbers, detail, checkId })
  const preLook = () => lookOf('BEFORE_GO_LIVE', `released on the portal ${r.releaseDate ?? r.releasedAt?.toISOString() ?? ''}, before releasing moved to the portal; not replayed`)
  // A conditional write that matches nothing means Finance (or a receipt) got there between our read
  // and our write. Decide again from what is there now; the watermark would otherwise move past this
  // row for good. After MAX_TRIES we throw, so the row counts as an error and the watermark is held.
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const same = await db.check.findMany({
      where: { checkNumber: number },
      select: { id: true, status: true, orNumber: true, apvNumbers: true, bills: { select: { apvNumber: true } } },
    })
    const matched = same.filter((c) => [...c.apvNumbers, ...c.bills.map((b) => b.apvNumber)].some((a) => apvs.has(a.toUpperCase())))
    // CANCELLED / VOIDED checks are set aside first: a re-issue on the same number and APV decides.
    const isDead = (s: string) => (DEAD as readonly string[]).includes(s)
    const dead = matched.filter((c) => isDead(c.status))
    const usable = matched.filter((c) => !isDead(c.status))
    if (usable.length > 1) return pre ? preLook() : lookOf('AMBIGUOUS', `${usable.length} checks with this number pay these APVs`)
    if (usable.length === 0) {
      if (pre) return preLook()
      if (dead.length) return lookOf('DEAD_HERE', `${dead[0].status} here, released on the portal ${r.releaseDate ?? ''}`.trim(), dead[0].id)
      return lookOf('NOT_FOUND', same.length ? `${same.length} check(s) with this number, none paying ${r.apvNumbers.join(', ')}` : 'no check with this number')
    }
    const c = usable[0]
    if (c.status === 'RELEASED') {
      // I5: an OR typed on the portal after the release, onto a check with no receipt only (rule 11).
      if (pre || c.orNumber || !r.orNumber) return 'ALREADY'
      return (await takeReceipt(db, c.id, r)) ? 'RECEIPT' : 'ALREADY'
    }
    if (!(LIVE as readonly string[]).includes(c.status)) return lookOf('DEAD_HERE', `${c.status} here, released on the portal ${r.releaseDate ?? ''}`.trim(), c.id)
    if (pre) return preLook()

    const takeOr = !c.orNumber && !!r.orNumber
    const done = await db.$transaction(async (tx) => {
      const moved = await tx.check.updateMany({
        // rule 11: a receipt recorded since the read makes this match nothing; the retry re-decides.
        where: { id: c.id, status: c.status, ...(takeOr ? { orNumber: null } : {}) },
        data: {
          status: 'RELEASED',
          releasedById: null,
          ...(r.releasedAt ? { releasedAt: r.releasedAt } : r.releaseDate ? { statedReleaseDate: dayDate(r.releaseDate) } : {}),
          ...(takeOr ? { orNumber: r.orNumber, orDate: r.orDate ? dayDate(r.orDate) : null, receiptType: null } : {}),
        },
      })
      if (!moved.count) return false
      await writeAudit(tx, {
        checkId: c.id, actorType: 'SYSTEM', action: RELEASED_ON_PORTAL_ACTION,
        details: {
          from: c.status, to: 'RELEASED', domain: r.domain, releaseId: r.releaseId, releaseDate: r.releaseDate,
          releasedAt: r.releasedAt?.toISOString() ?? null, orNumber: r.orNumber, orDate: r.orDate,
          receiptTaken: takeOr, releasedByName: r.releasedByName,
        },
        remarks: `Released on the Supplier Portal${r.releasedByName ? ` by ${r.releasedByName}` : ''}${r.releaseDate ? ` on ${r.releaseDate}` : ''}. Read back by the PORTAL RELEASES read (rule 5, 2026-10-19).`,
      })
      return true
    }, TX_OPTIONS)
    if (done) return 'RELEASED'
  }
  throw new Error(`release of ${number} raced ${MAX_TRIES} times; will be re-read`)
}

/** The portal's OR onto a RELEASED check that has none (I5). Conditional, so a receipt recorded here wins. */
async function takeReceipt(db: PrismaClient, checkId: string, r: PortalRelease): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const m = await tx.check.updateMany({
      where: { id: checkId, status: 'RELEASED', orNumber: null },
      data: { orNumber: r.orNumber, orDate: r.orDate ? dayDate(r.orDate) : null, receiptType: null },
    })
    if (!m.count) return false
    await writeAudit(tx, {
      checkId, actorType: 'SYSTEM', action: RECEIPT_FROM_PORTAL_ACTION,
      details: { domain: r.domain, releaseId: r.releaseId, orNumber: r.orNumber, orDate: r.orDate, releasedByName: r.releasedByName },
      remarks: 'OR recorded on the Supplier Portal after the release. Read back by the PORTAL RELEASES read (rule 11: a receipt is never overwritten).',
    })
    return true
  }, TX_OPTIONS)
}

/** One audit row per (domain, releaseId, kind): an overlap replay or a re-evaluation writes nothing new. */
async function recordLook(db: PrismaClient, l: Look, r: PortalRelease): Promise<void> {
  const exists = await db.auditLog.findFirst({
    where: {
      action: NEEDS_LOOK_ACTION,
      AND: [
        { details: { path: ['domain'], equals: l.domain } },
        { details: { path: ['releaseId'], equals: l.releaseId } },
        { details: { path: ['kind'], equals: l.kind } },
      ],
    },
    select: { id: true },
  })
  if (exists) return
  await writeAudit(db, {
    ...(l.kind === 'DEAD_HERE' && l.checkId ? { checkId: l.checkId } : {}),
    actorType: 'SYSTEM', action: NEEDS_LOOK_ACTION,
    details: {
      kind: l.kind, domain: l.domain, releaseId: l.releaseId, checkNumber: l.checkNumber, apvNumbers: l.apvNumbers,
      releaseDate: r.releaseDate, releasedAt: r.releasedAt?.toISOString() ?? null, orNumber: r.orNumber, orDate: r.orDate,
      releasedByName: r.releasedByName, detail: l.detail,
    },
    remarks: `Released on the Supplier Portal, not released here: ${l.kind}. ${l.detail}.`,
  })
}

export type OpenLook = {
  id: string; createdAt: Date; checkId: string | null; kind: LookKind; domain: PortalRelease['domain']; releaseId: number
  checkNumber: string; apvNumbers: string[]; releaseDate: string | null; releasedAt: string | null
  orNumber: string | null; orDate: string | null; releasedByName: string | null; detail: string | null
}

/**
 * The open look items: the newest item per (domain, releaseId), when no `released_on_supplier_portal`
 * row for the same release was written after it. Newest first.
 */
async function openLooks(db: Db, args: { from?: Date; kinds?: readonly LookKind[]; limit: number }): Promise<OpenLook[]> {
  const from = args.from ? Prisma.sql`and l."createdAt" >= ${args.from}` : Prisma.empty
  const kinds = args.kinds?.length ? Prisma.sql`and x.details->>'kind' in (${Prisma.join([...args.kinds])})` : Prisma.empty
  const rows = await db.$queryRaw<{ id: string; createdAt: Date; checkId: string | null; details: Prisma.JsonValue }[]>`
    select x.id, x."createdAt", x."checkId", x.details from (
      select distinct on (l.details->>'domain', l.details->>'releaseId') l.id, l."createdAt", l."checkId", l.details
      from "AuditLog" l
      where l.action = ${NEEDS_LOOK_ACTION} ${from}
      order by l.details->>'domain', l.details->>'releaseId', l."createdAt" desc, l.id desc
    ) x
    where not exists (
      select 1 from "AuditLog" r
      where r.action = ${RELEASED_ON_PORTAL_ACTION}
        and r.details->>'domain' = x.details->>'domain'
        and r.details->>'releaseId' = x.details->>'releaseId'
        and r."createdAt" > x."createdAt"
    ) ${kinds}
    order by x."createdAt" desc, x.id desc
    limit ${args.limit}`
  return rows.map((row) => {
    const d = (row.details ?? {}) as Record<string, unknown>
    const s = (v: unknown) => (typeof v === 'string' ? v : null)
    return {
      id: row.id, createdAt: row.createdAt, checkId: row.checkId,
      kind: d.kind as LookKind, domain: d.domain as PortalRelease['domain'], releaseId: Number(d.releaseId),
      checkNumber: s(d.checkNumber) ?? '',
      apvNumbers: Array.isArray(d.apvNumbers) ? d.apvNumbers.filter((a): a is string => typeof a === 'string') : [],
      releaseDate: s(d.releaseDate), releasedAt: s(d.releasedAt), orNumber: s(d.orNumber), orDate: s(d.orDate),
      releasedByName: s(d.releasedByName), detail: s(d.detail),
    }
  })
}

/** `/admin/portal`'s list: every open look item, across runs, newest first. */
export function listOpenPortalReleaseLooks(db: Db, limit = 200): Promise<OpenLook[]> {
  return openLooks(db, { limit })
}

function releaseFromLook(l: OpenLook): PortalRelease {
  return {
    domain: l.domain, releaseId: l.releaseId, checkNumber: l.checkNumber, apvNumbers: l.apvNumbers,
    releaseDate: l.releaseDate, releasedAt: l.releasedAt ? new Date(l.releasedAt) : null,
    orNumber: l.orNumber, orDate: l.orDate, releasedByName: l.releasedByName, releasedByService: false, updatedAt: l.createdAt,
  }
}

export type ScheduledPortalReleasesOutcome =
  | { outcome: 'RAN'; syncRunId: string; released: number; already: number; look: number; errors: number }
  | { outcome: 'SKIPPED_NOT_CONFIGURED' }
  | { outcome: 'SKIPPED_TIME_BUDGET' }
  | { outcome: 'FAILED'; message: string }

/** The cron's and SYNC NOW's entry point. Never throws. */
export async function runScheduledPortalReleases(
  db: PrismaClient, args: { now: Date; reader: () => PortalReleasesReader; deadline?: Date },
): Promise<ScheduledPortalReleasesOutcome> {
  let reader: PortalReleasesReader
  try { reader = args.reader() } catch { return { outcome: 'SKIPPED_NOT_CONFIGURED' } }
  try {
    const since = await lastPortalReleasesWatermark(db)
    const r = await runPortalReleasesSync(db, { reader, since, now: args.now, trigger: 'SCHEDULED', deadline: args.deadline })
    return { outcome: 'RAN', syncRunId: r.syncRunId, released: r.released, already: r.already, look: r.look.length, errors: r.errors }
  } catch (e) {
    return { outcome: 'FAILED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
  }
}
