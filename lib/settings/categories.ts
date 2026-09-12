/**
 * THE CATEGORY LIST'S LEAF.
 *
 * Both the registry (which declares the `categories` setting) and the domain
 * (which refuses a category not on the list) need these two things. The
 * domain imports this leaf, never the registry, and the registry itself
 * imports only leaves (see ./defaults.ts for why) — so no path from
 * lib/domain/ can reach a server module through settings. This file imports
 * nothing.
 */

/** The importer's own set, which is also what a fresh database offers. */
export const DEFAULT_CATEGORIES: readonly string[] = [
  'LOCAL SUPPLIER', 'PAYROLL', 'UTILITIES', 'TAX', 'FUND TRANSFER', 'BROKERS', 'SALARIES', 'FTP', 'TRANSPO,GAS AND OIL',
]

export function isCategory(list: readonly string[], value: string): boolean {
  return list.includes(value.trim().toUpperCase())
}
