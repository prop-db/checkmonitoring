# Landing page, sign-in page and the pastel theme — design

Date: 2026-09-27. Request: "create a landing page. a cash register on the left dispensing money
and check register in the right dispensing money. They are continue moving as long as the user
not able to log in. And create a log in page that's very pleasing in color. Professionally look.
Even the dashboard and everything make it professionally done and the color is pleasing.
something pastel and easily to view."

## What is built

1. **`/welcome` — the landing page.** Public. A cash register on the left and a cheque register on
   the right, both drawn inline as SVG and animated with CSS keyframes that loop for ever. Between
   them: the product name, the one-line pipeline
   `ACUMATICA → CHECK RELEASE MONITORING → FINANCE CONFIRMATION → SUPPLIER PORTAL`, and a SIGN IN
   button to `/login`. Nothing on the page reads the database and nothing on it is a figure.
   A signed-in visitor is redirected to `/`.
2. **`/login` — the sign-in page**, re-laid-out as two panels: the same two machines on the left,
   still running, and the form on the right. **The form's behaviour is unchanged**: same `signIn`
   call, same field names, same generic error text, same standing throttle note. A signed-in
   visitor is redirected to `/`.
3. **"They keep moving until the user signs in"**: the machines appear on the two pages an
   anonymous visitor can reach and nowhere a signed-in one lands. An anonymous request for `/` goes
   to `/welcome`; an anonymous request for any other guarded page goes to `/login`, as before,
   because a deep link deserves the form, not a brochure. Sign-out lands on `/welcome`.
4. **The theme.** The palette of 2026-09-06 (navy ink on pale grounds) stays and is extended with
   three more pastel pairs (lavender, sky, mint) used by the illustrations and the header. The page
   ground becomes a soft vertical gradient instead of flat `#F8FAFC`; the type stack is set
   explicitly; the signed-in header gains the same brand mark the sign-in page carries; cards gain
   a faint shadow so they lift off the gradient; the KPI cards' icons sit in tinted discs.
   No component's data, links or behaviour changes.

## Where

| File | Role |
| --- | --- |
| `components/MoneyMachines.tsx` | The two machines. Server component, inline SVG, no JavaScript. `size` prop. |
| `app/globals.css` | The keyframes (`mm-*`), the gradient ground, `prefers-reduced-motion` pause. |
| `app/welcome/page.tsx` | The landing page. |
| `app/login/page.tsx` | The two-panel sign-in page. |
| `lib/public-paths.ts` | `/welcome` is public, exact match. Pinned in `tests/public-paths.test.ts`. |
| `middleware.ts` | Anonymous `/` → `/welcome`; anything else guarded → `/login`. |
| `app/actions.ts` | Sign-out redirects to `/welcome`. |
| `tailwind.config.ts` | Font stack, three new pastel pairs. |
| `components/AppHeader.tsx`, `SummaryCards.tsx`, `ModuleNav.tsx`, `AdminTabs.tsx`, `Panel.tsx` | Presentation only. |

## What does not change

- `requireUser()` still redirects to `/login` (pinned by `tests/auth/guards.test.ts`). The page
  guards remain the primary control; the middleware's new branch is a courtesy for the bare URL.
- Authentication, the throttle, the generic error and the session shape are untouched.
- No supplier-facing content: the landing page names the system and asks for a sign-in.

## Motion

Every animation is CSS on SVG groups: the drawer slides, bills rise and fade, cheques feed out of
the slot and drift, each with a staggered delay so the loop never looks like a loop. Under
`prefers-reduced-motion: reduce` every `mm-*` animation is stopped, and the page reads the same.
