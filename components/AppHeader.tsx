import Link from 'next/link'
import { signOutAction } from '@/app/actions'
import type { SessionUser } from '@/lib/auth'

/**
 * The header every signed-in page carries: who you are, and how to stop being
 * signed in.
 *
 * Shared rather than repeated, because "there is no way to sign out" was true
 * of every page in this application until this component existed, and a
 * per-page copy is how one page quietly loses the control again.
 *
 * The sign-out control is a plain `<form>` posting a server action, not a
 * client component with an onClick. It therefore works before React hydrates
 * and on a page with a JavaScript error — which is exactly when a shared
 * workstation most needs to be signable-out of. `/login` is the only page
 * without this header, and it has nothing to sign out of.
 */
export function AppHeader({
  user, title, back, showAdminLink = true, showVouchersLink = true, showForecastLink = true,
}: {
  user: SessionUser
  title: string
  back?: { href: string; label: string }
  /** False on the admin pages, which ARE the administration area. */
  showAdminLink?: boolean
  /** False on the vouchers page, which IS the voucher screen. */
  showVouchersLink?: boolean
  /** False on the forecast page, which IS the forecast. */
  showForecastLink?: boolean
}) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-4">
      <div className="flex items-baseline gap-6">
        {back && (
          <Link href={back.href} className="text-sm text-slate-500 underline underline-offset-2">
            {back.label}
          </Link>
        )}
        <h1 className="text-xl font-semibold tracking-wide">{title}</h1>
      </div>

      <div className="flex items-baseline gap-4 text-sm text-slate-500">
        {/* Every signed-in user. The page is guarded server-side; the link is
            shown to everyone because the question it answers — which cheque
            pays this voucher — is a Finance user's question, not an admin's. */}
        {showVouchersLink && (
          <Link href="/vouchers" className="underline underline-offset-2">VOUCHERS</Link>
        )}
        {showForecastLink && (
          <Link href="/forecast" className="underline underline-offset-2">FORECAST</Link>
        )}
        {/* Shown only to an admin. The route is guarded server-side either way
            (app/admin/layout.tsx); hiding the link keeps a Finance user from
            being offered a page that would bounce them back. */}
        {showAdminLink && user.role === 'FINANCE_ADMIN' && (
          <Link href="/admin/sync" className="underline underline-offset-2">ADMINISTRATION</Link>
        )}
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
    </header>
  )
}
