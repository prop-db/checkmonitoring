'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { activeModule, modulesFor } from '@/lib/module-nav'

/**
 * The module bar. A client component only because the current path is a
 * browser fact — `usePathname` is the whole of it, exactly as `AdminTabs`.
 * Same pill classes as `AdminTabs`, so the two rows read as one system.
 * **It highlights; it never gates.** Every page keeps its own guard.
 */
export function ModuleNav({ role }: { role: 'FINANCE_USER' | 'FINANCE_ADMIN' }) {
  const pathname = usePathname()
  const active = activeModule(pathname)
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Modules">
      {modulesFor(role).map((m) => (
        <Link
          key={m.id}
          href={m.href}
          aria-current={m.id === active ? 'page' : undefined}
          className={`rounded-lg px-4 py-2 text-sm font-medium tracking-wide transition ${
            m.id === active
              ? 'bg-navy text-white shadow-sm'
              : 'bg-white text-slate-600 ring-1 ring-hairline hover:bg-navy-bg hover:text-navy hover:ring-navy/40'
          }`}
        >
          {m.label}
        </Link>
      ))}
    </nav>
  )
}
