'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { updateSetting, resetSetting } from '@/lib/settings/actions'

/**
 * FINANCE_ADMIN only, refused by RETURNING — `requireAdmin` redirects, Next
 * implements a redirect by throwing, and `run()`'s catch would swallow it.
 * The role is checked again inside `updateSetting` / `resetSetting`.
 */
export type SettingActionResult = { ok: true } | { ok: false; message: string }

const ADMIN_ONLY = 'Only a Finance Admin can change settings.'
const str = (f: FormData, k: string) => String(f.get(k) ?? '')

async function run(fn: () => Promise<unknown>): Promise<SettingActionResult> {
  try {
    await fn()
    revalidatePath('/admin/settings')
    revalidatePath('/')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function updateSettingAction(formData: FormData): Promise<SettingActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }
  return run(() => updateSetting(prisma, {
    key: str(formData, 'key').trim(), text: str(formData, 'value'), actorRole: user.role, userId: user.id,
  }))
}

export async function resetSettingAction(formData: FormData): Promise<SettingActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }
  return run(() => resetSetting(prisma, { key: str(formData, 'key').trim(), actorRole: user.role, userId: user.id }))
}
