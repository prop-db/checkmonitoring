'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import {
  markSigned, markReadyForRelease, revertAvailability,
  markReleased, recordClearing, cancelCheck, deleteIncompleteCheck, recordReceipt,
} from '@/lib/domain/actions'
import { readReceiptFields } from '@/lib/receipt-form'

export type ActionResult = { ok: true } | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const date = (f: FormData, k: string) => {
  const v = str(f, k)
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const clearingStatusSchema = z.enum(['NONE', 'DEPOSITED', 'ENCASHED', 'CLEARED'])

// Domain errors carry user-facing copy written to the spec; anything else is a
// bug and must not leak its message to a Finance user.
async function run(checkId: string, fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn()
    revalidatePath('/')
    revalidatePath(`/checks/${checkId}`)
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    // Next implements redirect()/notFound() by throwing; these must propagate.
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function signAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => markSigned(prisma, { checkId, userId: user.id, now: new Date() }))
}

export async function readyForReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => markReadyForRelease(prisma, {
    checkId, userId: user.id,
    availablePickupDate: date(formData, 'availablePickupDate'),
    now: new Date(),
  }))
}

export async function revertAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can revert a check’s availability.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => revertAvailability(prisma, {
    checkId, userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function releaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const receipt = readReceiptFields(formData)
  if (!receipt.ok) return { ok: false, message: receipt.message }
  return run(checkId, () => markReleased(prisma, {
    checkId, userId: user.id,
    orNumber: receipt.orNumber,
    orDate: receipt.orDate,
    receiptType: receipt.receiptType,
    remarks: str(formData, 'remarks') || undefined,
    now: new Date(),
  }))
}

/**
 * The receipt a supplier hands over, typed in after the cheque was released.
 *
 * Open to any signed-in Finance user, like `releaseAction` beside it. It
 * records a reference against a release that has already happened; it moves no
 * status, releases no money, and cannot clear a receipt that is already there
 * (`recordReceipt` refuses an overwrite). The audit row names whoever typed it.
 */
export async function recordReceiptAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const receipt = readReceiptFields(formData)
  if (!receipt.ok) return { ok: false, message: receipt.message }
  return run(checkId, () => recordReceipt(prisma, {
    checkId, userId: user.id,
    orNumber: receipt.orNumber ?? '',
    orDate: receipt.orDate,
    receiptType: receipt.receiptType,
    now: new Date(),
  }))
}

export async function clearingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const parsed = clearingStatusSchema.safeParse(str(formData, 'clearingStatus'))
  if (!parsed.success) return { ok: false, message: 'Invalid clearing status.' }
  return run(checkId, () => recordClearing(prisma, {
    checkId, userId: user.id,
    clearingStatus: parsed.data,
    crNumber: str(formData, 'crNumber') || undefined,
    clearedDate: date(formData, 'clearedDate') ?? undefined,
    now: new Date(),
  }))
}

/**
 * The only endpoint in this application that deletes a cheque.
 *
 * Like `revertAction` and `cancelAction`, it refuses a FINANCE_USER by
 * RETURNING a result rather than redirecting: `requireAdmin` redirects, Next
 * implements a redirect by throwing, and `run()`'s catch would swallow it and
 * report "Something went wrong" on an action the user is not entitled to.
 *
 * The role is checked here AND again in `deleteIncompleteCheck`. That is not
 * belt-and-braces for its own sake — a server action is an HTTP endpoint,
 * reachable by anyone holding a session whether or not a button points at it,
 * and the domain rule has to hold for every caller of the domain function too.
 *
 * `run()` revalidates `/checks/${checkId}` for a cheque that no longer exists,
 * which is exactly right: the cached page must go. The screen sends the user
 * back to the dashboard, because the page they were on is now a 404.
 */
export async function deleteIncompleteCheckAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    // The same sentence `checkDeletable` returns for NOT_ADMIN, so a Finance
    // user reads one wording whichever layer refused them.
    return { ok: false, message: 'Only a Finance Admin can delete a cheque record.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => deleteIncompleteCheck(prisma, {
    checkId, userId: user.id, actorRole: user.role,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function cancelAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can cancel a check.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => cancelCheck(prisma, {
    checkId, userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}
