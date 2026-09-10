import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listUsers } from '@/lib/admin/users'
import { BACKOFF_MINUTES, EMAIL_FREE_FAILURES, WINDOW_MINUTES } from '@/lib/login-throttle'
import { CreateUserForm } from '@/components/CreateUserForm'
import { UserRowActions } from '@/components/UserRowActions'

/**
 * `/admin/users` (spec §13). FINANCE_ADMIN only — gated by
 * `app/admin/layout.tsx` and again here, because a layout is a convenience and
 * the guard is not.
 *
 * **Nothing on this screen deletes a user.** A `User` is what
 * `Check.signedBy/readyBy/releasedBy/cancelledBy/eligibilityOverriddenBy` and
 * `AuditLog.user` point at, all of them nulling out on delete, so removing a row
 * would erase who released real money rather than failing. Removal is
 * deactivation. Deactivated accounts stay listed, greyed rather than hidden: an
 * admin who cannot see them cannot reactivate one, and would create a second
 * account for the same person instead.
 */

const fmtDateTime = (d: Date | null) =>
  d
    ? d.toLocaleString('en-PH', {
        month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })

export default async function UsersPage() {
  const me = await requireAdmin()
  const users = await listUsers(prisma)

  const activeAdmins = users.filter((u) => u.active && u.role === 'FINANCE_ADMIN')
  const liveSeeded = users.filter((u) => u.isSeededTestAccount && u.active)
  // The seeded accounts can only be retired once a real admin exists — the
  // last-active-admin guard refuses the click otherwise, correctly. Say so up
  // front rather than letting the client discover it by being refused.
  const realAdminExists = activeAdmins.some((u) => !u.isSeededTestAccount)

  return (
    <div className="space-y-6">
      {liveSeeded.length > 0 && (
        <section className="space-y-2 rounded-2xl bg-danger-bg p-6 ring-1 ring-danger-ink/20">
          <h2 className="text-sm font-semibold tracking-wide text-danger-ink">
            SEEDED TEST ACCOUNTS ARE STILL ACTIVE — DEACTIVATE BEFORE PRODUCTION
          </h2>
          <p className="text-sm text-danger-ink">
            {liveSeeded.map((u) => u.email).join(' and ')}{' '}
            {liveSeeded.length === 1 ? 'was' : 'were'} created by{' '}
            <code className="rounded bg-white/70 px-1">prisma/seed.ts</code> with a password that
            is committed to this repository, so anyone who can read the source can sign in.{' '}
            {realAdminExists
              ? 'A real Finance Admin now exists, so you can deactivate them: press DEACTIVATE on each row below.'
              : 'Create a real Finance Admin first — until one exists, deactivating these would ' +
                'leave nobody able to administer the system and will be refused.'}
          </p>
          <p className="text-sm text-danger-ink">
            Deactivate, never delete: these accounts may already be named in the audit trail, and a
            deleted row would take that attribution with it.
          </p>
        </section>
      )}

      <CreateUserForm />

      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-4 pt-6">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">USERS</h2>
          <p className="text-[11px] font-medium tracking-wide text-slate-400">
            {activeAdmins.length} ACTIVE FINANCE ADMIN{activeAdmins.length === 1 ? '' : 'S'}
          </p>
        </div>

        <table className="w-full text-sm">
          <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
            <tr>
              <th className="px-4 py-3">NAME</th>
              <th className="px-4 py-3">EMAIL</th>
              <th className="px-4 py-3">ROLE</th>
              <th className="px-4 py-3">STATUS</th>
              <th className="px-4 py-3">LAST LOGIN</th>
              <th className="px-4 py-3">FAILED SIGN-INS</th>
              <th className="px-4 py-3">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className={`border-b border-slate-100 last:border-0 ${u.active ? 'hover:bg-navy-bg' : 'bg-ground text-slate-500'}`}
              >
                <td className="px-4 py-3 font-medium">
                  {u.name}
                  {u.isSeededTestAccount && (
                    <span className="ml-2 rounded bg-danger-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-danger-ink">
                      SEEDED TEST ACCOUNT
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">{u.email}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${
                      u.role === 'FINANCE_ADMIN' ? 'bg-navy-bg text-navy' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {u.role.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${
                      u.active ? 'bg-success-bg text-success-ink' : 'bg-danger-bg text-danger-ink'
                    }`}
                  >
                    {u.active ? 'ACTIVE' : 'DEACTIVATED'}
                  </span>
                </td>
                {/* An em dash, not an empty cell: an account that has never been
                    signed into is a fact worth reading, and a blank reads as a
                    rendering fault. Matches CheckTable and the sync log. */}
                <td className="px-4 py-3 text-slate-600">{fmtDateTime(u.lastLoginAt) ?? 'NEVER SIGNED IN'}</td>
                {/* The login throttle, made visible. Without this an admin has
                    no way to tell an attack from a colleague who has forgotten
                    their password, and no way to explain to somebody standing
                    at their desk why sign-in is refusing them. The count is
                    read from the same function the gate itself uses, so the two
                    cannot disagree. */}
                <td className="px-4 py-3">
                  {u.lockedUntil ? (
                    <span className="inline-block whitespace-nowrap rounded-full bg-danger-bg px-2.5 py-1 text-xs font-medium tracking-wide text-danger-ink">
                      LOCKED UNTIL {fmtTime(u.lockedUntil)} · {u.recentFailedLogins} FAILED
                    </span>
                  ) : u.recentFailedLogins > 0 ? (
                    <span className="inline-block rounded-full bg-warning-bg px-2.5 py-1 text-xs font-medium tracking-wide text-warning-ink">
                      {u.recentFailedLogins} RECENT
                    </span>
                  ) : (
                    <span className="text-slate-400">NONE</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <UserRowActions
                    userId={u.id} name={u.name} role={u.role} active={u.active}
                    isSelf={u.id === me.id}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="max-w-4xl rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Accounts are never deleted here. A user is named on the cheques they signed, marked ready,
        released or cancelled, and on every audit entry they wrote; deleting the row would blank
        that attribution out rather than fail. DEACTIVATE is removal — a deactivated account is
        refused at sign-in and keeps its history. The last active Finance Admin can be neither
        deactivated nor demoted, including by themselves.
      </p>

      <p className="max-w-4xl rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        FAILED SIGN-INS counts wrong passwords for that address in the last {WINDOW_MINUTES}{' '}
        minutes, and resets the moment the account signs in successfully. Past{' '}
        {EMAIL_FREE_FAILURES} failures the login is refused for a minute, then longer, up to a
        maximum of {BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]} minutes. A lockout releases
        itself — there is nothing to press here, and nobody needs to be called. The same throttle
        counts failures per client address, so an attacker cannot spread guesses across accounts
        to avoid it.
      </p>
    </div>
  )
}
