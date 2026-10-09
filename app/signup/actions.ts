'use server'

import { headers } from 'next/headers'
import { prisma } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { clientIp } from '@/lib/login-throttle'
import { recordRegistrationAttempt, registrationLockout } from '@/lib/registration-throttle'
import { registerUser } from '@/lib/admin/users'
import { loadSettings } from '@/lib/settings/read'

/**
 * Self-registration (spec 2026-10-09). PUBLIC: no session is required and
 * none is created. The account it makes is inactive and pending; an admin's
 * APPROVE on /admin/users is the only way it becomes usable.
 *
 * Order: passwords match → throttle → domain → record the attempt. The
 * attempt is recorded whether the registration was accepted, refused by the
 * throttle or refused by the domain, so hammering a refused form extends the
 * wait. A mismatched pair is refused before any database work and is not an
 * attempt against anything.
 *
 * On success the result carries the address and nothing else; on failure a
 * sentence. A domain error's wording is for the person at the form (the
 * password policy, "already exists"); anything else is logged — the thrown
 * error only, never the form — and the person gets a fixed sentence.
 */

export type SignupResult = { ok: true; email: string } | { ok: false; message: string }

const THROTTLED = 'Too many accounts have been created from this connection. Try again later.'

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
/** Untrimmed: a leading or trailing space is a legitimate password character, and sign-in does not trim. */
const raw = (f: FormData, k: string) => String(f.get(k) ?? '')

export async function registerAction(formData: FormData): Promise<SignupResult> {
  const name = str(formData, 'name')
  const email = str(formData, 'email').toLowerCase()
  const password = raw(formData, 'password')
  const confirm = raw(formData, 'confirm')

  if (password !== confirm) return { ok: false, message: 'The two passwords do not match.' }

  const now = new Date()
  const ip = clientIp(await headers())
  const settings = await loadSettings(prisma)
  const limit = settings.values['signup.ipPerHour']

  try {
    const { locked } = await registrationLockout(prisma, { ip, now, limit })
    if (locked) return { ok: false, message: THROTTLED }

    try {
      await registerUser(prisma, { email, name, password })
      return { ok: true, email }
    } catch (e) {
      if (e instanceof DomainError) return { ok: false, message: e.message }
      if (isNextControlFlowError(e)) throw e
      console.error(e)
      return { ok: false, message: 'Something went wrong. Please try again.' }
    }
  } finally {
    await recordRegistrationAttempt(prisma, { ip, email, now })
  }
}
