import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listUsers } from '@/lib/admin/users'
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
        <section className="space-y-2 rounded-2xl bg-rose-50 p-6 ring-1 ring-rose-200">
          <h2 className="text-sm font-semibold tracking-wide text-rose-900">
            SEEDED TEST ACCOUNTS ARE STILL ACTIVE — DEACTIVATE BEFORE PRODUCTION
          </h2>
          <p className="text-sm text-rose-900">
            {liveSeeded.map((u) => u.email).join(' and ')}{' '}
            {liveSeeded.length === 1 ? 'was' : 'were'} created by{' '}
            <code className="rounded bg-white/70 px-1">prisma/seed.ts</code> with a password that
            is committed to this repository, so anyone who can read the source can sign in.{' '}
            {realAdminExists
              ? 'A real Finance Admin now exists, so you can deactivate them: press DEACTIVATE on each row below.'
              : 'Create a real Finance Admin first — until one exists, deactivating these would ' +
                'leave nobody able to administer the system and will be refused.'}
          </p>
          <p className="text-sm text-rose-900">
            Deactivate, never delete: these accounts may already be named in the audit trail, and a
            deleted row would take that attribution with it.
          </p>
        </section>
      )}

      <CreateUserForm />

      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between p-6 pb-4">
          <h2 className="text-sm font-semibold tracking-wide">USERS</h2>
          <p className="text-sm text-slate-500">
            {activeAdmins.length} ACTIVE FINANCE ADMIN{activeAdmins.length === 1 ? '' : 'S'}
          </p>
        </div>

        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">NAME</th>
              <th className="px-4 py-3">EMAIL</th>
              <th className="px-4 py-3">ROLE</th>
              <th className="px-4 py-3">STATUS</th>
              <th className="px-4 py-3">LAST LOGIN</th>
              <th className="px-4 py-3">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr
                key={u.id}
                className={`border-b border-slate-100 last:border-0 ${u.active ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-500'}`}
              >
                <td className="px-4 py-3 font-medium">
                  {u.name}
                  {u.isSeededTestAccount && (
                    <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] tracking-wide text-rose-800">
                      SEEDED TEST ACCOUNT
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">{u.email}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${
                      u.role === 'FINANCE_ADMIN' ? 'bg-indigo-50 text-indigo-800' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {u.role.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${
                      u.active ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
                    }`}
                  >
                    {u.active ? 'ACTIVE' : 'DEACTIVATED'}
                  </span>
                </td>
                {/* An em dash, not an empty cell: an account that has never been
                    signed into is a fact worth reading, and a blank reads as a
                    rendering fault. Matches CheckTable and the sync log. */}
                <td className="px-4 py-3 text-slate-600">{fmtDateTime(u.lastLoginAt) ?? 'NEVER SIGNED IN'}</td>
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

      <p className="max-w-4xl rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
        Accounts are never deleted here. A user is named on the cheques they signed, marked ready,
        released or cancelled, and on every audit entry they wrote; deleting the row would blank
        that attribution out rather than fail. DEACTIVATE is removal — a deactivated account is
        refused at sign-in and keeps its history. The last active Finance Admin can be neither
        deactivated nor demoted, including by themselves.
      </p>
    </div>
  )
}
