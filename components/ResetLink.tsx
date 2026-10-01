'use client'

import { writeSortCookie } from './sort-cookie'

/**
 * RESET: every filter AND the remembered sort. A plain anchor — a full page
 * load, for the reason FilterBar gives (the boxes' `defaultValue`s must be
 * re-applied) — that deletes `cm_sort` on the way out. Without JavaScript the
 * URL is still reset; the cookie survives, which only means the list opens on
 * the reader's own last sort.
 */
export function ResetLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      onClick={() => writeSortCookie(null)}
      className="h-10 rounded-lg px-3 py-2 text-sm font-medium text-navy underline underline-offset-2 hover:text-slate-900"
    >
      RESET
    </a>
  )
}
