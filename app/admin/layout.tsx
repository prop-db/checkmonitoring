import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { AppHeader } from '@/components/AppHeader'

// Every admin route is FINANCE_ADMIN only (spec §12). Enforced here so a new
// page under /admin is gated by existing, not by its author remembering — and
// again in each page, because a layout is a convenience and the guard is not.
//
// `requireAdmin` REDIRECTS a Finance user, which is right for a page and wrong
// for a server action: an action returns its refusal instead, because a thrown
// redirect inside one is caught by the action's own error handling. See
// `app/admin/actions.ts`.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin()

  const tabs = [
    ['/admin/users', 'USERS'],
    ['/admin/sync', 'SYNC'],
    ['/admin/import', 'IMPORT'],
    ['/admin/staged', 'STAGED QUEUE'],
  ] as const

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      {/* `showAdminLink={false}`: these ARE the administration pages. */}
      <AppHeader
        user={user}
        title="ADMINISTRATION"
        back={{ href: '/', label: '← DASHBOARD' }}
        showAdminLink={false}
      />

      <nav className="flex gap-2">
        {tabs.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            {label}
          </Link>
        ))}
      </nav>

      {children}
    </main>
  )
}
