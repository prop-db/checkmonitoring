# Module Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every signed-in page carries one bar of modules — CHECK RELEASE · VOUCHERS · FORECAST · CLEARING · RECON · ADMINISTRATION — with the current one highlighted, under the product name and above the page title.

**Architecture:** A pure mapping module names the modules and resolves a pathname to the active one (longest prefix, `/` as fallback). A client `ModuleNav` renders it with `usePathname`, styled exactly as `AdminTabs`. `AppHeader` becomes three lines and drops its five show-link props; the nine call sites drop the props they passed. No guard changes.

**Tech Stack:** Next 15 App Router · React server + client components · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-module-bar-design.md`. Read it before Task 1.

## Global Constraints

- **`tsc --noEmit` must pass before the task is called done.** Use `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vitest/vitest.mjs run <file>`, and `node node_modules/next/dist/bin/next build` — the `npx.cmd` shim breaks on the space in the repo path. **Every command in the foreground.**
- **Run ONLY `tests/module-nav.test.ts`.** It is pure — no database.
- **The bar highlights; it never gates.** No `requireUser` / `requireAdmin` call is added, moved or removed.
- **The sign-out form stays a plain `<form>`** posting `signOutAction`.
- **No raw control characters. British spelling in prose.**
- **Commit message ends with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/module-nav.ts` | **Create.** Pure: `MODULES`, `activeModule`, `modulesFor`. |
| `components/ModuleNav.tsx` | **Create.** Client: renders the bar. |
| `components/AppHeader.tsx` | **Modify.** Three lines; props reduced to `user`, `title`, `back`. |
| `app/page.tsx`, `app/vouchers/page.tsx`, `app/forecast/page.tsx`, `app/forecast/planned/page.tsx`, `app/clearing/page.tsx`, `app/recon/page.tsx`, `app/checks/[id]/page.tsx`, `app/receipts/[id]/page.tsx`, `app/admin/layout.tsx` | **Modify.** Drop the removed props; the dashboard's title becomes `CHECK RELEASE`. |
| `tests/module-nav.test.ts` | **Create.** |

---

### Task 1: The module bar

**Files:**
- Create: `lib/module-nav.ts`, `components/ModuleNav.tsx`, `tests/module-nav.test.ts`
- Modify: `components/AppHeader.tsx` and the nine call sites above

- [ ] **Step 1: Write the failing test**

Create `tests/module-nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MODULES, activeModule, modulesFor } from '@/lib/module-nav'

describe('MODULES', () => {
  it('lists the six in bar order, ADMINISTRATION last and admin-only', () => {
    expect(MODULES.map((m) => m.id)).toEqual(['CHECK_RELEASE', 'VOUCHERS', 'FORECAST', 'CLEARING', 'RECON', 'ADMINISTRATION'])
    expect(MODULES.map((m) => m.adminOnly)).toEqual([false, false, false, false, false, true])
    expect(MODULES.find((m) => m.id === 'ADMINISTRATION')!.href).toBe('/admin/sync')
    expect(MODULES.find((m) => m.id === 'CHECK_RELEASE')!.label).toBe('CHECK RELEASE')
  })
})

describe('activeModule', () => {
  it('lights each module on its own path and on a sub-path', () => {
    expect(activeModule('/')).toBe('CHECK_RELEASE')
    expect(activeModule('/checks/abc')).toBe('CHECK_RELEASE')
    expect(activeModule('/receipts/abc')).toBe('CHECK_RELEASE')
    expect(activeModule('/vouchers')).toBe('VOUCHERS')
    expect(activeModule('/forecast')).toBe('FORECAST')
    expect(activeModule('/forecast/planned')).toBe('FORECAST')
    expect(activeModule('/clearing')).toBe('CLEARING')
    expect(activeModule('/recon')).toBe('RECON')
    expect(activeModule('/admin/sync')).toBe('ADMINISTRATION')
    expect(activeModule('/admin/settings')).toBe('ADMINISTRATION')
  })

  it('falls back to CHECK RELEASE for a path no module claims', () => {
    expect(activeModule('/something-new')).toBe('CHECK_RELEASE')
  })

  it('matches whole segments only', () => {
    expect(activeModule('/reconciliation')).toBe('CHECK_RELEASE')
    expect(activeModule('/forecasting')).toBe('CHECK_RELEASE')
  })
})

describe('modulesFor', () => {
  it('hides ADMINISTRATION from a Finance user and shows it to an admin', () => {
    expect(modulesFor('FINANCE_USER').map((m) => m.id)).not.toContain('ADMINISTRATION')
    expect(modulesFor('FINANCE_ADMIN').map((m) => m.id)).toContain('ADMINISTRATION')
    expect(modulesFor('FINANCE_USER')).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/module-nav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The mapping**

Create `lib/module-nav.ts`:

```ts
/**
 * THE MODULES, and which one a path belongs to.
 *
 * Six peers: the cheque dashboard and the four reports built in September
 * 2026, plus administration. Client request 2026-09-12: "I want this all to
 * have their own module like CHECK RELEASE." Pure: the bar reads this and
 * decides nothing itself. It highlights; it never gates — every page keeps
 * its own `requireUser()` / `requireAdmin()`.
 */
