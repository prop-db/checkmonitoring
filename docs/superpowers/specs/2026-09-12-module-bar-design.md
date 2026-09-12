# Module bar — design

**What it is.** Every signed-in page carries the same bar of modules — CHECK RELEASE · VOUCHERS ·
FORECAST · CLEARING · RECON · ADMINISTRATION — with the current one highlighted, under the product
name and above the page's own title. Client request 2026-09-12: *"I want this all to have their
own module like CHECK RELEASE."* Decided the same day: a module bar on every page; no home page of
cards.

## Why

The header grew one underlined link at a time as each report was built — VOUCHERS, FORECAST,
CLEARING, RECON — each hidden on its own page and shown everywhere else, beside a page title that
on the dashboard is also the product's name. Four reports and an administration area are five
peers of the cheque dashboard, and the screen should say so the way the admin tabs already say
which admin page you are on.

## A. The mapping — `lib/module-nav.ts`, pure

```ts
export type ModuleId = 'CHECK_RELEASE' | 'VOUCHERS' | 'FORECAST' | 'CLEARING' | 'RECON' | 'ADMINISTRATION'
export type Module = { id: ModuleId; label: string; href: string; adminOnly: boolean }
export const MODULES: readonly Module[]          // in bar order; ADMINISTRATION last, adminOnly
export function activeModule(pathname: string): ModuleId
export function modulesFor(role: 'FINANCE_USER' | 'FINANCE_ADMIN'): readonly Module[]
```

| module | href | lights on |
| --- | --- | --- |
| CHECK RELEASE | `/` | `/`, `/checks/…`, `/receipts/…`, and any path no other module claims |
| VOUCHERS | `/vouchers` | `/vouchers…` |
| FORECAST | `/forecast` | `/forecast…` (planned outflows included) |
| CLEARING | `/clearing` | `/clearing…` |
| RECON | `/recon` | `/recon…` |
| ADMINISTRATION | `/admin/sync` | `/admin…` |

Longest prefix wins; `/` is the fallback, so a future page under no module still lights something
rather than nothing.

## B. The bar — `components/ModuleNav.tsx`, client

`usePathname()` is the whole reason it is a client component, exactly as `AdminTabs`. It renders
`modulesFor(role)` as links; the active one is the filled navy pill with `aria-current="page"`,
the rest the plain pill — the same classes `AdminTabs` uses, so the two rows read as one system.
**It highlights; it never gates.** Every page keeps `requireUser()` / `requireAdmin()` and the
admin layout keeps its own guard.

## C. The header — `components/AppHeader.tsx`

Three lines:

1. Product name `CHECK RELEASE MONITORING` (small, tracked, muted) on the left; the user, their
   email and role, and SIGN OUT on the right — unchanged in substance.
2. The module bar.
3. The page title as `h1`, with the back link beside it when the page passes one.

The five `show…Link` props are removed; the bar always shows every module the role may see. The
dashboard's title becomes `CHECK RELEASE`, since the product name now sits above it. The admin
layout renders its `AdminTabs` beneath the header as today, so an admin page shows the module bar
(ADMINISTRATION lit) and then the admin tabs.

## D. Not in this design

- A home page of module cards; new routes; any change to a guard.
- The sign-out form, which stays a plain `<form>` so it works before hydration.

## Testing

`tests/module-nav.test.ts`: `activeModule` for each module's own path and a sub-path, the
fallback, the longest-prefix rule (`/forecast/planned` → FORECAST, `/admin/settings` →
ADMINISTRATION); `modulesFor` hides ADMINISTRATION from a FINANCE_USER. `tsc`; `next build`.
