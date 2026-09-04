'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { markSigned, markReadyForRelease, markReleased } from '@/lib/domain/actions'
import { parseSelection } from '@/lib/bulk'

/**
 * The spec's §13.1 minimum-click workflow: tick several cheques, press one
 * button.
 *
 * **Every cheque is processed independently, in its own transaction.** A batch
 * is a convenience for the user, never a unit of work: one cheque that cannot
 * be signed must not stop the other forty-nine that can, and a single
 * transaction around the lot would roll back real, valid releases because of an
 * unrelated refusal. The price is that a batch can end half-applied — which is
 * why the result carries a line per cheque rather than a verdict for the batch.
 *
 * **The refusal wording is the domain's own.** `lib/domain/` returns sentences
 * written for a Finance user ("required information is missing: AMOUNT"), and
 * they are passed through untouched. A generic "some cheques failed" would tell
 * somebody holding a stack of paper nothing about which one to go and look at.
 *
 * **Nothing here changes a status.** These actions call `lib/domain/actions.ts`
 * once per cheque and it does the work: the guards, the status, the audit row
 * and the portal event, all in one transaction. A second write path would be
 * one that could forget the audit row.
 *
 * **Authorisation failures RETURN, they never redirect.** `requireAdmin`
 * redirects, Next implements a redirect by throwing, and `runEach`'s catch
 * would swallow it and report "Something went wrong" on an action the user is
 * not entitled to. Same pattern as `revertAction` in `./actions.ts`.
 */

export type BulkOutcome =
  | { ok: true; checkId: string; checkNumber: string | null }
  | { ok: false; checkId: string; checkNumber: string | null; message: string }

export type BulkActionResult =
  | { ok: true; succeeded: number; failed: number; outcomes: BulkOutcome[] }
  /** The whole batch was refused before anything was written. */
  | { ok: false; message: string }

const ids = (f: FormData) => f.getAll('checkId').map((v) => String(v))
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

/**
 * Runs one domain action over the selection, one cheque at a time.
 *
 * Sequential on purpose. Each call opens its own transaction against Neon, and
 * fifty concurrent interactive transactions is how this project's test suite
 * learned about `40P01` deadlocks. Fifty round trips is a second or two; a
 * deadlocked release is a cheque whose state nobody can explain.
 */
async function runEach(
  checkIds: string[],
  fn: (checkId: string) => Promise<unknown>,
): Promise<BulkActionResult> {
  // Read once, for display only. A cheque number the user can recognise is the
  // difference between a readable refusal and a list of opaque ids. An id that
  // matches no row simply has none, and the domain call below reports NOT_FOUND
  // for it like any other refusal.
  const rows = await prisma.check.findMany({
    where: { id: { in: checkIds } },
    select: { id: true, checkNumber: true },
  })
  const numbers = new Map(rows.map((r) => [r.id, r.checkNumber]))

  const outcomes: BulkOutcome[] = []
  for (const checkId of checkIds) {
    const checkNumber = numbers.get(checkId) ?? null
    try {
      await fn(checkId)
      outcomes.push({ ok: true, checkId, checkNumber })
      revalidatePath(`/checks/${checkId}`)
    } catch (e) {
      // Next implements redirect()/notFound() by throwing; these must propagate
      // rather than be reported as a per-cheque refusal.
      if (isNextControlFlowError(e)) throw e
      if (e instanceof DomainError) {
        outcomes.push({ ok: false, checkId, checkNumber, message: e.message })
        continue
      }
      // Anything else is a bug, and its text could name a connection string or
      // a constraint. It goes to the server log; the user gets a fixed
      // sentence, and — because this is a loop — the rest of the batch still
      // runs.
      console.error(e)
      outcomes.push({
        ok: false, checkId, checkNumber,
        message: 'Something went wrong with this cheque. Please try again.',
      })
    }
  }

  revalidatePath('/')
  const succeeded = outcomes.filter((o) => o.ok).length
  return { ok: true, succeeded, failed: outcomes.length - succeeded, outcomes }
}

export async function bulkSignAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const selection = parseSelection(ids(formData))
  if (!selection.ok) return { ok: false, message: selection.message }

  // One timestamp for the batch: these cheques were signed in one act, and the
  // audit trail should say so.
  const now = new Date()
  return runEach(selection.checkIds, (checkId) =>
    markSigned(prisma, { checkId, userId: user.id, now }))
}

export async function bulkReadyForReleaseAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const selection = parseSelection(ids(formData))
  if (!selection.ok) return { ok: false, message: selection.message }

  // The pickup date is one field shared by the whole batch, so a missing or
  // unparseable one is refused here, before anything is written, rather than
  // producing an identical MISSING_FIELDS refusal against every cheque. The
  // domain still requires it — `checkReadyForRelease` lists AVAILABLE PICKUP
  // DATE in REQUIRED_FIELDS — this only reports it once and in terms of the
  // control the user actually touched.
  const raw = str(formData, 'availablePickupDate')
  const availablePickupDate = raw ? new Date(raw) : null
  if (!availablePickupDate || Number.isNaN(availablePickupDate.getTime())) {
    return {
      ok: false,
      message: 'Enter the available pickup date before marking cheques ready for release.',
    }
  }

  const now = new Date()
  return runEach(selection.checkIds, (checkId) =>
    markReadyForRelease(prisma, { checkId, userId: user.id, availablePickupDate, now }))
}

/**
 * FINANCE_ADMIN only (design decision D11): release is the point at which the
 * cheque physically leaves the building, and it is the one action in this
 * system that cannot be undone by any transition — RELEASED leads only to
 * VOIDED.
 *
 * The role is checked here, and `markReleased` is reached only through it. A
 * server action is an HTTP endpoint, reachable by anyone holding a session
 * whether or not a button points at it, so this test is the control and the
 * hidden button in `BulkActionBar` is only a courtesy.
 */
export async function bulkReleaseAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can mark a cheque RELEASED.' }
  }
  const selection = parseSelection(ids(formData))
  if (!selection.ok) return { ok: false, message: selection.message }

  const now = new Date()
  return runEach(selection.checkIds, (checkId) =>
    markReleased(prisma, { checkId, userId: user.id, now }))
}
