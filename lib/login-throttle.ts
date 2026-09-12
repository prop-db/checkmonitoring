import type { PrismaClient } from '@prisma/client'

/**
 * Login rate limiting and lockout (`LoginAttempt`, `authorize` in auth.config.ts).
 *
 * This exists because the deployment target changed. Rate limiting was left out
 * on the stated basis that the system would be reachable only from inside the
 * office; the client has since chosen a public URL on Vercel, and this database
 * holds every cheque the group has issued — 12,227 rows, about PHP 2.9 billion.
 * Until this module existed, nothing at all slowed an attacker guessing
 * passwords.
 *
 * **The counter is in Postgres and must stay there.** Vercel is serverless: a
 * `Map` in module scope is per-instance, every cold start begins at zero, and
 * an attacker's requests spread across instances by design. Such a counter
 * reads as a control in review and stops nobody. Neon is already the source of
 * truth for everything else here and needs no new infrastructure to be one for
 * this. Do not move this into process memory, and do not add Redis for it.
 *
 * Two buckets, counted independently, and the stricter wins (`loginLockout`).
 * Throttling only on the email lets an attacker spread one guess across
 * thousands of accounts and never trip a counter; throttling only on the
 * address lets a botnet walk straight through. Neither alone is a control.
 */

// ---------------------------------------------------------------------------
// The numbers, and why they are these numbers.
// ---------------------------------------------------------------------------

/**
 * How far back a failure still counts. Also the outer bound on recovery: stop
 * trying for this long and the counter is empty again, whatever it reached.
 */
export const WINDOW_MINUTES = 15

/**
 * Failures against one address before the first lock. The fifth is the first
 * that locks.
 *
 * Four is chosen for the Finance user who fat-fingers a password at 08:00, not
 * for the attacker: a wrong caps-lock, a stale password manager entry and one
 * genuine mistype all fit inside it with a spare. The attacker is bounded by
 * the schedule below, not by this.
 */
export const EMAIL_FREE_FAILURES = 4

/**
 * Failures from one client address before the first lock, counted across every
 * account it has tried.
 *
 * Higher than the email allowance because one address here is plausibly a whole
 * Finance office behind a single NAT — ten people, each entitled to their own
 * honest mistakes. Twenty covers that with room, and the cost of reaching it is
 * a sixty-second wait, not a call to an administrator.
 */
export const IP_FREE_FAILURES = 20

/**
 * Minutes of lockout for the 1st, 2nd, 3rd and 4th-or-later failure past an
 * allowance. The last entry repeats forever — the back-off is capped, not
 * unbounded.
 *
 * Capped deliberately. An uncapped schedule turns a burst of wrong guesses
 * against a real Finance user into an account nobody can use for the rest of
 * the day, which is a denial of service an attacker can trigger for free by
 * guessing at somebody else's address. With the cap, the worst any attacker can
 * inflict on a colleague is a fifteen-minute wait, and combined with
 * WINDOW_MINUTES the worst anyone ever waits is fifteen minutes — the morning
 * survives.
 *
 * What it costs the attacker: past the allowance one email admits roughly nine
 * guesses per fifteen minutes, so about 900 a day, against argon2id and the
 * twelve-character mixed-class policy in lib/password.ts. That is not a number
 * that guesses a password; online guessing is finished as an attack here, which
 * is the whole objective. Making the numbers harsher buys nothing against that
 * and starts costing the eight-o'clock user real mornings.
 */
export const BACKOFF_MINUTES = [1, 2, 5, 15] as const

/**
 * How long an attempt row is kept.
 *
 * The throttle itself needs only WINDOW_MINUTES of history. The rest is
 * evidence: "was there an attack last month" is the question an admin actually
 * asks, and thirty days answers it. Longer would be an unbounded table on a
 * public login, which is its own problem — see `pruneLoginAttempts`, which runs
 * inside the write path precisely because no cron exists in this project yet.
 */
export const RETENTION_DAYS = 30

