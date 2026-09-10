'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createUserAction } from '@/app/admin/users/actions'
import type { AdminActionResult } from '@/app/admin/actions'

/**
 * CREATE USER.
 *
 * The password is typed here by the admin at the keyboard and goes exactly one
 * way: into the action, into argon2id, into the column. It is never generated,
 * never displayed back, and never returned — `createUserAction` answers with a
 * bare `{ ok: true }`, so there is no field in the response that could hold it.
 * The form resets on success, which also clears the password out of the DOM.
 *
 * There is no "email them a reset link" here and there must not be: this system
 * has no mail path at all. A forgotten password is dealt with by SET PASSWORD
 * on the user's own row.
 */
export function CreateUserForm() {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<AdminActionResult | null>(null)

  // One field treatment across the application: hairline border, navy focus.
  // The dashboard's filter bar settled it; repeating `border-slate-300` here is
  // how the two screens drifted apart in the first place.
  const field =
    'h-10 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 ' +
    'focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400'

  return (
    <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-hairline">
      <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">CREATE USER</h2>

      <form
        ref={formRef}
        className="grid gap-4 md:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault()
          const formData = new FormData(e.currentTarget)
          startTransition(async () => {
            const r = await createUserAction(formData)
            setResult(r)
            if (r.ok) {
              formRef.current?.reset()
              router.refresh()
            }
          })
        }}
      >
        <div>
          <label className={label} htmlFor="new-user-name">
            NAME
          </label>
          <input
            id="new-user-name" name="name" required autoComplete="off"
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor="new-user-email">
            EMAIL
          </label>
          <input
            id="new-user-email" name="email" type="email" required autoComplete="off"
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor="new-user-role">
            ROLE
          </label>
          <select
            id="new-user-role" name="role" defaultValue="FINANCE_USER"
            className={field}
          >
            <option value="FINANCE_USER">FINANCE USER</option>
            <option value="FINANCE_ADMIN">FINANCE ADMIN</option>
          </select>
        </div>

        <div>
          <label className={label} htmlFor="new-user-password">
            PASSWORD
          </label>
          <input
            id="new-user-password" name="password" type="password" required autoComplete="new-password"
            className={field}
          />
        </div>

        <div className="md:col-span-4">
          <button
            type="submit" disabled={pending}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
          >
            {pending ? 'CREATING…' : 'CREATE USER'}
          </button>
        </div>
      </form>

      <p className="text-xs text-slate-500">
        At least 12 characters with a lowercase letter, an uppercase letter, a digit and a symbol.
        Tell the person their password yourself — it is hashed on arrival and cannot be read back
        by anyone, including you.
      </p>

      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg p-3 text-sm text-warning-ink">{result.message}</p>
      )}
      {result && result.ok && (
        <p className="rounded-lg bg-success-bg p-3 text-sm text-success-ink">Account created.</p>
      )}
    </section>
  )
}
