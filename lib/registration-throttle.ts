import type { PrismaClient } from '@prisma/client'
import { RETENTION_DAYS } from '@/lib/login-throttle'

/**
 * The self-registration throttle (`/signup`, `RegistrationAttempt`).
 *
 * `/signup` is public by definition, and every submission creates a row an
 * admin then has to look at. This bounds how many one client address can
 * create in an hour. It is the login throttle's shape with one bucket: there
 * is no per-email bucket because an email is the thing being created here,
 * not a thing being guessed.
 *
 * **The counter is in Postgres and must stay there.** Same reason as
 * `lib/login-throttle.ts`: Vercel is serverless, a module-scope Map is
 * per-instance and starts at zero on every cold start. `clientIp` from the
 * login throttle supplies the address, with the same rightmost-entry rule and
 * the same shared `unknown` bucket, which is deliberately NOT exempt.
 *
 * The allowance is the setting `signup.ipPerHour`; callers read it through
 * `loadSettings` at request time and pass it in. Nothing here reads a
 * constant as the limit.
 */

export const REGISTRATION_WINDOW_MINUTES = 60

const MINUTE = 60_000

function windowStart(now: Date): Date {
  return new Date(now.getTime() - REGISTRATION_WINDOW_MINUTES * MINUTE)
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * MINUTE)
}

/**
 * Whether this address has used up its hour. `recent` is the count the
 * decision was taken on, for a log line or a test.
 */
export async function registrationLockout(
  db: PrismaClient,
  args: { ip: string; now: Date; limit: number },
): Promise<{ locked: boolean; recent: number }> {
  const recent = await db.registrationAttempt.count({
    where: { ip: args.ip, createdAt: { gte: windowStart(args.now) } },
  })
  return { locked: recent >= args.limit, recent }
}

/**
 * Record one submission — accepted, refused by this throttle, or refused by
 * the domain — and prune the table as we go. Every submission counts, so
 * hammering a refused form extends the wait rather than resetting it. The
 * prune rides in the write path because this project has no cron for it, as
 * `recordLoginAttempt` does.
 */
export async function recordRegistrationAttempt(
  db: PrismaClient,
  args: { ip: string; email: string; now: Date },
): Promise<void> {
  await db.$transaction([
    db.registrationAttempt.create({
      data: { ip: args.ip, email: args.email, createdAt: args.now },
    }),
    db.registrationAttempt.deleteMany({ where: { createdAt: { lt: retentionCutoff(args.now) } } }),
  ])
}

/** A one-off clear-out, so nobody invents a raw DELETE against this table. */
export async function pruneRegistrationAttempts(
  db: PrismaClient,
  args: { now: Date },
): Promise<number> {
  const { count } = await db.registrationAttempt.deleteMany({
    where: { createdAt: { lt: retentionCutoff(args.now) } },
  })
  return count
}
