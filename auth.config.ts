import { randomBytes } from 'node:crypto'
import type { NextAuthConfig, User } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { prisma } from '@/lib/db'
import { clientIp, loginLockout, recordLoginAttempt } from '@/lib/login-throttle'
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

/**
 * The Credentials provider's `authorize`, as a named export.
 *
 * Named and exported so the tests can drive it directly. `Credentials()` from
 * @auth/core buries the config it is handed under an `options` property and
 * replaces the top-level `authorize` with a stub, so a test reaching in through
 * `authConfig.providers[0]` would be asserting against library internals rather
 * than against this. This is the single choke point for every credentials
 * sign-in; it is worth being able to test it.
 */
export async function authorizeCredentials(
  credentials: Partial<Record<'email' | 'password', unknown>>,
  request: Request,
): Promise<User | null> {
  const email = String(credentials?.email ?? '').toLowerCase().trim()
  const password = String(credentials?.password ?? '')
  // Not an attempt against anything: the form marks both fields required, and
  // a blank submission distinguishes no account from any other. Nothing to
  // record and nothing to throttle.
  if (!email || !password) return null

  const now = new Date()
  // Rule 7. `request` is the one @auth/core builds from the incoming headers,
  // so `x-forwarded-for` survives the trip through the server action. See
  // `clientIp` for why the RIGHTMOST entry is the only safe one to key on.
  //
  // This throttle lives here, in `authorize`, and not in `middleware.ts`.
  // That file is not registered by the build in this project, so a control
  // placed there would pass its own tests and protect nothing.
  const ip = clientIp(request.headers)

  // Read together: the lockout is a decision about this request, taken from
  // rows written before it, so it does not matter that the user lookup runs
  // alongside it — and one round trip to Neon is cheaper than two.
  const [lockout, user] = await Promise.all([
    loginLockout(prisma, { email, ip, now }),
    prisma.user.findUnique({ where: { email } }),
  ])

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
    await recordLoginAttempt(prisma, { email, ip, success: false, now })
    return null
  }

  // **The verification happens before the lockout is acted on, and it must
  // stay that way.** Returning early on `lockout.locked` — above this line, or
  // anywhere before the hash — would rebuild the account-enumeration oracle
  // this function was written to close: a locked real account would answer in
  // a millisecond while an unknown address still paid for a full argon2
  // verify, and the difference would tell an attacker which addresses are
  // real. The dummy-hash defence above is worthless if a second path is
  // allowed to skip the work. `authorize` is not on a hot path and there is no
  // performance argument for the early return; do not "optimise" one in.
  const passwordOk = await verifyPassword(user.passwordHash, password)

  if (lockout.locked || !passwordOk) {
    // Recorded either way, and as a failure either way: `success` means "this
    // produced a session", and a refused attempt produced none. A locked
    // account is still an account under attack, and the evidence should show
    // the volume the throttle turned away rather than stopping at the moment
    // it began turning it away.
    //
    // Yes, this means a retry during a lockout extends it. That is bounded and
    // deliberate: the back-off is capped at fifteen minutes and the counting
    // window is fifteen minutes, so however hard anybody hammers, nobody waits
    // longer than fifteen minutes for the lock to lapse on its own.
    await recordLoginAttempt(prisma, { email, ip, success: false, now })
    return null
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } })
  await recordLoginAttempt(prisma, { email, ip, success: true, now })
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 30 * 60 },  // 30-minute idle timeout
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: authorizeCredentials,
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
