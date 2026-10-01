import { sortCookieString, type SortSpec } from '@/lib/list-sort'

/**
 * Remember (or forget) the list's order — "remember my sort", part C4. Called
 * from a click handler, before the navigation it belongs to, so the server
 * render that follows already sees it. A browser that blocks cookies loses
 * only the memory; the URL still carries the sort.
 */
export function writeSortCookie(next: SortSpec | null): void {
  try {
    document.cookie = sortCookieString(next)
  } catch {
    // Nothing on this screen is worth an error over a remembered preference.
  }
}
