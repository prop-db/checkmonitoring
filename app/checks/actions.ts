'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import {
  markSigned, markReadyForRelease, revertAvailability,
  markReleased, recordClearing, cancelCheck,
} from '@/lib/domain/actions'
import type { ClearingStatus } from '@/lib/domain/check-status'

export type ActionResult = { ok: true } | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const date = (f: FormData, k: string) => {
  const v = str(f, k)
  return v ? new Date(v) : null
}

// Domain errors carry user-facing copy written to the spec; anything else is a
// bug and must not leak its message to a Finance user.
async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn()
    revalidatePath('/')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function signAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(() => markSigned(prisma, { checkId, userId: user.id, now: new Date() }))
}

export async function readyForReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(() => markReadyForRelease(prisma, {
    checkId, userId: user.id,
    availablePickupDate: date(formData, 'availablePickupDate'),
    now: new Date(),
  }))
}

export async function revertAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => revertAvailability(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function releaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => markReleased(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    orNumber: str(formData, 'orNumber') || undefined,
    orDate: date(formData, 'orDate') ?? undefined,
    remarks: str(formData, 'remarks') || undefined,
    now: new Date(),
  }))
}

export async function clearingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => recordClearing(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    clearingStatus: str(formData, 'clearingStatus') as ClearingStatus,
    crNumber: str(formData, 'crNumber') || undefined,
    clearedDate: date(formData, 'clearedDate') ?? undefined,
    now: new Date(),
  }))
}

export async function cancelAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => cancelCheck(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}
