import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/password'

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 30 * 60 },  // 30-minute idle timeout
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const email = String(credentials?.email ?? '').toLowerCase().trim()
        const password = String(credentials?.password ?? '')
        if (!email || !password) return null

        const user = await prisma.user.findUnique({ where: { email } })
        // `active` gates sign-in only. Users are deactivated, never deleted —
        // Check.signedById/readyById/releasedById/cancelledById and
        // AuditLog.userId are all onDelete: SetNull, so hard-deleting a user
        // would silently erase who authorised each check release from the
        // audit trail this system exists to preserve. There is no delete-user
        // helper anywhere in this codebase; do not add one.
        if (!user || !user.active) return null
        if (!(await verifyPassword(user.passwordHash, password))) return null

        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
        return { id: user.id, email: user.email, name: user.name, role: user.role }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id
        token.role = (user as { role: string }).role
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid as string
        session.user.role = token.role as string
      }
      return session
    },
  },
}
