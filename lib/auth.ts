import NextAuth from 'next-auth'
import { redirect } from 'next/navigation'
import { authConfig } from '@/auth.config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

export type SessionUser = { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }

export async function requireUser(): Promise<SessionUser> {
  const session = await auth()
  const user = session?.user
  // NextAuth's own User/Session types keep `name`/`email` nullable and
  // optional (they're meant to cover OAuth profiles with missing fields).
  // Our Credentials provider always sets them, so treat their absence here
  // as "not really signed in" rather than casting the gap away.
  if (!user?.id || !user.email || !user.name) redirect('/login')
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') redirect('/')
  return user
}
