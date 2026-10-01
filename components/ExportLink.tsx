'use client'

import type { ReactNode } from 'react'
import { COLUMN_STORAGE_KEY, DEFAULT_COLUMNS, parseColumnPreference, withColumnOrder } from '@/lib/table-columns'

/**
 * EXPORT EXCEL, in the viewer's column order (spec C3). The order lives only in
 * this browser's `localStorage`, so it is added to the link at click time.
 * Without JavaScript — or with storage blocked — the plain link exports in
 * the default order. A modified click (new tab, save link) is left alone.
 */
export function ExportLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        let order = DEFAULT_COLUMNS
        try {
          order = parseColumnPreference(window.localStorage.getItem(COLUMN_STORAGE_KEY)) ?? DEFAULT_COLUMNS
        } catch {
          // Blocked storage: the default order.
        }
        e.preventDefault()
        window.location.assign(withColumnOrder(href, order))
      }}
    >
      {children}
    </a>
  )
}
