/**
 * THE CATEGORY LIST'S LEAF.
 *
 * Both the registry (which declares the `categories` setting) and the domain
 * (which refuses a category not on the list) need these two things, and they
 * must not reach each other for them: the registry imports the sync module for
 * a constant, the sync module imports the importer, the importer imports the
 * domain — so a domain file importing the registry closes a cycle in which the
 * registry's `SETTINGS` could be built before the sync module's constant is
 * initialised. Found in review 2026-09-12. This file imports nothing.
 */

/** The importer's own set, which is also what a fresh database offers. */
export const DEFAULT_CATEGORIES: readonly string[] = [
  'LOCAL SUPPLIER', 'PAYROLL', 'UTILITIES', 'TAX', 'FUND TRANSFER', 'BROKERS', 'SALARIES', 'FTP', 'TRANSPO,GAS AND OIL',
]

export function isCategory(list: readonly string[], value: string): boolean {
  return list.includes(value.trim().toUpperCase())
}
