/**
 * Next implements `redirect()` and `notFound()` by THROWING a tagged error.
 *
 * Any server action that wraps its work in a try/catch therefore has to let
 * these through, or a `requireUser()` redirect fired mid-action is swallowed
 * and reported to the user as "Something went wrong. Please try again." — on a
 * page they are not signed in to, which they then try again.
 *
 * Written here once because it was already needed in two places, and a second
 * copy of a string comparison against a framework's internal digest is exactly
 * the sort of thing that gets updated in one of them.
 */
export function isNextControlFlowError(e: unknown): boolean {
  if (!e || typeof e !== 'object' || !('digest' in e)) return false
  const digest = (e as { digest: unknown }).digest
  if (typeof digest !== 'string') return false
  return digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND'
}
