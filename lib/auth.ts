import NextAuth from 'next-auth'
import { redirect } from 'next/navigation'
import { authConfig } from '@/auth.config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

export type SessionUser = { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }

export async function requireUser(): Promise<SessionUser> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  return session.user as unknown as SessionUser
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') redirect('/')
  return user
}
