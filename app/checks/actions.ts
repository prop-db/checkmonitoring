'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import {
  markSigned, markReadyForRelease, revertAvailability,
  markReleased, recordClearing, cancelCheck,
} from '@/lib/domain/actions'

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
  return run(checkId, () => markReleased(prisma, {
    checkId, userId: user.id,
    orNumber: str(formData, 'orNumber') || undefined,
    orDate: date(formData, 'orDate') ?? undefined,
    remarks: str(formData, 'remarks') || undefined,
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
