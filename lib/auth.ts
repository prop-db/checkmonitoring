import NextAuth from 'next-auth'
import { redirect } from 'next/navigation'
import { authConfig } from '@/auth.config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

export type SessionUser = { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }

/**
 * The signed-in user, or null.
 *
 * The ONE definition of what counts as a session in this system. `requireUser`
 * is this plus a redirect, and `app/api/export/route.ts` is this plus a 401 —
 * a route handler cannot redirect a `fetch` usefully, and an export of every
 * cheque the group has issued is not a thing to hand to an unauthenticated
 * caller under any status code.
 *
 * It matters that both go through here rather than each asking `auth()` its own
 * way. `middleware.ts` DOES NOT RUN in this project (Node-runtime middleware is
 * silently unregistered in Next 15.5.25), so there is no perimeter: every
 * request-time control lives in the request path, and a second, subtly
 * different notion of "signed in" is how one of them ends up weaker.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth()
  const user = session?.user
  // NextAuth's own User/Session types keep `name`/`email` nullable and
  // optional (they're meant to cover OAuth profiles with missing fields).
  // Our Credentials provider always sets them, so treat their absence here
  // as "not really signed in" rather than casting the gap away.
  if (!user?.id || !user.email || !user.name) return null
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  return user
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') redirect('/')
  return user
}