export type ModuleId = 'CHECK_RELEASE' | 'VOUCHERS' | 'FORECAST' | 'CLEARING' | 'RECON' | 'ADMINISTRATION'
export type Module = {
  id: ModuleId
  label: string
  href: string
  /** The path prefixes that light this module. Whole segments; longest wins. */
  prefixes: readonly string[]
  adminOnly: boolean
}

export const MODULES: readonly Module[] = [
  { id: 'CHECK_RELEASE', label: 'CHECK RELEASE', href: '/', prefixes: ['/', '/checks', '/receipts'], adminOnly: false },
  { id: 'VOUCHERS', label: 'VOUCHERS', href: '/vouchers', prefixes: ['/vouchers'], adminOnly: false },
  { id: 'FORECAST', label: 'FORECAST', href: '/forecast', prefixes: ['/forecast'], adminOnly: false },
  { id: 'CLEARING', label: 'CLEARING', href: '/clearing', prefixes: ['/clearing'], adminOnly: false },
  { id: 'RECON', label: 'RECON', href: '/recon', prefixes: ['/recon'], adminOnly: false },
  { id: 'ADMINISTRATION', label: 'ADMINISTRATION', href: '/admin/sync', prefixes: ['/admin'], adminOnly: true },
]

/** True when `pathname` is `prefix` or lies under it as a whole segment. */
function under(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** The module a path belongs to. Longest matching prefix wins; CHECK RELEASE is the fallback. */
export function activeModule(pathname: string): ModuleId {
  let best: { id: ModuleId; length: number } | null = null
  for (const m of MODULES) {
    for (const p of m.prefixes) {
      if (under(pathname, p) && (best === null || p.length > best.length)) best = { id: m.id, length: p.length }
    }
  }
  return best?.id ?? 'CHECK_RELEASE'
}

export function modulesFor(role: 'FINANCE_USER' | 'FINANCE_ADMIN'): readonly Module[] {
  return role === 'FINANCE_ADMIN' ? MODULES : MODULES.filter((m) => !m.adminOnly)
}
```

- [ ] **Step 4: Run the test**

Run: `node node_modules/vitest/vitest.mjs run tests/module-nav.test.ts`
Expected: PASS (5).

- [ ] **Step 5: The bar**

Create `components/ModuleNav.tsx`:

```tsx
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
            m.id === active ? 'bg-navy text-white' : 'bg-white text-slate-600 ring-1 ring-hairline hover:ring-navy'
          }`}
        >
          {m.label}
        </Link>
      ))}
    </nav>
  )
}
```

- [ ] **Step 6: The header**

Replace `components/AppHeader.tsx` with:

```tsx
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
```

- [ ] **Step 7: The call sites**

Remove every `showAdminLink`, `showVouchersLink`, `showForecastLink`, `showClearingLink`, `showReconLink` prop from the nine call sites (`grep -rn "show[A-Za-z]*Link" app` must return nothing afterwards). In `app/page.tsx` change `title="CHECK RELEASE MONITORING"` to `title="CHECK RELEASE"`. In `app/checks/[id]/page.tsx` change its title from `CHECK RELEASE MONITORING` to `CHEQUE` (the product name now sits above it, and the identity card below already carries the cheque number). Leave every `back` prop as it is; the admin layout keeps rendering `AdminTabs` under the header.

- [ ] **Step 8: tsc and build**

Run: `node node_modules/typescript/bin/tsc --noEmit` — clean (a call site still passing a removed prop fails here). Run: `node node_modules/next/dist/bin/next build` — succeeds.

- [ ] **Step 9: Commit**

```bash
git add lib/module-nav.ts components/ModuleNav.tsx components/AppHeader.tsx tests/module-nav.test.ts app/page.tsx app/vouchers/page.tsx app/forecast/page.tsx app/forecast/planned/page.tsx app/clearing/page.tsx app/recon/page.tsx "app/checks/[id]/page.tsx" "app/receipts/[id]/page.tsx" app/admin/layout.tsx
git commit -m "feat: a module bar on every page - the four reports and administration as peers of CHECK RELEASE

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** A the mapping with longest-prefix and fallback; B the bar with the admin-tab classes and `aria-current`; C the three-line header, the props removed, the dashboard title; D no guard touched. Testing: the pure file, `tsc`, `next build`.

**Deviations, stated.** The cheque page's title becomes `CHEQUE` (the spec named only the dashboard); the product name is on line one on every page, so a page repeating it read twice.

**Type consistency.** `ModuleId`/`modulesFor`/`activeModule` (lib) are what `ModuleNav` consumes; `AppHeader`'s props narrow to three and every call site is listed.