/**
 * The bucket every request with no usable proxy header shares.
 *
 * One shared bucket over-throttles; a per-request bucket would not throttle at
 * all. Of the two ways to be wrong, this is the safe one. See `clientIp`.
 *
 * It is deliberately NOT exempt from the address throttle, and the cost of
 * that is worth stating: if the proxy header ever went missing in production,
 * everybody would share one bucket and a burst of failures would refuse the
 * whole office for up to fifteen minutes. That is a bad afternoon, but it is
 * recoverable and self-healing, whereas exempting this bucket would mean an
 * attacker who could strip the header had no address limit at all. Do not add
 * the exemption.
 */
export const UNKNOWN_IP = 'unknown'

const MINUTE = 60_000

export type ThrottleLimits = { windowMinutes: number; emailFreeFailures: number; ipFreeFailures: number }

export const DEFAULT_THROTTLE: ThrottleLimits = {
  windowMinutes: WINDOW_MINUTES,
  emailFreeFailures: EMAIL_FREE_FAILURES,
  ipFreeFailures: IP_FREE_FAILURES,
}

export type Lockout = {
  locked: boolean
  /** The deadline currently in force, or null when nothing is in force. */
  until: Date | null
  /** Which bucket produced `until`. Diagnostic only — both are enforced. */
  scope: 'EMAIL' | 'IP' | null
}

export type LoginFailureState = {
  recentFailures: number
  /** Null unless a lock is in force at the `now` that was asked about. */
  lockedUntil: Date | null
}

// ---------------------------------------------------------------------------
// Where the client address comes from (rule 7).
// ---------------------------------------------------------------------------

// An IPv4 address with a source port glued on. An IPv6 address can never match
// this — it has no dotted quad — so the port strip below cannot corrupt one.
const IPV4_WITH_PORT = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/

/**
 * The client address to throttle on, taken from the request that reaches
 * `authorize`.
 *
 * **We take the RIGHTMOST entry of `x-forwarded-for`, and that is the whole
 * security property of this function.** The header is a list, and everything
 * to the left of the last entry is either what a further-out proxy recorded or
 * what the client themselves sent — all of it attacker-controlled. The last
 * entry is the one appended by the proxy closest to us, which is the peer
 * address it actually saw. Reading the leftmost entry instead is the classic
 * mistake and would make this control decorative: an attacker would send a
 * different `X-Forwarded-For` on every request, land in a fresh bucket each
 * time, and never accumulate a count.
 *
 * Rightmost is correct whether the platform appends the client address to
 * whatever was sent or replaces the header outright — in the replace case there
 * is only one entry and it is also the last. Behind an additional CDN this
 * names that CDN's egress address instead of the visitor's, which pools several
 * visitors into one bucket: over-throttling, never under-throttling, and the
 * email bucket is unaffected either way.
 *
 * There is no configuration here for "how many proxies to trust", and there
 * should not be: a wrong number silently reopens the hole, and this deployment
 * has exactly one hop in front of it.
 *
 * **The precondition, stated plainly, because it is the thing that would go
 * stale silently.** Rightmost is trustworthy only because a proxy we control
 * the deployment of appends the peer address it saw. Serve this app anywhere
 * that does NOT rewrite `x-forwarded-for` — a bare `next start` on a VM, a
 * misconfigured reverse proxy that passes the client's header through — and
 * the last entry becomes attacker-controlled, one guess per bucket, and the
 * address half of this control quietly stops working. Nothing here can detect
 * that; whoever changes the hosting has to know it.
 *
 * Which is the other half of why rule 1 insists on both buckets. An attacker
 * who fully controls this header can at most choose which address bucket they
 * fall into. They can never reduce the count on the EMAIL bucket, which is
 * keyed on what they are guessing at rather than on where they guess from — so
 * the email throttle holds even in the case above.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (!forwarded) {
    // Deliberately NOT falling back to `x-real-ip`. That header is a single
    // value with nothing appending to it, so where `x-forwarded-for` is absent
    // — which is to say, where we already know we are not behind the proxy
    // that would rewrite it — trusting it would hand an attacker a fresh
    // bucket per request. The shared bucket is the honest answer.
    return UNKNOWN_IP
  }

  const entries = forwarded.split(',').map((e) => e.trim()).filter(Boolean)
  const nearest = entries[entries.length - 1]
  if (!nearest) return UNKNOWN_IP

  // A source port would make every request from one client its own bucket,
  // which is the spoofing hole again by another route.
  const withoutPort = IPV4_WITH_PORT.exec(nearest)?.[1] ?? nearest

  // Bounded and case-folded so the bucket key is stable and cannot be grown
  // without limit by a long header. An IPv6 address is at most 45 characters.
  return withoutPort.toLowerCase().slice(0, 64)
}

// ---------------------------------------------------------------------------
// Counting.
// ---------------------------------------------------------------------------

function windowStart(now: Date, windowMinutes: number): Date {
  return new Date(now.getTime() - windowMinutes * MINUTE)
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * MINUTE)
}

type FailureCount = { failures: number; lastFailureAt: Date | null }

/**
 * Failures against one email address that still count.
 *
 * Rule 3: a successful sign-in clears that address's failures, so counting
 * starts after the most recent success rather than at the window's edge.
 * Without this a user who mistypes twice a day is locked out by Thursday.
 *
 * The success **clears the counter without deleting anything**. Deleting the
 * failures would destroy exactly the evidence that matters most — the run of
 * failures immediately before an attacker's successful guess is the shape of a
 * break-in, and it is the only record of one anybody will ever have. Do not
 * "tidy" this into a `deleteMany`.
 */
