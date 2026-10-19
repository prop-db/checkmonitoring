import { Prisma, type PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { canonicalCheckNumber } from '@/lib/import/normalise'
import { PORTAL_RELEASES_MODE } from '@/lib/sync/modes'
import type { PortalRelease, PortalReleaseStatus, PortalReleasesReader, RejectedRelease } from '@/lib/integrations/portal/releases'

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
 * The look list (final review and re-review 2026-10-19): each item is one SYSTEM audit row
 * (`portal_release_needs_look`). An item is open until a later row for the same (domain, releaseId)
 * closes it: `released_on_supplier_portal`, `portal_release_look_closed` (re-evaluated and found
 * already released here, or no longer released on the portal) or `portal_release_look_dismissed`
 * (a FINANCE_ADMIN, with a reason). Every run re-decides the open NOT_FOUND / AMBIGUOUS items on the
 * portal's CURRENT state of each release (the reader's `statuses`), never on the stored copy.
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
/** A portal call never waits longer than this, nor past the deadline. */
const CALL_TIMEOUT_MS = 15_000
/** No new call to the portal starts this close to the deadline. */
const NO_NEW_CALL_WITHIN_MS = 5_000

export const PORTAL_RELEASES_FIRST_SINCE = new Date('2026-10-19T00:00:00+08:00')
export const RELEASED_ON_PORTAL_ACTION = 'released_on_supplier_portal'
export const NEEDS_LOOK_ACTION = 'portal_release_needs_look'
export const RECEIPT_FROM_PORTAL_ACTION = 'receipt_from_supplier_portal'
export const LOOK_CLOSED_ACTION = 'portal_release_look_closed'
export const LOOK_DISMISSED_ACTION = 'portal_release_look_dismissed'
/** Rows that close a look item written before them for the same (domain, releaseId). */
const CLOSING_ACTIONS = [RELEASED_ON_PORTAL_ACTION, LOOK_CLOSED_ACTION, LOOK_DISMISSED_ACTION] as const

export type LookKind = 'DEAD_HERE' | 'NOT_FOUND' | 'AMBIGUOUS' | 'BEFORE_GO_LIVE'
export type LookCloseOutcome = 'ALREADY' | 'RECEIPT' | 'NO_LONGER_RELEASED_ON_PORTAL'
export type Look = {
  kind: LookKind; domain: PortalRelease['domain']; releaseId: number; checkNumber: string; apvNumbers: string[]
  detail: string; checkId: string | null
}
export type PortalReleasesResult = {
  syncRunId: string; read: number; echo: number; released: number; healed: number; already: number; receipts: number
  look: Look[]; rejected: RejectedRelease[]; errors: number; stoppedAtDeadline: boolean; watermark: Date | null
  /** Re-evaluation: items closed, errors (never holding the watermark), and why it was skipped, if it was. */
  closed: number; reevalErrors: number; reevalSkipped: string | null
}

export async function lastPortalReleasesWatermark(db: Db): Promise<Date | null> {
  const r = await db.syncRun.findFirst({
    where: { mode: PORTAL_RELEASES_MODE, watermark: { not: null } }, orderBy: { startedAt: 'desc' }, select: { watermark: true },
  })
  return r?.watermark ?? null
}

const dayDate = (d: string) => new Date(`${d}T00:00:00.000Z`)
const keyOf = (k: { domain: string; releaseId: number }) => `${k.domain}:${k.releaseId}`
const errText = (e: unknown, n: number) => (e instanceof Error ? e.message.slice(0, n) : String(e).slice(0, n))

/** A release recorded before releasing moved to the portal (I4): never replayed onto a check here. */
function beforeGoLive(r: PortalRelease): boolean {
  const at = r.releasedAt ?? (r.releaseDate ? dayDate(r.releaseDate) : null)
  return at !== null && at < PORTAL_RELEASES_FIRST_SINCE
}

type MessageExtra = {
  healed: number; receipts: number; rejected: readonly RejectedRelease[]; stopped: boolean
  closed: number; reevalErrors: number; reevalProblems: readonly string[]; reevalSkipped: string | null
}

