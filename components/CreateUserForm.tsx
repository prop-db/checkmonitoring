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

  return (
    <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-slate-200">
      <h2 className="text-sm font-semibold tracking-wide">CREATE USER</h2>

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
          <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600" htmlFor="new-user-name">
            NAME
          </label>
          <input
            id="new-user-name" name="name" required autoComplete="off"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600" htmlFor="new-user-email">
            EMAIL
          </label>
          <input
            id="new-user-email" name="email" type="email" required autoComplete="off"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600" htmlFor="new-user-role">
            ROLE
          </label>
          <select
            id="new-user-role" name="role" defaultValue="FINANCE_USER"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="FINANCE_USER">FINANCE USER</option>
            <option value="FINANCE_ADMIN">FINANCE ADMIN</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600" htmlFor="new-user-password">
            PASSWORD
          </label>
          <input
            id="new-user-password" name="password" type="password" required autoComplete="new-password"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="md:col-span-4">
          <button
            type="submit" disabled={pending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
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
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
      {result && result.ok && (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">Account created.</p>
      )}
    </section>
  )
}