async function emailFailures(
  db: PrismaClient, email: string, now: Date, windowMinutes: number,
): Promise<FailureCount> {
  const start = windowStart(now, windowMinutes)

  const lastSuccess = await db.loginAttempt.findFirst({
    where: { email, success: true, createdAt: { gte: start } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })

  const since = lastSuccess ? { gt: lastSuccess.createdAt } : { gte: start }
  const agg = await db.loginAttempt.aggregate({
    where: { email, success: false, createdAt: since },
    _count: { _all: true },
    _max: { createdAt: true },
  })

  return { failures: agg._count._all, lastFailureAt: agg._max.createdAt }
}

/**
 * Failures from one client address that still count.
 *
 * **A success does NOT clear this**, and the asymmetry with `emailFailures` is
 * deliberate rather than an oversight. An attacker who holds one valid account
 * — a former employee, a phished colleague — could otherwise sign into it
 * whenever the address lock began to bite and reset their own counter at will,
 * which would leave the address bucket enforcing nothing against precisely the
 * attacker best placed to use it. The email bucket is what a legitimate user
 * needs cleared; the address bucket is what stops a spray, and nothing an
 * attacker can do should clear it.
 */
async function ipFailures(
  db: PrismaClient, ip: string, now: Date, windowMinutes: number,
): Promise<FailureCount> {
  const agg = await db.loginAttempt.aggregate({
    where: { ip, success: false, createdAt: { gte: windowStart(now, windowMinutes) } },
    _count: { _all: true },
    _max: { createdAt: true },
  })
  return { failures: agg._count._all, lastFailureAt: agg._max.createdAt }
}

/**
 * The deadline a bucket's failures impose, or null if it imposes none.
 *
 * Measured from the LAST failure, which is what makes rule 4 self-executing:
 * stop guessing and the deadline stops moving, so the lock runs out on its own
 * with nobody having to be telephoned. Capped by the last entry of
 * BACKOFF_MINUTES, so it can never exceed fifteen minutes however many failures
 * accumulate.
 */
function deadline(count: FailureCount, allowance: number): Date | null {
  if (!count.lastFailureAt) return null
  const past = count.failures - allowance
  if (past <= 0) return null
  const minutes = BACKOFF_MINUTES[Math.min(past, BACKOFF_MINUTES.length) - 1]
  return new Date(count.lastFailureAt.getTime() + minutes * MINUTE)
}

/**
 * Whether this sign-in is currently refused, on either bucket.
 *
 * Rule 1: both are evaluated, and the LATER deadline is the one reported —
 * "the stricter one wins". A caller must not treat a `scope` of 'IP' as
 * grounds to ignore the email bucket or the other way round; `locked` is the
 * answer and `scope` is only there so an operator can tell the two situations
 * apart.
 */
export async function loginLockout(
  db: PrismaClient,
  args: { email: string; ip: string; now: Date; limits?: ThrottleLimits },
): Promise<Lockout> {
  const limits = args.limits ?? DEFAULT_THROTTLE
  const [byEmail, byIp] = await Promise.all([
    emailFailures(db, args.email, args.now, limits.windowMinutes),
    ipFailures(db, args.ip, args.now, limits.windowMinutes),
  ])

  const emailUntil = deadline(byEmail, limits.emailFreeFailures)
  const ipUntil = deadline(byIp, limits.ipFreeFailures)

  const at = args.now.getTime()
  const emailLocked = emailUntil !== null && emailUntil.getTime() > at
  const ipLocked = ipUntil !== null && ipUntil.getTime() > at

  if (!emailLocked && !ipLocked) return { locked: false, until: null, scope: null }
  if (emailLocked && (!ipLocked || emailUntil!.getTime() >= ipUntil!.getTime())) {
    return { locked: true, until: emailUntil, scope: 'EMAIL' }
  }
  return { locked: true, until: ipUntil, scope: 'IP' }
}

// ---------------------------------------------------------------------------
// Writing, and keeping the table bounded.
// ---------------------------------------------------------------------------

/**
 * Record one attempt, successful or not (rule 5), and prune the table as we go
 * (rule 6).
 *
 * Both statements go in one transaction and one round trip. The prune is here,
 * in the path that writes, rather than in a scheduled job, because this project
 * has no cron and a retention policy that depends on infrastructure nobody has
 * built is not a retention policy. It is a single indexed DELETE that matches
 * nothing on almost every call — see `LoginAttempt_createdAt_idx`, which exists
 * for this statement alone.
 *
 * `success` means "this attempt produced a signed-in session", so a correct
 * password refused by the lockout records `false`. That is deliberate: the
 * evidence should show the full volume of an attack, including the part the
 * throttle turned away.
 */
export async function recordLoginAttempt(
  db: PrismaClient,
  args: { email: string; ip: string; success: boolean; now: Date },
): Promise<void> {
  await db.$transaction([
    db.loginAttempt.create({
      data: { email: args.email, ip: args.ip, success: args.success, createdAt: args.now },
    }),
    db.loginAttempt.deleteMany({ where: { createdAt: { lt: retentionCutoff(args.now) } } }),
  ])
}

/**
 * Drop attempt rows past the retention window, and say how many went.
 *
 * `recordLoginAttempt` already does this on every write, so nothing needs to
 * call this on a schedule. It is exported so that a one-off clear-out is
 * possible without anybody inventing a raw DELETE against this table.
 */
export async function pruneLoginAttempts(
  db: PrismaClient,
  args: { now: Date },
): Promise<number> {
  const { count } = await db.loginAttempt.deleteMany({
    where: { createdAt: { lt: retentionCutoff(args.now) } },
  })
  return count
}

/**
 * Recent failure count and lockout state per address, for `/admin/users`.
 *
 * Built from `emailFailures` — the same function the gate itself uses — rather
 * than from a second query shaped like it. The screen is what tells an admin
 * whether an account is locked and whether it is being attacked, and a screen
 * that disagrees with the gate is worse than no screen: it would have someone
 * telling a colleague their account is fine while sign-in refuses them.
 *
 * One pair of small indexed queries per user, issued together. That is a few
 * dozen for this client's user list, on a page an admin opens occasionally.
 * The alternative — one query fetching every attempt in the window and
 * grouping in memory — reads more rows the worse the attack gets, which is the
 * wrong way for an admin page to behave at exactly the moment it is needed.
 */
export async function loginFailureSummary(
  db: PrismaClient,
  args: { emails: string[]; now: Date; limits?: ThrottleLimits },
): Promise<Map<string, LoginFailureState>> {
  const limits = args.limits ?? DEFAULT_THROTTLE
  const at = args.now.getTime()
  const states = await Promise.all(
    args.emails.map(async (email) => {
      const count = await emailFailures(db, email, args.now, limits.windowMinutes)
      const until = deadline(count, limits.emailFreeFailures)
      return [
        email,
        {
          recentFailures: count.failures,
          // Only a lock still in force. A deadline in the past is not a state
          // an admin can act on, and showing one would read as "still locked".
          lockedUntil: until !== null && until.getTime() > at ? until : null,
        },
      ] as const
    }),
  )
  return new Map(states)
}
