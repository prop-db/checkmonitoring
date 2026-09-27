'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The administration tabs.
 *
 * They were four identical white pills with no indication of which one you were
 * looking at — on a four-page area where three of the pages are tables of
 * similar shape, that is a real question a reader had to answer by re-reading
 * the content.
 *
 * A client component only because the current path is a browser fact.
 * `usePathname` is the whole of it: nothing here fetches, guards or decides
 * anything. **The routes are gated in `app/admin/layout.tsx` and again in each
 * page** — `requireAdmin()` on the server, in the request path, exactly as the
 * note in CLAUDE.md about `middleware.ts` requires. Highlighting a tab is not a
 * permission and this file must never grow into one.
 *
 * `startsWith` rather than equality, so a future `/admin/users/<id>` still
 * lights USERS.
 */
export function AdminTabs({ tabs }: { tabs: readonly (readonly [string, string])[] }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-wrap gap-2" aria-label="Administration">
      {tabs.map(([href, label]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            // Announced, not only tinted — the same reason the dashboard cards
            // carry `aria-current` beside their outline.
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-4 py-2 text-sm font-medium tracking-wide transition ${
              active
                ? 'bg-navy text-white shadow-sm'
                : 'bg-white text-slate-600 ring-1 ring-hairline hover:bg-navy-bg hover:text-navy hover:ring-navy/40'
            }`}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
