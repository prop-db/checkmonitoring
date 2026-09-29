'use server'

import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { markSigned, markReadyForRelease, markReleased, recordReceipt, revertAvailability } from '@/lib/domain/actions'
import { parseSelection, chunkSelection } from '@/lib/bulk'
import {
  listTodaysReleaseIds, getFilterOptions, parseOptionId, parseEligibilityParam,
  type SummaryNarrowing,
} from '@/lib/queries'
import { readRowReceipts } from '@/lib/receipt-form'
import { runEach, type BulkOutcome, type BulkActionResult } from '@/lib/bulk-run'
import { loadSettings } from '@/lib/settings/read'

export type { BulkOutcome, BulkActionResult }

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

const ids = (f: FormData) => f.getAll('checkId').map((v) => String(v))
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

/**
 * The narrowing the TOTALS screen was showing when RELEASE ALL was pressed,
 * read back off the form. `null` means a value was present and is not
 * recognised — the caller refuses, because dropping it would silently widen
 * the set from one company to every company. An absent value is no narrowing:
 * the unfiltered screen, and the behaviour before 2026-09-29.
 */
async function readReleaseNarrowing(formData: FormData): Promise<SummaryNarrowing | null> {
  const company = str(formData, 'company')
  const cashAccount = str(formData, 'cashAccount')
  const eligibility = str(formData, 'eligibility')
  if (!company && !cashAccount && !eligibility) return {}

  const options = await getFilterOptions(prisma)
  const companyId = parseOptionId(company || undefined, options.companies)
  const cashAccountId = parseOptionId(cashAccount || undefined, options.cashAccounts)
  const elig = parseEligibilityParam(eligibility || undefined)
  if ((company && !companyId) || (cashAccount && !cashAccountId) || (eligibility && !elig)) return null
  return { companyId, cashAccountId, eligibility: elig }
}

export async function bulkSignAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  // One timestamp for the batch: these cheques were signed in one act, and the
  // audit trail should say so.
  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    markSigned(prisma, { checkId, userId: user.id, now }))
}

export async function bulkReadyForReleaseAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
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
  return runEach(prisma, selection.checkIds, (checkId) =>
    markReadyForRelease(prisma, { checkId, userId: user.id, availablePickupDate, now }))
}

/**
 * READY FOR RELEASE (or SCHEDULED) back to SIGNED, from the list. Open to every
 * Finance user (client ruling 2026-09-26), like the single-cheque button.
 * `revertAvailability` does the work per cheque: the transition check, the
 * cleared pickup, the portal REVERT event and the audit row carrying the reason.
 * The reason is one field for the batch, so a blank one is refused here once.
 */
export async function bulkRevertToSignedAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const reason = str(formData, 'reason')
  if (!reason) return { ok: false, message: 'Enter a reason before reverting cheques to SIGNED.' }

  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    revertAvailability(prisma, { checkId, userId: user.id, reason, now }))
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
 *
 * **THE RECEIPT BOX, ONE PER ROW.**
 * Since 2026-09-25 every ticked row carries its own OR/CR box
 * (`lib/row-receipts.ts`), so a typed receipt always has exactly one owner —
 * the cheque whose row it was typed in. The old refusal of one box shared by a
 * whole batch is REPLACED by this, not loosened: a receipt still cannot land
 * on a cheque its supplier never issued it for, it is just that "which cheque"
 * is now answered by the row rather than by the size of the selection.
 *
 * `readRowReceipts` refuses the whole release, before anything is written,
 * for a receipt keyed to a cheque that is not ticked, a reference typed with
 * no type chosen, an invalid type, or the old unkeyed `orNumber`/`receiptType`
 * fields a stale page would still send.
 *
 * A ticked cheque with an EMPTY box releases exactly as it always did. That is
 * what makes the receipt optional, and RELEASE ALL at the counter depends on
 * it.
 */
export async function bulkReleaseAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can mark a cheque RELEASED.' }
  }
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const read = readRowReceipts(formData, selection.checkIds)
  if (!read.ok) return { ok: false, message: read.message }

  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) => {
    const receipt = read.receipts.get(checkId)
    return markReleased(prisma, {
      checkId, userId: user.id, now,
      orNumber: receipt?.orNumber, orDate: undefined, receiptType: receipt?.receiptType ?? null,
    })
  })
}

/**
 * SAVE RECEIPTS — the late receipts, typed in the rows of ticked RELEASED
 * cheques (client, 2026-09-25: "i dont need to click the checks").
 *
 * Open to any signed-in Finance user, like `recordReceiptAction`: it records a
 * reference against a hand-over that already happened, moves no status and
 * cannot overwrite a receipt (`recordReceipt` refuses). Rows left blank are not
 * sent to the domain at all. Each typed row is its own transaction, so one
 * refusal — released by nobody, receipt added a moment ago — names that cheque
 * and the rest still save.
 */
export async function bulkRecordReceiptsAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const read = readRowReceipts(formData, selection.checkIds)
  if (!read.ok) return { ok: false, message: read.message }

  const typed = selection.checkIds.filter((id) => read.receipts.has(id))
  if (typed.length === 0) {
    return { ok: false, message: 'Type a receipt reference on at least one ticked cheque before saving.' }
  }

  const now = new Date()
  return runEach(prisma, typed, (checkId) => {
    const receipt = read.receipts.get(checkId)!
    return recordReceipt(prisma, {
      checkId, userId: user.id, orNumber: receipt.orNumber, receiptType: receipt.receiptType, now,
    })
  })
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

  const settings = await loadSettings(prisma)
  const cap = settings.values['caps.bulkSelection']
  const narrow = await readReleaseNarrowing(formData)
  if (narrow === null) {
    return {
      ok: false,
      message: 'The filter on screen was not recognised. Open TODAY’S RELEASE again and re-read the figures.',
    }
  }
  const checkIds = await listTodaysReleaseIds(prisma, narrow)

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
  for (const batch of chunkSelection(checkIds, cap)) {
    const selection = parseSelection(batch, cap)
    // Unreachable: `chunkSelection` de-duplicates, drops blanks and splits at
    // the cap. Handled rather than asserted, because the alternative to a
    // returned refusal is a thrown one half way through a release.
    if (!selection.ok) return { ok: false, message: selection.message }

    const batchResult = await runEach(prisma, selection.checkIds, (checkId) =>
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
