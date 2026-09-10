'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Role } from '@prisma/client'
import type { AdminActionResult } from '@/app/admin/actions'
import {
  changeUserRoleAction, setUserActiveAction, setUserPasswordAction,
} from '@/app/admin/users/actions'

/**
 * The per-row controls: change role, deactivate/reactivate, set password.
 *
 * **There is no delete button, because there is no delete action to point one
 * at.** Removal is DEACTIVATE: the row keeps every attribution it carries on
 * cheques and audit entries, and `authorize` refuses it at sign-in. See
 * `lib/admin/users.ts`.
 *
 * The last-active-admin refusal is enforced on the server, not by disabling a
 * control here. A disabled button is a hint; the guard has to hold against a
 * hand-made request too, and it is the only thing standing between one click
 * and nobody being able to administer the system. What this component does is
 * *show* the refusal, in the row it belongs to.
 *
 * Takes plain fields rather than an `AdminUserRow`, so nothing that is not
 * needed for these three controls can be added to what crosses into the
 * browser.
 */
export function UserRowActions({
  userId, name, role, active, isSelf,
}: {
  userId: string
  name: string
  role: Role
  active: boolean
  isSelf: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<AdminActionResult | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const submit = (action: (fd: FormData) => Promise<AdminActionResult>) =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      const form = e.currentTarget
      const formData = new FormData(form)
      startTransition(async () => {
        const r = await action(formData)
        setResult(r)
        if (r.ok) {
          // Clears the typed password out of the DOM as well as refreshing the
          // list.
          form.reset()
          setShowPassword(false)
          router.refresh()
        }
      })
    }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex items-center gap-2" onSubmit={submit(changeUserRoleAction)}>
          <input type="hidden" name="userId" value={userId} />
          <select
            name="role" defaultValue={role} aria-label={`Role for ${name}`}
            className="rounded-lg border border-hairline bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
          >
            <option value="FINANCE_USER">FINANCE USER</option>
            <option value="FINANCE_ADMIN">FINANCE ADMIN</option>
          </select>
          <button
            type="submit" disabled={pending}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-hairline hover:ring-navy disabled:opacity-50"
          >
            SAVE ROLE
          </button>
        </form>

        <form onSubmit={submit(setUserActiveAction)}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="active" value={active ? 'false' : 'true'} />
          <button
            type="submit" disabled={pending}
            className={
              active
                ? 'rounded-lg px-2.5 py-1.5 text-xs font-medium text-danger-ink ring-1 ring-danger-ink/20 hover:bg-danger-bg disabled:opacity-50'
                : 'rounded-lg px-2.5 py-1.5 text-xs font-medium text-success-ink ring-1 ring-success-ink/20 hover:bg-success-bg disabled:opacity-50'
            }
          >
            {active ? 'DEACTIVATE' : 'REACTIVATE'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setShowPassword((s) => !s)}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-hairline hover:ring-navy"
        >
          {showPassword ? 'CANCEL' : 'SET PASSWORD'}
        </button>
      </div>

      {showPassword && (
        <form className="flex items-center gap-2" onSubmit={submit(setUserPasswordAction)}>
          <input type="hidden" name="userId" value={userId} />
          <input
            name="password" type="password" required autoComplete="new-password"
            aria-label={`New password for ${name}`}
            placeholder="NEW PASSWORD"
            className="w-56 rounded-lg border border-hairline bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
          />
          <button
            type="submit" disabled={pending}
            className="rounded-lg bg-navy px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-navy/90 disabled:opacity-50"
          >
            {pending ? 'SAVING…' : 'SET'}
          </button>
        </form>
      )}

      {isSelf && (
        <p className="text-xs text-slate-500">THIS IS YOUR OWN ACCOUNT.</p>
      )}

      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg p-2 text-xs text-warning-ink">{result.message}</p>
      )}
      {result && result.ok && (
        <p className="rounded-lg bg-success-bg p-2 text-xs text-success-ink">Saved.</p>
      )}
    </div>
  )
}
