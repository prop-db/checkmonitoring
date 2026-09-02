import { randomBytes } from 'node:crypto'
import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { prisma } from '@/lib/db'
import { hashPassword, verifyPassword } from '@/lib/password'

// Computed once, lazily, from a value nobody knows. Used to equalise the cost
// of rejecting a login, so response time cannot be used to enumerate accounts.
let dummy: Promise<string> | null = null
const dummyHash = () => {
  // If hashing ever rejects, `dummy` must not stay set to a rejected promise —
  // that would fail every subsequent unknown-email login with a 500 instead of
  // "invalid credentials" (in the very code path meant to disguise that
  // distinction) until the process restarts. Clear it on failure so the next
  // call retries.
  dummy ??= hashPassword(randomBytes(32).toString('hex')).catch((e) => {
    dummy = null
    throw e
  })
  return dummy
}

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
        //
        // Rejecting early on "no such user" or "deactivated" would return far
        // faster than a real password check, because argon2 is deliberately
        // slow. That timing difference tells an attacker which addresses are
        // real, active accounts. Verify against a throwaway hash instead, so
        // every rejection costs the same.
        if (!user || !user.active) {
          await verifyPassword(await dummyHash(), password)
          return null
        }

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
        token.role = user.role
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid as string
        if (token.role) session.user.role = token.role
      }
      return session
    },
  },
}
