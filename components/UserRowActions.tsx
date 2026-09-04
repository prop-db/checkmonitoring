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
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
          >
            <option value="FINANCE_USER">FINANCE USER</option>
            <option value="FINANCE_ADMIN">FINANCE ADMIN</option>
          </select>
          <button
            type="submit" disabled={pending}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-50"
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
                ? 'rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-800 ring-1 ring-rose-200 hover:bg-rose-50 disabled:opacity-50'
                : 'rounded-lg px-2.5 py-1.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-50 disabled:opacity-50'
            }
          >
            {active ? 'DEACTIVATE' : 'REACTIVATE'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setShowPassword((s) => !s)}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
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
            className="w-56 rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
          />
          <button
            type="submit" disabled={pending}
            className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending ? 'SAVING…' : 'SET'}
          </button>
        </form>
      )}

      {isSelf && (
        <p className="text-xs text-slate-500">THIS IS YOUR OWN ACCOUNT.</p>
      )}

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{result.message}</p>
      )}
      {result && result.ok && (
        <p className="rounded-lg bg-emerald-50 p-2 text-xs text-emerald-900">Saved.</p>
      )}
    </div>
  )
}
