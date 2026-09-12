import Link from 'next/link'
import { signOutAction } from '@/app/actions'
import type { SessionUser } from '@/lib/auth'
import { ModuleNav } from './ModuleNav'

/**
 * The header every signed-in page carries: the product, who you are and how
 * to stop being signed in, the module bar, and the page's own title.
 *
 * Three lines since 2026-09-12 — the client asked for every area to be a
 * module like CHECK RELEASE, so the bar is the same on every page and the
 * current module is lit rather than hidden. The bar highlights; it never
 * gates: every page keeps `requireUser()` / `requireAdmin()`.
 *
 * The sign-out control is a plain `<form>` posting a server action, not a
 * client component with an onClick. It therefore works before React hydrates
 * and on a page with a JavaScript error — which is exactly when a shared
 * workstation most needs to be signable-out of. `/login` is the only page
 * without this header, and it has nothing to sign out of.
 */
export function AppHeader({
  user, title, back,
}: {
  user: SessionUser
  title: string
  back?: { href: string; label: string }
}) {
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <p className="text-[11px] font-semibold tracking-widest text-slate-400">CHECK RELEASE MONITORING</p>
        <div className="flex items-baseline gap-4 text-sm text-slate-500">
          {/* The name, with the email beside it. Two people called "Ronald" is
              not a hypothetical in a finance department, and the address is what
              makes the session unambiguous on a shared machine. */}
          <span className="text-slate-600">
            {user.name} <span className="text-slate-400">({user.email})</span> · {user.role.replace(/_/g, ' ')}
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              SIGN OUT
            </button>
          </form>
        </div>
      </div>

      <ModuleNav role={user.role} />

      <div className="flex flex-wrap items-baseline gap-6">
        <h1 className="text-xl font-semibold tracking-wide">{title}</h1>
        {back && (
          <Link href={back.href} className="text-sm text-slate-500 underline underline-offset-2">
            {back.label}
          </Link>
        )}
      </div>
    </header>
  )
}
