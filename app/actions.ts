'use server'

import { signOut } from '@/lib/auth'

/**
 * Sign out. The only action in this file, and deliberately the only thing the
 * application root exposes.
 *
 * It REDIRECTS rather than returning an `ActionResult`, which is the opposite
 * of every other action in this codebase — and right here, because there is no
 * failure a Finance user could act on: the session is either cleared or the
 * request never arrived. `signOut` implements the redirect by throwing, so this
 * function must not be wrapped in a try/catch that swallows it (see the note on
 * `run()` in `app/checks/actions.ts`).
 *
 * `/login` and not `/`: sending a just-signed-out user to a guarded page only
 * to have `requireUser()` bounce them makes the sign-out look like it failed.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' })
}
