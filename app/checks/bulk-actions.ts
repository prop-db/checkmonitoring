'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { markSigned, markReadyForRelease, markReleased } from '@/lib/domain/actions'
import { parseSelection, chunkSelection } from '@/lib/bulk'
import { listTodaysReleaseIds } from '@/lib/queries'

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

/**
 * TODAY'S RELEASE — release everything that is ready, in one confirmed action.
 *
 * The highest-risk action in the system (design decision D11) and effectively
 * terminal: only VOIDED follows RELEASED. Three separate things stand between a
 * misclick and every cheque Finance has prepared leaving the building at once,
 * and none of them is the button being hard to reach.
 *
 *  1. **FINANCE_ADMIN only**, checked here rather than by hiding a control. A
 *     server action is an HTTP endpoint. It RETURNS the refusal — `requireAdmin`
 *     redirects, Next implements a redirect by throwing, and `runEach`'s catch
 *     would swallow it and report "Something went wrong" instead.
 *  2. **The confirmation is a field on the request**, not only a step in the
 *     page. The panel links to `?confirm=release`, which server-renders a second
 *     form naming the count and the total; that form is the only thing that
 *     submits `confirm=release`. A POST that never went through it writes
 *     nothing.
 *  3. **The count the user read is submitted back.** If MORE cheques are ready
 *     now than were on screen — a colleague marked twenty more ready while the
 *     confirmation sat open — the figures agreed to were never the figures that
 *     would move, so the action refuses and asks for a fresh look. FEWER is
 *     fine: somebody released some, and releasing the remainder is what was
 *     agreed to.
 *
 * The SET is read from the database, not from the form. The button names a
 * count, not a list, and a form carrying 81 ids is a form somebody can edit.
 *
 * The release itself is `markReleased`, once per cheque, through the same
 * `runEach` as every other bulk action: one transaction, one set of guards and
 * one audit row each, and an INTERNAL cheque still produces no portal event
 * because `markReleased` is where that decision lives.
 *
 * **The `(previousState, formData)` signature is `useActionState`'s**, and it is
 * why the confirmation works with no JavaScript at all. Passed straight to
 * `useActionState`, Next renders the form with a real POST target, so the
 * confirm button submits and the release happens whether or not the bundle
 * loaded; a client-side wrapper closure would have been a button that does
 * nothing until React hydrates. The previous state is not read — the action's
 * answer depends on the request and on the database, never on what it said last
 * time.
 */
export async function releaseAllReadyAction(
  _previousState: BulkActionResult | null,
  formData: FormData,
): Promise<BulkActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can mark a cheque RELEASED.' }
  }

  if (str(formData, 'confirm') !== 'release') {
    return {
      ok: false,
      message: 'This release was not confirmed. Open TODAY’S RELEASE and confirm the figures first.',
    }
  }

  /**
   * The figure that was on screen.
   *
   * Matched against digits before `Number` sees it, because `Number('')` is 0
   * and `Number(' 12 ')` is 12: an ABSENT field would otherwise parse as a
   * confirmed count of zero, which is a different refusal with a misleading
   * sentence rather than the honest "this did not come from the confirmation
   * step". `\d+` also rules out `1e9`, `0x51` and `Infinity`, all of which
   * `Number` accepts.
   */
  const rawExpected = str(formData, 'expectedCount')
  const expectedCount = /^\d+$/.test(rawExpected) ? Number(rawExpected) : Number.NaN
  if (!Number.isInteger(expectedCount)) {
    return {
      ok: false,
      message: 'This release could not be confirmed. Open TODAY’S RELEASE again and re-read the figures.',
    }
  }

  const checkIds = await listTodaysReleaseIds(prisma)

  if (checkIds.length === 0) {
    return { ok: false, message: 'No cheques are ready to release right now.' }
  }

  if (checkIds.length > expectedCount) {
    return {
      ok: false,
      message:
        `${checkIds.length} cheques are ready now, but ${expectedCount} were on screen when you ` +
        'confirmed. Re-read TODAY’S RELEASE and confirm the current figures.',
    }
  }

  /**
   * Sequential batches of `MAX_BULK_SELECTION`, not one oversized call.
   *
   * **Raising the cap would be the wrong fix.** It is not a limit on how much
   * this action may release — the set here is decided by a query, counted on
   * screen and confirmed. It is a limit on an UNBOUNDED, user-composed tick-box
   * selection, where a select-all over a filter is how "the twelve I meant"
   * becomes "every cheque in the company"; and it is what keeps the tick-box
   * path from opening fifty interactive transactions' worth of work that this
   * project's suite already learned deadlocks against Neon (`40P01`). Raising it
   * to fit 81 would loosen that path to solve a problem it does not have.
   *
   * Batching costs nothing in correctness: `runEach` already processes one
   * cheque at a time, so each cheque gets its own transaction, its own guards
   * and its own audit row whether it is in a batch of one or of fifty. What the
   * batches buy is that every id still passes through `parseSelection`, the
   * single gate every bulk write in this system goes through.
   */
  const now = new Date()
  const outcomes: BulkOutcome[] = []
  for (const batch of chunkSelection(checkIds)) {
    const selection = parseSelection(batch)
    // Unreachable: `chunkSelection` de-duplicates, drops blanks and splits at
    // the cap. Handled rather than asserted, because the alternative to a
    // returned refusal is a thrown one half way through a release.
    if (!selection.ok) return { ok: false, message: selection.message }

    const batchResult = await runEach(selection.checkIds, (checkId) =>
      markReleased(prisma, { checkId, userId: user.id, now }))
    // `runEach` only reports `ok: false` for a refusal it was handed, which
    // cannot happen above; the narrowing is for the type, not for the case.
    if (!batchResult.ok) return batchResult
    outcomes.push(...batchResult.outcomes)
  }

  // Recomputed over every batch, so "73 of 81" counts the whole action rather
  // than the last batch of it.
  const succeeded = outcomes.filter((o) => o.ok).length
  return { ok: true, succeeded, failed: outcomes.length - succeeded, outcomes }
}
