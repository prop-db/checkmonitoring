'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import {
  createPlannedOutflow, updatePlannedOutflow, markPlannedOutflowPaid, cancelPlannedOutflow,
} from '@/lib/planned-outflow/actions'

/**
 * Planned outflow lines, off the form. Any Finance user. Every refusal is the
 * domain's own sentence; anything else is logged and reported as a fixed line.
 */
export type PlannedActionResult = { ok: true } | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

const inputOf = (f: FormData) => ({
  date: str(f, 'date'), amount: str(f, 'amount'), currency: str(f, 'currency'),
  bankId: str(f, 'bankId'), companyId: str(f, 'companyId'),
  description: str(f, 'description'), category: str(f, 'category'),
})

async function run(fn: () => Promise<unknown>): Promise<PlannedActionResult> {
  try {
    await fn()
    revalidatePath('/forecast')
    revalidatePath('/forecast/planned')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function createPlannedOutflowAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => createPlannedOutflow(prisma, { input: inputOf(formData), userId: user.id, now: new Date() }))
}

export async function updatePlannedOutflowAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => updatePlannedOutflow(prisma, { id: str(formData, 'id'), input: inputOf(formData), userId: user.id, now: new Date() }))
}

export async function markPlannedOutflowPaidAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => markPlannedOutflowPaid(prisma, { id: str(formData, 'id'), paidOn: str(formData, 'paidOn'), userId: user.id, now: new Date() }))
}

export async function cancelPlannedOutflowAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => cancelPlannedOutflow(prisma, { id: str(formData, 'id'), reason: str(formData, 'reason'), userId: user.id, now: new Date() }))
}