function message(look: readonly Look[], problems: readonly string[], echo: number, x: MessageExtra): string | null {
  const parts: string[] = []
  if (x.stopped) parts.push('stopped at the time budget; the rest is read next run')
  if (echo) parts.push(`${echo} echo (sent from here) skipped`)
  if (x.healed) parts.push(`${x.healed} earlier look item(s) released`)
  if (x.closed) parts.push(`${x.closed} look item(s) closed`)
  if (x.receipts) parts.push(`${x.receipts} OR(s) taken onto checks already released`)
  for (const kind of ['DEAD_HERE', 'NOT_FOUND', 'AMBIGUOUS', 'BEFORE_GO_LIVE'] as const) {
    const xs = look.filter((l) => l.kind === kind)
    if (xs.length) parts.push(`${kind} ${xs.length}: ${xs.slice(0, 10).map((l) => l.checkNumber).join(', ')}`)
  }
  if (x.rejected.length) {
    parts.push(`rejected ${x.rejected.length}: ${x.rejected.slice(0, 10).map((r) => `${r.domain}#${r.releaseId}`).join(', ')}`)
  }
  if (problems.length) parts.push(`errors: ${[...new Set(problems)].slice(0, 5).join(' | ')}`)
  if (x.reevalSkipped) parts.push(`re-evaluation skipped: ${x.reevalSkipped}`)
  if (x.reevalErrors) parts.push(`re-evaluation errors ${x.reevalErrors}: ${[...new Set(x.reevalProblems)].slice(0, 3).join(' | ')}`)
  return parts.length ? parts.join(' · ').slice(0, 1000) : null
}

export async function runPortalReleasesSync(
  db: PrismaClient,
  args: { reader: PortalReleasesReader; since: Date | null; now: Date; trigger: 'MANUAL' | 'SCHEDULED'; deadline?: Date },
): Promise<PortalReleasesResult> {
  const since = args.since ?? PORTAL_RELEASES_FIRST_SINCE
  const run = await db.syncRun.create({ data: { mode: PORTAL_RELEASES_MODE, startedAt: args.now, trigger: args.trigger } })
  let read = 0, echo = 0, released = 0, healed = 0, already = 0, receipts = 0, errors = 0
  let closed = 0, reevalErrors = 0
  let reevalSkipped: string | null = null
  let stopped = false
  const look: Look[] = []
  const rejected: RejectedRelease[] = []
  const problems: string[] = []
  const reevalProblems: string[] = []
  const seenKeys = new Set<string>()
  let maxSeen: Date | null = null
  const left = () => (args.deadline ? args.deadline.getTime() - Date.now() : Infinity)
  const pastDeadline = () => left() <= 0
  // min(15 s, the time left); never below 1 s, so a call made is a real attempt.
  const timeoutMs = () => Math.max(1_000, Math.min(CALL_TIMEOUT_MS, left()))

  const finish = (watermark: Date | null) => db.syncRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(), imported: released, updated: already, staged: look.length, errors, watermark,
      message: message(look, problems, echo, { healed, receipts, rejected, stopped, closed, reevalErrors, reevalProblems, reevalSkipped }),
    },
  })

  let cursor = since
  try {
    let first = true
    pages: for (;;) {
      // Between pages (I3): no new page within 5 s of the deadline. The first page is always read,
      // so every run makes progress.
      if (!first && left() < NO_NEW_CALL_WITHIN_MS) { stopped = true; break }
      first = false
      const page = await args.reader.list(cursor, PAGE, { timeoutMs: timeoutMs() })
      rejected.push(...(page.rejected ?? []))
      for (let i = 0; i < page.rows.length; i++) {
        // Between rows (I3). Rows arrive in updatedAt order, so the watermark from the rows done so
        // far, minus the overlap, re-reads everything not yet done.
        if (i > 0 && pastDeadline()) { stopped = true; break pages }
        const r = page.rows[i]
        read++
        if (!maxSeen || r.updatedAt > maxSeen) maxSeen = r.updatedAt
        if (r.releasedByService) { echo++; continue }
        seenKeys.add(keyOf(r))
        try {
          const outcome = await applyOne(db, r)
          if (!('t' in outcome)) { await recordLook(db, outcome, r); look.push(outcome) }
          else if (outcome.t === 'RELEASED') released++
          else { already++; if (outcome.t === 'RECEIPT') receipts++ }
        } catch (e) {
          errors++
          problems.push(`${r.checkNumber}: ${errText(e, 200)}`)
        }
      }
      if (!page.next) break
      cursor = page.next
    }
  } catch (e) {
    errors++
    problems.push(errText(e, 300))
    try { await finish(null) } catch { /* keep the original error */ }
    throw e
  }

  // The open NOT_FOUND / AMBIGUOUS items of earlier runs (I2), re-decided on the portal's CURRENT state
  // of each release (re-review B). Nothing here counts towards `errors`, so nothing here holds the
  // main read's watermark: a skipped or failed re-evaluation is simply tried again next run.
  if (!stopped) {
    try {
      const open = (await openLooks(db, {
        from: new Date(args.now.getTime() - REEVALUATE_DAYS * 86_400_000), kinds: ['NOT_FOUND', 'AMBIGUOUS'], limit: REEVALUATE_MAX,
      })).filter((i) => !seenKeys.has(keyOf(i)))
      let current: Map<string, PortalReleaseStatus> | null = null
      if (open.length) {
        if (!args.reader.statuses) reevalSkipped = 'the reader cannot ask the portal for current statuses'
        else if (left() < NO_NEW_CALL_WITHIN_MS) reevalSkipped = 'too close to the time budget'
        else {
          try {
            const st = await args.reader.statuses(open.map((i) => ({ domain: i.domain, releaseId: i.releaseId })), { timeoutMs: timeoutMs() })
            current = new Map(st.map((s) => [keyOf(s), s]))
          } catch (e) {
            reevalSkipped = `the portal status read failed: ${errText(e, 200)}`
          }
        }
      }
      for (const item of current ? open : []) {
        if (pastDeadline()) { stopped = true; break }
        const s = current!.get(keyOf(item))
        if (!s) continue // the portal did not answer for it: left open, asked again next run
        try {
          if (s.status !== 'RELEASED') {
            await closeLook(db, item, 'NO_LONGER_RELEASED_ON_PORTAL', null, s.status)
            closed++
            continue
          }
          // The CURRENT instant and OR; the stored copy only for what the status read does not carry.
          const r: PortalRelease = { ...releaseFromLook(item), releasedAt: s.releasedAt, orNumber: s.orNumber, orDate: s.orDate }
          const outcome = await applyOne(db, r)
          if (!('t' in outcome)) await recordLook(db, outcome, r)
          else if (outcome.t === 'RELEASED') { released++; healed++ }
          else {
            if (outcome.t === 'RECEIPT') receipts++
            await closeLook(db, item, outcome.t, outcome.checkId, s.status)
            closed++
          }
        } catch (e) {
          reevalErrors++
          reevalProblems.push(`${item.checkNumber}: ${errText(e, 200)}`)
        }
      }
    } catch (e) {
      reevalErrors++
      reevalProblems.push(errText(e, 200))
    }
  }

  const watermark = errors > 0 || !maxSeen ? null : new Date(maxSeen.getTime() - OVERLAP_MS)
  await finish(watermark)
  return {
    syncRunId: run.id, read, echo, released, healed, already, receipts, look, rejected, errors,
    stoppedAtDeadline: stopped, watermark, closed, reevalErrors, reevalSkipped,
  }
}

const MAX_TRIES = 3
type Done = { t: 'RELEASED' | 'ALREADY' | 'RECEIPT'; checkId: string }

async function applyOne(db: PrismaClient, r: PortalRelease): Promise<Done | Look> {
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
      if (pre || c.orNumber || !r.orNumber) return { t: 'ALREADY', checkId: c.id }
      return { t: (await takeReceipt(db, c.id, r)) ? 'RECEIPT' : 'ALREADY', checkId: c.id }
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
    if (done) return { t: 'RELEASED', checkId: c.id }
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

const releaseKeyWhere = (k: { domain: string; releaseId: number }): Prisma.AuditLogWhereInput[] => [
  { details: { path: ['domain'], equals: k.domain } },
  { details: { path: ['releaseId'], equals: k.releaseId } },
]

/**
 * One audit row per (domain, releaseId, kind) while it is open: an overlap replay or a re-evaluation
 * writes nothing new. A release whose item was closed (released, closed) and comes back is listed
 * again; a dismissed release is never listed again.
 */
async function recordLook(db: PrismaClient, l: Look, r: PortalRelease): Promise<void> {
  const key = releaseKeyWhere(l)
  if (await db.auditLog.findFirst({ where: { action: LOOK_DISMISSED_ACTION, AND: key }, select: { id: true } })) return
  const last = await db.auditLog.findFirst({
    where: { action: NEEDS_LOOK_ACTION, AND: [...key, { details: { path: ['kind'], equals: l.kind } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true },
  })
  if (last) {
    const closedSince = await db.auditLog.findFirst({
      where: { action: { in: [RELEASED_ON_PORTAL_ACTION, LOOK_CLOSED_ACTION] }, AND: key, createdAt: { gt: last.createdAt } },
      select: { id: true },
    })
    if (!closedSince) return
  }
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

/** Closes an open item (re-review A/B): one SYSTEM `portal_release_look_closed` row. */
async function closeLook(db: PrismaClient, item: OpenLook, outcome: LookCloseOutcome, checkId: string | null, portalStatus: string | null): Promise<void> {
  await writeAudit(db, {
    ...(checkId ?? item.checkId ? { checkId: (checkId ?? item.checkId)! } : {}),
    actorType: 'SYSTEM', action: LOOK_CLOSED_ACTION,
    details: { domain: item.domain, releaseId: item.releaseId, outcome, kind: item.kind, lookId: item.id, portalStatus },
    remarks: outcome === 'NO_LONGER_RELEASED_ON_PORTAL'
      ? `Portal release no longer RELEASED on the portal (${portalStatus ?? 'not found'}); taken off the look list.`
      : 'Already released here when re-evaluated; taken off the look list.',
  })
}

export type OpenLook = {
  id: string; createdAt: Date; checkId: string | null; kind: LookKind; domain: PortalRelease['domain']; releaseId: number
  checkNumber: string; apvNumbers: string[]; releaseDate: string | null; releasedAt: string | null
  orNumber: string | null; orDate: string | null; releasedByName: string | null; detail: string | null
}

/**
 * The open look items: the newest item per (domain, releaseId), when no closing row
 * (CLOSING_ACTIONS) for the same release was written after it. Newest first.
 */
async function openLooks(
  db: Db, args: { from?: Date; kinds?: readonly LookKind[]; key?: { domain: string; releaseId: number }; limit: number },
): Promise<OpenLook[]> {
  const from = args.from ? Prisma.sql`and l."createdAt" >= ${args.from}` : Prisma.empty
  const key = args.key
    ? Prisma.sql`and l.details->>'domain' = ${args.key.domain} and l.details->>'releaseId' = ${String(args.key.releaseId)}`
    : Prisma.empty
  const kinds = args.kinds?.length ? Prisma.sql`and x.details->>'kind' in (${Prisma.join([...args.kinds])})` : Prisma.empty
  const rows = await db.$queryRaw<{ id: string; createdAt: Date; checkId: string | null; details: Prisma.JsonValue }[]>`
    select x.id, x."createdAt", x."checkId", x.details from (
      select distinct on (l.details->>'domain', l.details->>'releaseId') l.id, l."createdAt", l."checkId", l.details
      from "AuditLog" l
      where l.action = ${NEEDS_LOOK_ACTION} ${from} ${key}
      order by l.details->>'domain', l.details->>'releaseId', l."createdAt" desc, l.id desc
    ) x
    where not exists (
      select 1 from "AuditLog" r
      where r.action in (${Prisma.join([...CLOSING_ACTIONS])})
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

/**
 * A FINANCE_ADMIN takes an open item off the list, with a reason (re-review A). The caller checks the
 * role; this checks the item is still open and writes one USER `portal_release_look_dismissed` row.
 * A dismissed item is never re-evaluated and never listed again.
 */
export async function dismissPortalReleaseLook(
  db: PrismaClient, args: { lookId: string; reason: string; userId: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const reason = args.reason.trim()
  if (!reason) return { ok: false, message: 'A reason is required to dismiss an item.' }
  if (reason.length > 500) return { ok: false, message: 'The reason is longer than 500 characters.' }
  const row = await db.auditLog.findUnique({ where: { id: args.lookId } })
  if (!row || row.action !== NEEDS_LOOK_ACTION) return { ok: false, message: 'That item is not on the list.' }
  const d = (row.details ?? {}) as Record<string, unknown>
  const domain = typeof d.domain === 'string' ? d.domain : ''
  const releaseId = Number(d.releaseId)
  const open = await openLooks(db, { key: { domain, releaseId }, limit: 1 })
  if (open.length === 0 || open[0].id !== row.id) return { ok: false, message: 'That item is no longer open.' }
  await writeAudit(db, {
    ...(row.checkId ? { checkId: row.checkId } : {}),
    actorType: 'USER', userId: args.userId, action: LOOK_DISMISSED_ACTION,
    details: { domain, releaseId, kind: open[0].kind, reason, lookId: row.id },
    remarks: `Portal release look item dismissed: ${reason}`,
  })
  return { ok: true }
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
