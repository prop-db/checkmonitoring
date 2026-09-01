# Check Release Monitoring — Plan 1: Foundation & Domain Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the internal Finance application skeleton — database, authentication, the pure domain rules that govern a check's lifecycle, transactional actions with an append-only audit trail, and the dashboard and check-detail screens — so a Finance user can drive a check from GENERATED through to RELEASED and CLEARED against seeded data.

**Architecture:** Next.js 15 App Router with TypeScript. All business rules live in pure, I/O-free modules under `lib/domain/` and are tested without a database. A single module, `lib/domain/actions.ts`, is the only thing that writes a check's status; it wraps every mutation in one transaction that also appends an audit row. The UI calls server actions that delegate to it. No external integration exists in this plan — Acumatica and the Supplier Portal arrive in Plans 2 and 3.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript (strict), Prisma 6, PostgreSQL 14+, Tailwind CSS 3.4, NextAuth v5 (Credentials provider, JWT sessions), argon2, Vitest, Playwright.

**Source spec:** `docs/superpowers/specs/2026-09-01-check-release-monitoring-design.md`

## Global Constraints

- **This is an internal Finance system.** No supplier login, registration, dashboard, profile, or any supplier-facing route may be created. Every route except `/login` requires an authenticated session.
- **Currency is PHP.** All monetary values are `Decimal(18,2)` in Postgres and `Prisma.Decimal` in TypeScript. Never use JavaScript `number` for money.
- **Timezone is `Asia/Manila`.** Set `process.env.TZ = 'Asia/Manila'` before any other import in `instrumentation.ts`. Every "today" computation uses it.
- **`AuditLog` is append-only.** No update or delete method may exist for it anywhere in the codebase, and `UPDATE`/`DELETE` are revoked at the database level for the application role.
- **The UI never writes a status directly.** Every status mutation goes through `lib/domain/actions.ts`.
- **Status has two axes.** `status` is the release ladder; `clearingStatus` is a separate post-release axis, permitted only when `status = RELEASED`.
- **The rule modules are pure:** `lib/domain/check-status.ts`, `lib/domain/eligibility.ts`, `lib/domain/errors.ts`, and (in Plan 2) `lib/domain/field-sniffer.ts`. No database, network, filesystem, `Date.now()`, or environment access in those files; they are unit-tested without a database. `lib/domain/actions.ts` is the deliberate exception — it is the transactional layer that composes those rules with the database, and it never reaches for a client itself: the caller passes `db` in.
- **UI labels for headings, summary cards, table column headers, and status pills are ALL CAPS.** Light theme, white background, soft pastel status colours, rounded cards.
- TypeScript `strict: true`. No `any` in committed code.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
| --- | --- |
| `instrumentation.ts` | Sets `TZ` before anything else loads |
| `prisma/schema.prisma` | All models and enums |
| `prisma/seed.ts` | Reference data (companies, banks, cash accounts, checkbooks) + fixture checks + users |
| `lib/domain/errors.ts` | `DomainError` with a machine-readable `code` |
| `lib/domain/check-status.ts` | Release-ladder state machine, READY guards, clearing axis. Pure. |
| `lib/domain/eligibility.ts` | SUPPLIER / BROKER / INTERNAL classification. Pure. |
| `lib/domain/actions.ts` | Transactional mutations, each writing an audit row |
| `lib/db.ts` | Prisma client singleton |
| `lib/audit.ts` | `writeAudit()` — the only way audit rows are created |
| `lib/auth.ts` | NextAuth config, `requireUser()`, `requireAdmin()` |
| `lib/money.ts` | PHP formatting helpers |
| `app/login/page.tsx` | Login screen |
| `app/page.tsx` | Dashboard — summary cards + monitoring table |
| `app/checks/[id]/page.tsx` | Check detail + audit trail |
| `app/checks/actions.ts` | Server actions delegating to `lib/domain/actions.ts` |
| `components/` | `SummaryCards`, `CheckTable`, `StatusPill`, `ReadyForReleaseCheckbox`, `ConfirmDialog`, `AuditTrail` |
| `tests/domain/*.test.ts` | Pure unit tests, no database |
| `tests/actions/*.test.ts` | Integration tests against a real test database |

---

## Task 1: Project Scaffold and Tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `instrumentation.ts`, `vitest.config.mts`, `.gitignore`, `.env.example`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a working `npm run dev`, `npm test`, `npm run build`; `instrumentation.ts` guaranteeing `process.env.TZ === 'Asia/Manila'`

- [ ] **Step 1: Initialise the repository and Node project**

```bash
cd "C:/Users/User/Desktop/RCL PROJECTS/Check Monitoring"
git init
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install next@15 react@19 react-dom@19 @prisma/client@6 next-auth@beta argon2 zod decimal.js
npm install -D typescript @types/node @types/react @types/react-dom prisma@6 tailwindcss@3.4 postcss autoprefixer vitest @vitejs/plugin-react dotenv
```

- [ ] **Step 3: Write the config files**

`package.json` — replace the `"scripts"` block with:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "prisma migrate dev",
    "db:seed": "tsx prisma/seed.ts",
    "db:studio": "prisma studio"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: { instrumentationHook: true },
}

export default nextConfig
```

`instrumentation.ts` — this must set the timezone before anything else loads:

```ts
// The business runs on Philippine time. Set TZ before any module that reads
// dates is imported, so every server-side "today" is Manila-local.
export async function register() {
  process.env.TZ = process.env.TZ || 'Asia/Manila'
}
```

`tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        status: {
          generated: '#EEF2F7',
          pending: '#FEF6E0',
          signed: '#E6F0FB',
          ready: '#E3F5E9',
          scheduled: '#EAF0FD',
          released: '#EDEBF7',
          cancelled: '#FAEAEA',
        },
      },
    },
  },
  plugins: [],
}

export default config
```

`postcss.config.mjs`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-white text-slate-800 antialiased;
}
```

`app/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CHECK RELEASE MONITORING',
  description: 'Internal Finance check release monitoring system',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

`app/page.tsx` — a placeholder replaced in Task 9:

```tsx
export default function Home() {
  return <main className="p-8"><h1 className="text-2xl font-semibold">CHECK RELEASE MONITORING</h1></main>
}
```

`vitest.config.mts` — the `.mts` extension matters: with no `"type": "module"` in
`package.json`, a `.ts` config is loaded as CommonJS and Vite warns about the ESM
syntax on every run. Path aliases use Vite's native resolution rather than the
`vite-tsconfig-paths` plugin, which Vite now warns is redundant.

```ts
import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'

// Vitest does not put .env into process.env on its own. Without this, every
// database test reads `undefined` for DATABASE_URL_TEST — and Prisma silently
// falls back to the schema's DATABASE_URL, aiming a suite that truncates every
// table at the application database.
// `quiet` suppresses dotenv's startup banner, which includes rotating
// promotional tips. Test output must stay pristine so real warnings are visible.
config({ quiet: true })

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
```

`.gitignore`:

```
node_modules/
.next/
.env
.env.local
*.log
/coverage

# Source workbooks hold real vendor names, amounts and check numbers.
# They are monthly inputs, not source. Git history is permanent — keep them out.
*.xlsx
```

`.env.example`:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/check_monitoring"
DATABASE_URL_TEST="postgresql://postgres:postgres@localhost:5432/check_monitoring_test"
AUTH_SECRET="generate-with-openssl-rand-base64-32"
```

- [ ] **Step 4: Write the failing smoke test**

`tests/smoke.test.ts`:

The test must control `process.env.TZ` itself. Asserting the value after calling
`register()` without first clearing it proves nothing — it passes whenever the
ambient environment already happens to say `Asia/Manila`, even if `register()`
were a no-op. Both branches of the `||` need exercising.

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { register } from '@/instrumentation'

describe('instrumentation', () => {
  const original = process.env.TZ

  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it('pins the timezone to Asia/Manila when none is configured', async () => {
    delete process.env.TZ
    await register()
    expect(process.env.TZ).toBe('Asia/Manila')
  })

  it('leaves an explicitly configured timezone alone', async () => {
    process.env.TZ = 'UTC'
    await register()
    expect(process.env.TZ).toBe('UTC')
  })
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: `2 passed`, with no warnings in the output. If it fails with "Cannot find module '@/instrumentation'", the `@/` alias is not resolving — confirm `resolve: { tsconfigPaths: true }` is set in `vitest.config.mts` and that `paths` in `tsconfig.json` maps `@/*` to `./*`.

- [ ] **Step 6: Verify the app builds**

Run: `npm run build`
Expected: build completes, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 15 + TypeScript + Tailwind + Vitest

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Database Schema

**Files:**
- Create: `prisma/schema.prisma`, `lib/db.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: Task 1's project setup
- Produces: `prisma` client singleton exported from `lib/db.ts`; enums `CheckStatus`, `ClearingStatus`, `Eligibility`, `PortalDomain`, `PortalSyncStatus`, `Role`, `ActorType`, `PortalDirection`; models `Company`, `Bank`, `CashAccount`, `CheckBook`, `Vendor`, `Check`, `CheckBill`, `AuditLog`, `PortalEvent`, `SyncRun`, `Notification`, `User`, `Setting`

- [ ] **Step 1: Confirm the databases are reachable**

The databases are already provisioned on **Neon** (cloud PostgreSQL, region
`ap-southeast-1`), and `.env` already holds working credentials. There is no local
PostgreSQL, no `psql`, and no Docker on this machine — do not try to install any of them
and do not run `createdb`.

Four connection variables exist in `.env`: `DATABASE_URL` and `DATABASE_URL_TEST` are
pooled endpoints used by the app and the test suite; `DIRECT_DATABASE_URL` and
`DIRECT_DATABASE_URL_TEST` are the same endpoints without `-pooler`, used by Prisma
Migrate only.

Verify both are reachable before going further:

```bash
set -a; . ./.env; set +a
echo "SELECT 1;" | npx prisma db execute --url "$DATABASE_URL" --stdin
echo "SELECT 1;" | npx prisma db execute --url "$DATABASE_URL_TEST" --stdin
```

Expected: `Script executed successfully.` twice. Never print the contents of `.env` —
it holds live database credentials.

- [ ] **Step 2: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  // Migrations take Postgres advisory locks, which Neon's pooled (PgBouncer)
  // endpoint does not support. `directUrl` is the same connection string with
  // "-pooler" removed, and is used by Prisma Migrate only.
  directUrl = env("DIRECT_DATABASE_URL")
}

enum Role {
  FINANCE_USER
  FINANCE_ADMIN
}

enum CheckStatus {
  GENERATED
  SIGNATURE_PENDING
  SIGNED
  READY_FOR_RELEASE
  SCHEDULED
  RELEASED
  CANCELLED
}

enum ClearingStatus {
  NONE
  DEPOSITED
  ENCASHED
  CLEARED
}

enum Eligibility {
  SUPPLIER
  BROKER
  INTERNAL
}

enum PortalDomain {
  LOCAL
  BROKER
}

enum PortalSyncStatus {
  NOT_APPLICABLE
  PENDING
  SYNCED
  FAILED
}

enum ActorType {
  SYSTEM
  USER
}

enum PortalDirection {
  OUT
  IN
}

model Company {
  id           String        @id @default(cuid())
  code         String        @unique   // STK, A1+, P&P
  name         String
  legalNames   String[]                // used by eligibility to detect inter-company
  cashAccounts CashAccount[]
  checkBooks   CheckBook[]
  checks       Check[]
  createdAt    DateTime      @default(now())
}

model Bank {
  id           String        @id @default(cuid())
  code         String        @unique   // BPI, MBTC, BDO
  name         String
  cashAccounts CashAccount[]
  checkBooks   CheckBook[]
}

model CashAccount {
  id        String  @id @default(cuid())
  code      String  @unique            // "BPI STK"
  bankId    String
  companyId String
  bank      Bank    @relation(fields: [bankId], references: [id])
  company   Company @relation(fields: [companyId], references: [id])
  checks    Check[]
}

model CheckBook {
  id        String  @id @default(cuid())
  code      String  @unique            // "BPI-S-4636"
  bankId    String
  companyId String
  bank      Bank    @relation(fields: [bankId], references: [id])
  company   Company @relation(fields: [companyId], references: [id])
  checks    Check[]
}

model Vendor {
  id                  String       @id @default(cuid())
  vendorId            String?      @unique
  canonicalName       String       @unique
  aliases             String[]
  eligibilityDefault  Eligibility?
  checks              Check[]
}

model Check {
  id                 String           @id @default(cuid())
  acumaticaPaymentId String?          @unique

  checkNumber        String
  cvNumber           String?
  checkDate          DateTime?
  amount             Decimal          @db.Decimal(18, 2)
  currency           String           @default("PHP")

  companyId          String
  cashAccountId      String?
  checkBookId        String?
  vendorId           String?
  payeeName          String

  category           String?
  eligibility        Eligibility
  eligibilityOverriddenById String?

  portalTradeId      Int?
  portalDomain       PortalDomain?
  portalSyncStatus   PortalSyncStatus @default(NOT_APPLICABLE)

  status             CheckStatus      @default(GENERATED)

  signedById            String?
  signedAt              DateTime?
  readyById             String?
  readyAt               DateTime?
  availablePickupDate   DateTime?

  scheduledPickupDate   DateTime?
  scheduledPickupTime   String?
  pickupRep             String?
  portalConfirmedAt     DateTime?

  releasedById       String?
  releasedAt         DateTime?
  orNumber           String?
  orDate             DateTime?
  remarks            String?

  pointPerson        String?
  checksPossession   String?

  clearingStatus     ClearingStatus   @default(NONE)
  crNumber           String?
  clearedDate        DateTime?

  cancelledById      String?
  cancelledAt        DateTime?
  cancelReason       String?

  sourceSheet        String?
  sourceRow          Int?
  isStale            Boolean          @default(false)

  company            Company          @relation(fields: [companyId], references: [id])
  cashAccount        CashAccount?     @relation(fields: [cashAccountId], references: [id])
  checkBook          CheckBook?       @relation(fields: [checkBookId], references: [id])
  vendor             Vendor?          @relation(fields: [vendorId], references: [id])
  signedBy           User?            @relation("signedBy", fields: [signedById], references: [id])
  readyBy            User?            @relation("readyBy", fields: [readyById], references: [id])
  releasedBy         User?            @relation("releasedBy", fields: [releasedById], references: [id])
  cancelledBy        User?            @relation("cancelledBy", fields: [cancelledById], references: [id])
  eligibilityOverriddenBy User?       @relation("eligibilityOverriddenBy", fields: [eligibilityOverriddenById], references: [id])

  bills              CheckBill[]
  auditLogs          AuditLog[]
  portalEvents       PortalEvent[]
  notifications      Notification[]

  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  @@unique([companyId, checkNumber])
  @@index([status])
  @@index([eligibility])
  @@index([checkDate])
  @@index([availablePickupDate])
}

model CheckBill {
  id            String    @id @default(cuid())
  checkId       String
  apvNumber     String
  poNumber      String?
  rrNumber      String?
  statusRr      String?
  description   String?
  glAccount     String?
  dueDate       DateTime?
  termsCode     String?
  amount        Decimal   @db.Decimal(18, 2)
  createdByName String?

  check         Check     @relation(fields: [checkId], references: [id], onDelete: Cascade)

  @@index([apvNumber])
  @@index([poNumber])
}

model AuditLog {
  id        String    @id @default(cuid())
  checkId   String?
  actorType ActorType
  userId    String?
  action    String
  details   Json?
  remarks   String?
  createdAt DateTime  @default(now())

  check     Check?    @relation(fields: [checkId], references: [id])
  user      User?     @relation(fields: [userId], references: [id])

  @@index([checkId, createdAt])
}

model PortalEvent {
  id        String          @id @default(cuid())
  checkId   String
  direction PortalDirection
  payload   Json
  status    String          @default("PENDING")
  attempts  Int             @default(0)
  lastError String?
  createdAt DateTime        @default(now())

  check     Check           @relation(fields: [checkId], references: [id])

  @@index([status, createdAt])
}

model SyncRun {
  id         String    @id @default(cuid())
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  mode       String
  imported   Int       @default(0)
  updated    Int       @default(0)
  errors     Int       @default(0)
  message    String?
}

model Notification {
  id        String   @id @default(cuid())
  type      String
  message   String
  checkId   String?
  readAt    DateTime?
  createdAt DateTime @default(now())

  check     Check?   @relation(fields: [checkId], references: [id])
}

model User {
  id           String    @id @default(cuid())
  email        String    @unique
  name         String
  passwordHash String
  role         Role      @default(FINANCE_USER)
  active       Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())

  auditLogs         AuditLog[]
  signedChecks      Check[]   @relation("signedBy")
  readyChecks       Check[]   @relation("readyBy")
  releasedChecks    Check[]   @relation("releasedBy")
  cancelledChecks   Check[]   @relation("cancelledBy")
  overriddenChecks  Check[]   @relation("eligibilityOverriddenBy")
}

model Setting {
  key   String @id
  value String
}
```

- [ ] **Step 3: Create `lib/db.ts`**

```ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 4: Run the migration**

```bash
npx prisma migrate dev --name init
```

Expected: migration applied, `@prisma/client` generated.

- [ ] **Step 5: Write the test-database guard, then the schema test**

`tests/helpers/test-db-url.ts` — every database test resolves its URL through this,
so the suite can never silently point at live data:

```ts
// Guards the most destructive mistake available in this repo: running a suite
// that truncates every table against the application database. Vitest does not
// load .env into process.env by default, and Prisma treats an `undefined` url as
// "use the schema's DATABASE_URL" — so an unset test URL fails silently and
// destructively rather than loudly.
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is not set. Tests truncate every table and must never run against ' +
      'the application database. Check that .env exists and that vitest.config.mts loads it.',
    )
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL_TEST is identical to DATABASE_URL. Refusing to run a destructive suite ' +
      'against the application database.',
    )
  }
  return url
}
```

`tests/schema.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './helpers/test-db-url'

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } })

const createdCompanyIds: string[] = []

// The test database is a real cloud database, not an ephemeral container.
// A test that inserts without cleaning up grows it without bound on every run.
afterAll(async () => {
  await prisma.check.deleteMany({ where: { companyId: { in: createdCompanyIds } } })
  await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } })
  await prisma.$disconnect()
})

describe('schema', () => {
  it('enforces the composite unique key on company + check number', async () => {
    const company = await prisma.company.create({
      data: { code: `T${Date.now()}`, name: 'Test Co', legalNames: [] },
    })
    createdCompanyIds.push(company.id)

    const base = {
      companyId: company.id,
      checkNumber: '6000000001',
      amount: '100.00',
      payeeName: 'ACME',
      eligibility: 'SUPPLIER' as const,
    }
    await prisma.check.create({ data: base })
    await expect(prisma.check.create({ data: base })).rejects.toThrow()
  })
})
```

- [ ] **Step 6: Apply migrations to the test database, then run the test**

```bash
DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL_TEST" npx prisma migrate deploy
npm test -- tests/schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Prisma schema for checks, bills, audit and reference data

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Release-Ladder State Machine

**Files:**
- Create: `lib/domain/errors.ts`, `lib/domain/check-status.ts`
- Test: `tests/domain/check-status.test.ts`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces:
  - `class DomainError extends Error { code: string }`
  - `type CheckStatus = 'GENERATED'|'SIGNATURE_PENDING'|'SIGNED'|'READY_FOR_RELEASE'|'SCHEDULED'|'RELEASED'|'CANCELLED'`
  - `type ClearingStatus = 'NONE'|'DEPOSITED'|'ENCASHED'|'CLEARED'`
  - `canTransition(from: CheckStatus, to: CheckStatus): boolean`
  - `assertTransition(from: CheckStatus, to: CheckStatus): void`
  - `type ReadyGuardInput = { status: CheckStatus; checkNumber: string | null; payeeName: string | null; amount: string | null; checkDate: Date | null; cashAccountCode: string | null; availablePickupDate: Date | null }`
  - `checkReadyForRelease(input: ReadyGuardInput): { ok: true } | { ok: false; code: string; message: string }`
  - `canSetClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): boolean`
  - `assertClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): void`

- [ ] **Step 1: Write the failing tests**

`tests/domain/check-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  canTransition, assertTransition, checkReadyForRelease,
  canSetClearing, assertClearing,
} from '@/lib/domain/check-status'
import { DomainError } from '@/lib/domain/errors'

describe('release ladder transitions', () => {
  it('allows the forward path', () => {
    expect(canTransition('GENERATED', 'SIGNATURE_PENDING')).toBe(true)
    expect(canTransition('SIGNATURE_PENDING', 'SIGNED')).toBe(true)
    expect(canTransition('SIGNED', 'READY_FOR_RELEASE')).toBe(true)
    expect(canTransition('READY_FOR_RELEASE', 'SCHEDULED')).toBe(true)
    expect(canTransition('SCHEDULED', 'RELEASED')).toBe(true)
  })

  it('allows release without a confirmed pickup slot', () => {
    expect(canTransition('READY_FOR_RELEASE', 'RELEASED')).toBe(true)
  })

  it('forbids releasing a check that was never made available', () => {
    expect(canTransition('SIGNED', 'RELEASED')).toBe(false)
  })

  it('allows revert back to SIGNED from both available states', () => {
    expect(canTransition('READY_FOR_RELEASE', 'SIGNED')).toBe(true)
    expect(canTransition('SCHEDULED', 'SIGNED')).toBe(true)
  })

  it('allows cancellation from any pre-released state', () => {
    for (const s of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const) {
      expect(canTransition(s, 'CANCELLED')).toBe(true)
    }
  })

  it('treats RELEASED and CANCELLED as terminal', () => {
    expect(canTransition('RELEASED', 'SIGNED')).toBe(false)
    expect(canTransition('RELEASED', 'CANCELLED')).toBe(false)
    expect(canTransition('CANCELLED', 'SIGNED')).toBe(false)
  })

  it('forbids skipping the signature step', () => {
    expect(canTransition('GENERATED', 'READY_FOR_RELEASE')).toBe(false)
  })

  it('assertTransition throws a coded DomainError on an illegal move', () => {
    expect(() => assertTransition('SIGNED', 'RELEASED')).toThrow(DomainError)
    try { assertTransition('SIGNED', 'RELEASED') }
    catch (e) { expect((e as DomainError).code).toBe('ILLEGAL_TRANSITION') }
  })
})

const validReady = {
  status: 'SIGNED' as const,
  checkNumber: '6000329924',
  payeeName: 'HENKEL PHILIPPINES INC.',
  amount: '197715.42',
  checkDate: new Date('2026-09-01'),
  cashAccountCode: 'BPI STK',
  availablePickupDate: new Date('2026-09-03'),
}

describe('READY FOR RELEASE guards', () => {
  it('passes when signed and complete', () => {
    expect(checkReadyForRelease(validReady)).toEqual({ ok: true })
  })

  it('blocks a check that is not SIGNED, with the exact spec message', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'SIGNATURE_PENDING' })
    expect(r).toEqual({
      ok: false,
      code: 'NOT_SIGNED',
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    })
  })

  it('blocks a check that is already RELEASED', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'RELEASED' })
    expect(r).toEqual({
      ok: false,
      code: 'ALREADY_RELEASED',
      message: 'This check cannot be released because it has already been RELEASED.',
    })
  })

  it('names every missing required field', () => {
    const r = checkReadyForRelease({ ...validReady, checkNumber: null, availablePickupDate: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MISSING_FIELDS')
    expect(r.message).toBe(
      'This check cannot be released because required information is missing: CHECK NUMBER, AVAILABLE PICKUP DATE.')
  })

  it('treats an empty string as missing', () => {
    const r = checkReadyForRelease({ ...validReady, payeeName: '   ' })
    expect(r.ok).toBe(false)
  })

  it('reports ALREADY_RELEASED ahead of missing fields', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'RELEASED', checkNumber: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('ALREADY_RELEASED')
  })
})

describe('clearing axis', () => {
  it('permits clearing only once the check is RELEASED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'DEPOSITED')).toBe(true)
    expect(canSetClearing('SCHEDULED', 'NONE', 'DEPOSITED')).toBe(false)
    expect(canSetClearing('READY_FOR_RELEASE', 'NONE', 'ENCASHED')).toBe(false)
  })

  it('allows DEPOSITED or ENCASHED then CLEARED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'ENCASHED')).toBe(true)
    expect(canSetClearing('RELEASED', 'DEPOSITED', 'CLEARED')).toBe(true)
    expect(canSetClearing('RELEASED', 'ENCASHED', 'CLEARED')).toBe(true)
  })

  it('forbids skipping straight to CLEARED and forbids moving off CLEARED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'CLEARED')).toBe(false)
    expect(canSetClearing('RELEASED', 'CLEARED', 'DEPOSITED')).toBe(false)
  })

  it('assertClearing throws a coded DomainError', () => {
    expect(() => assertClearing('SIGNED', 'NONE', 'DEPOSITED')).toThrow(DomainError)
    try { assertClearing('SIGNED', 'NONE', 'DEPOSITED') }
    catch (e) { expect((e as DomainError).code).toBe('ILLEGAL_CLEARING') }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/domain/check-status.test.ts`
Expected: FAIL with "Cannot find module '@/lib/domain/check-status'".

- [ ] **Step 3: Write `lib/domain/errors.ts`**

```ts
export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'DomainError'
  }
}
```

- [ ] **Step 4: Write `lib/domain/check-status.ts`**

```ts
import { DomainError } from './errors'

export type CheckStatus =
  | 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED'
  | 'READY_FOR_RELEASE' | 'SCHEDULED' | 'RELEASED' | 'CANCELLED'

export type ClearingStatus = 'NONE' | 'DEPOSITED' | 'ENCASHED' | 'CLEARED'

// A check must be made available before it can be released, so SIGNED has no
// direct edge to RELEASED. SCHEDULED is optional: suppliers do collect without
// booking a slot in the portal.
const TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  GENERATED:         ['SIGNATURE_PENDING', 'CANCELLED'],
  SIGNATURE_PENDING: ['SIGNED', 'CANCELLED'],
  SIGNED:            ['READY_FOR_RELEASE', 'CANCELLED'],
  READY_FOR_RELEASE: ['SCHEDULED', 'RELEASED', 'SIGNED', 'CANCELLED'],
  SCHEDULED:         ['RELEASED', 'SIGNED', 'CANCELLED'],
  RELEASED:          [],
  CANCELLED:         [],
}

export function canTransition(from: CheckStatus, to: CheckStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: CheckStatus, to: CheckStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('ILLEGAL_TRANSITION', `Cannot move a check from ${from} to ${to}.`)
  }
}

export type ReadyGuardInput = {
  status: CheckStatus
  checkNumber: string | null
  payeeName: string | null
  amount: string | null
  checkDate: Date | null
  cashAccountCode: string | null
  availablePickupDate: Date | null
}

export type GuardResult = { ok: true } | { ok: false; code: string; message: string }

const REQUIRED_FIELDS: readonly (readonly [keyof ReadyGuardInput, string])[] = [
  ['checkNumber', 'CHECK NUMBER'],
  ['payeeName', 'PAYEE'],
  ['amount', 'AMOUNT'],
  ['checkDate', 'CHECK DATE'],
  ['cashAccountCode', 'CASH ACCOUNT'],
  ['availablePickupDate', 'AVAILABLE PICKUP DATE'],
]

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

// Order matters: ALREADY_RELEASED is reported before missing fields, because a
// released check is a terminal fact and telling the user to fill in a field
// would send them down a dead end.
export function checkReadyForRelease(input: ReadyGuardInput): GuardResult {
  if (input.status === 'RELEASED') {
    return {
      ok: false,
      code: 'ALREADY_RELEASED',
      message: 'This check cannot be released because it has already been RELEASED.',
    }
  }

  if (input.status !== 'SIGNED') {
    return {
      ok: false,
      code: 'NOT_SIGNED',
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    }
  }

  const missing = REQUIRED_FIELDS.filter(([key]) => isBlank(input[key])).map(([, label]) => label)
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      message: `This check cannot be released because required information is missing: ${missing.join(', ')}.`,
    }
  }

  return { ok: true }
}

const CLEARING_TRANSITIONS: Record<ClearingStatus, readonly ClearingStatus[]> = {
  NONE:      ['DEPOSITED', 'ENCASHED'],
  DEPOSITED: ['CLEARED'],
  ENCASHED:  ['CLEARED'],
  CLEARED:   [],
}

export function canSetClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): boolean {
  if (status !== 'RELEASED') return false
  return CLEARING_TRANSITIONS[from].includes(to)
}

export function assertClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): void {
  if (!canSetClearing(status, from, to)) {
    throw new DomainError('ILLEGAL_CLEARING', `Cannot set clearing status to ${to} from ${from} while the check is ${status}.`)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/domain/check-status.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add release-ladder state machine and READY FOR RELEASE guards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Eligibility Classifier

**Files:**
- Create: `lib/domain/eligibility.ts`
- Test: `tests/domain/eligibility.test.ts`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces:
  - `type Eligibility = 'SUPPLIER' | 'BROKER' | 'INTERNAL'`
  - `type EligibilityInput = { payeeName: string; category: string | null; sourceSheet?: string | null; ownCompanyNames: readonly string[] }`
  - `classifyEligibility(input: EligibilityInput): { eligibility: Eligibility; reason: string }`
  - `INTERNAL_CATEGORIES`, `GOVERNMENT_PATTERNS` (exported for tests and admin display)

This is the module that prevents payroll and tax data reaching a supplier-facing system. It defaults to `INTERNAL` when uncertain — never to `SUPPLIER`.

- [ ] **Step 1: Write the failing tests**

`tests/domain/eligibility.test.ts`. The payee names below are taken verbatim from `CHECK MONITORING 9.1.2026.xlsx`.

```ts
import { describe, it, expect } from 'vitest'
import { classifyEligibility } from '@/lib/domain/eligibility'

const OWN = ['STARKSON PACKAGING INC.', 'A1+ MULTINATIONAL PACKAGING INC.', 'STARKSON INDUSTRIES']

const classify = (payeeName: string, category: string | null, sourceSheet: string | null = null) =>
  classifyEligibility({ payeeName, category, sourceSheet, ownCompanyNames: OWN })

describe('supplier classification', () => {
  it('classifies an ordinary trade supplier as SUPPLIER', () => {
    expect(classify('GDSM MARKETING', 'LOCAL SUPPLIER').eligibility).toBe('SUPPLIER')
    expect(classify('HENKEL PHILIPPINES INC.', 'LOCAL SUPPLIER').eligibility).toBe('SUPPLIER')
    expect(classify('AJZ Paint Center', null).eligibility).toBe('SUPPLIER')
  })
})

describe('broker classification', () => {
  it('routes the BROKERS category to the broker domain', () => {
    expect(classify('Samb Cargo Services', 'BROKERS').eligibility).toBe('BROKER')
  })
})

describe('internal classification', () => {
  it('treats payroll and salary categories as INTERNAL', () => {
    for (const c of ['PAYROLL', 'SALARIES', 'FTP']) {
      expect(classify('SAVE PLUS LABOR SERVICE COOPERATIVE', c).eligibility).toBe('INTERNAL')
    }
  })

  it('treats tax and fund-transfer categories as INTERNAL', () => {
    expect(classify('Anyone', 'TAX').eligibility).toBe('INTERNAL')
    expect(classify('Anyone', 'FUND TRANSFER').eligibility).toBe('INTERNAL')
  })

  it('treats a payment to one of our own companies as INTERNAL even under a supplier category', () => {
    const r = classify('STARKSON PACKAGING INC.', 'LOCAL SUPPLIER')
    expect(r.eligibility).toBe('INTERNAL')
    expect(r.reason).toBe('INTER-COMPANY')
  })

  it('matches our own companies case-insensitively and ignoring surrounding whitespace', () => {
    expect(classify('  Starkson Packaging Inc.  ', 'LOCAL SUPPLIER').eligibility).toBe('INTERNAL')
  })

  it('treats government and statutory payees as INTERNAL', () => {
    for (const p of [
      'SSS',
      'BUREAU OF INTERNAL REVENUE',
      'PAG-IBIG FUND',
      'PHILHEALTH',
      'MUNICIPALITY OF SILANG CAVITE',
    ]) {
      expect(classify(p, 'LOCAL SUPPLIER').eligibility).toBe('INTERNAL')
    }
  })

  it('treats everything on the FT & MC sheet as INTERNAL regardless of payee', () => {
    const r = classify('THE WALT DISNEY COMPANY (PHILIPPINES), INC.', 'LOCAL SUPPLIER', 'FT & MC')
    expect(r.eligibility).toBe('INTERNAL')
    expect(r.reason).toBe('FUND TRANSFER / MANAGER\u2019S CHEQUE')
  })

  it('defaults to INTERNAL when the payee is unknown or blank', () => {
    expect(classify('', null).eligibility).toBe('INTERNAL')
    expect(classify('   ', 'LOCAL SUPPLIER').eligibility).toBe('INTERNAL')
  })
})

describe('reason codes', () => {
  it('always returns a non-empty reason', () => {
    for (const [p, c] of [['GDSM MARKETING', 'LOCAL SUPPLIER'], ['X', 'PAYROLL'], ['SSS', null]] as const) {
      expect(classify(p, c).reason.length).toBeGreaterThan(0)
    }
  })
})

// Every payee below appears verbatim in the client's register of 10,035 released
// checks. These are regression tests against real misclassifications found by
// running the classifier over all 873 distinct payees, not invented examples.
describe('real payees from the client register', () => {
  it('catches government agencies the original patterns missed', () => {
    for (const p of [
      'Bureau Of Customs',
      'Bureau Of Customs(STARKSON PACKAGING INC.)',
      'Bureau of Fire Protection',
      'Department of Labor and Employment',
      'National Labor Relations Commission',
      'Mandaue City Treasurer Office',
      'Quezon City Treasurer Office',
      "PROVINCIAL TREASURER' OFFICE CAVITE",
    ]) {
      expect(classify(p, null).eligibility, p).toBe('INTERNAL')
    }
  })

  it('catches payroll and petty-cash payees by name', () => {
    for (const p of [
      'CASH PAYROLL A1+',
      'CASH PAYROLL STARKSON',
      'CASH(PAYROLL)',
      'CASH PCF',
      'PCF PONDEROSA',
      'SCM Petty Cash',
      'SITIO PETTY CASH',
      'FUND TRANSFER',
    ]) {
      expect(classify(p, null).eligibility, p).toBe('INTERNAL')
    }
  })

  it('matches an own company spelled without its trailing period', () => {
    // The register contains this exact spelling. Exact equality missed it.
    const r = classify('A1+ MULTINATIONAL PACKAGING INC', 'LOCAL SUPPLIER')
    expect(r.eligibility).toBe('INTERNAL')
    expect(r.reason).toBe('INTER-COMPANY')
  })

  it('does not sweep up genuine suppliers with government-adjacent names', () => {
    for (const p of [
      'C.B. Barangay Enterprises Towing and Trucking Services Inc.',
      'KWPB Customs Brokerage',
      'NEW TRENDS INTERNATIONAL CORPORATION',
      'TECHNOLOGY LINKS INTERNATIONAL CORPORATION',
      'International Spring Industries',
      'Caledonian International Corporation',
    ]) {
      expect(classify(p, 'LOCAL SUPPLIER').eligibility, p).toBe('SUPPLIER')
    }
  })

  // These constrain INTERNAL_PAYEE_PATTERNS. Without them a greedier
  // /\bPAYROLL\b/ or /\bPCF\b/ would pass the suite while silently blocking
  // real vendors — the failure that presents to Finance as "the system is broken".
  it('does not capture vendors whose names merely contain payroll or PCF', () => {
    for (const p of [
      'ABC Payroll Solutions Corp',
      'PayrollHero Philippines, Inc.',
      'ABC PCF Corporation',
      'PETTY CASHIER SERVICES CORP.',
    ]) {
      expect(classify(p, 'LOCAL SUPPLIER').eligibility, p).toBe('SUPPLIER')
    }
  })

  // Labour cooperatives are mixed: sometimes a service invoice a representative
  // collects, sometimes payroll. Finance decided these are classified by the
  // category on the individual check, never by the payee name.
  it('classifies labour cooperatives by category, not by name', () => {
    expect(classify('SAVE PLUS LABOR SERVICE COOPERATIVE', 'LOCAL SUPPLIER').eligibility).toBe('SUPPLIER')
    expect(classify('SAVE PLUS LABOR SERVICE COOPERATIVE', 'PAYROLL').eligibility).toBe('INTERNAL')
    expect(classify('KOINONIA SERVICE COOPERATIVE', null).eligibility).toBe('SUPPLIER')
    expect(classify('SERENDIPITY MULTIPURPOSE COOPERATIVE', 'PAYROLL').eligibility).toBe('INTERNAL')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/domain/eligibility.test.ts`
Expected: FAIL with "Cannot find module '@/lib/domain/eligibility'".

- [ ] **Step 3: Write `lib/domain/eligibility.ts`**

```ts
export type Eligibility = 'SUPPLIER' | 'BROKER' | 'INTERNAL'

export type EligibilityInput = {
  payeeName: string
  category: string | null
  sourceSheet?: string | null
  ownCompanyNames: readonly string[]
}

export type EligibilityResult = { eligibility: Eligibility; reason: string }

export const INTERNAL_CATEGORIES: readonly string[] = [
  'PAYROLL', 'SALARIES', 'FTP', 'TAX', 'FUND TRANSFER',
]

export const BROKER_CATEGORIES: readonly string[] = ['BROKERS']

// Statutory and government payees. These are never suppliers and must never be
// pushed to a supplier-facing portal.
//
// LIMITATION, deliberate and load-bearing: this is a denylist, and a denylist is
// necessarily incomplete. A statutory payee whose name matches nothing here, and
// whose category column is blank, falls through to SUPPLIER. Category is the
// primary control; this list is the backstop for rows where category is missing —
// roughly 15-30% of the client's historical register. Every pattern below was
// derived from the 873 distinct payees in that register, not invented.
export const GOVERNMENT_PATTERNS: readonly RegExp[] = [
  /^SSS\b/,
  /SOCIAL SECURITY SYSTEM/,
  /BUREAU OF INTERNAL REVENUE/,
  /\bBIR\b/,
  /PAG-?IBIG/,
  /\bHDMF\b/,
  /PHILHEALTH/,
  /^BUREAU OF\b/,                       // Bureau Of Customs, Bureau of Fire Protection
  /^DEPARTMENT OF\b/,                   // Department of Labor and Employment
  /NATIONAL LABOR RELATIONS/,
  /\bNLRC\b/,
  /\bTREASURER\b/,                      // Mandaue / Quezon City Treasurer Office
  /^MUNICIPALITY OF\b/,
  /^CITY OF\b/,
  /^CITY GOVERNMENT OF\b/,
  /^PROVINCE OF\b/,
  /^PROVINCIAL (GOVERNMENT|TREASURER)/, // PROVINCIAL TREASURER' OFFICE CAVITE
  /^REPUBLIC OF THE PHILIPPINES/,
]

// Internal payees that are not government: payroll runs and petty-cash
// replenishments drawn in the group's own name, and bare fund transfers.
//
// These are deliberately narrow. A bare /\bPAYROLL\b/ would capture genuine
// payroll-outsourcing vendors ("ABC Payroll Solutions Corp"), and a bare
// /\bPCF\b/ would capture any supplier using those three letters as an
// initialism — both common enough in the Philippines to matter. Every pattern
// here is tied to the cash-run naming convention actually used in the client's
// register, and the negative tests below hold them to it.
export const INTERNAL_PAYEE_PATTERNS: readonly RegExp[] = [
  /\bCASH\s*\(?\s*PAYROLL\b/,           // CASH PAYROLL A1+, CASH PAYROLL STARKSON, CASH(PAYROLL)
  /\bPETTY CASH\b/,                     // SCM Petty Cash, SITIO PETTY CASH
  /^PCF\b/,                             // PCF PONDEROSA
  /\bCASH PCF\b/,                       // CASH PCF
  /^FUND TRANSFER$/,                    // anchored: the phrase is too generic unbounded
]

const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

// Real registers spell the same company several ways. The client's own data
// contains both "A1+ MULTINATIONAL PACKAGING INC." and "A1+ MULTINATIONAL
// PACKAGING INC" — exact string equality missed the second and would have
// classified an inter-company payment as a supplier payment. Compare on a key
// that ignores punctuation and the INC/INCORPORATED spelling.
const companyKey = (s: string | null | undefined) =>
  norm(s).replace(/[.,']/g, '').replace(/\bINCORPORATED\b/g, 'INC').replace(/\s+/g, ' ').trim()

// Fund transfers and manager's cheques are internal treasury movements. Their
// payees can look like ordinary third parties, so the source sheet is the only
// reliable signal.
const FT_MC_SHEETS = ['FT & MC']

export function classifyEligibility(input: EligibilityInput): EligibilityResult {
  const payee = norm(input.payeeName)
  const category = norm(input.category)
  const sheet = norm(input.sourceSheet)

  if (payee === '') {
    return { eligibility: 'INTERNAL', reason: 'UNKNOWN PAYEE' }
  }

  if (FT_MC_SHEETS.map(norm).includes(sheet)) {
    return { eligibility: 'INTERNAL', reason: 'FUND TRANSFER / MANAGER\u2019S CHEQUE' }
  }

  if (input.ownCompanyNames.map(companyKey).includes(companyKey(payee))) {
    return { eligibility: 'INTERNAL', reason: 'INTER-COMPANY' }
  }

  if (GOVERNMENT_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'GOVERNMENT / STATUTORY' }
  }

  if (INTERNAL_PAYEE_PATTERNS.some((re) => re.test(payee))) {
    return { eligibility: 'INTERNAL', reason: 'INTERNAL PAYEE' }
  }

  if (INTERNAL_CATEGORIES.includes(category)) {
    return { eligibility: 'INTERNAL', reason: `CATEGORY ${category}` }
  }

  if (BROKER_CATEGORIES.includes(category)) {
    return { eligibility: 'BROKER', reason: 'CATEGORY BROKERS' }
  }

  return { eligibility: 'SUPPLIER', reason: 'TRADE SUPPLIER' }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/domain/eligibility.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add eligibility classifier gating supplier-portal exposure

Classifies payroll, tax, government and inter-company payments as INTERNAL so
they can never be pushed to the supplier-facing portal. Defaults to INTERNAL
when the payee is unknown.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Append-Only Audit Log

**Files:**
- Create: `lib/audit.ts`, `prisma/migrations/20260901120000_audit_append_only/migration.sql`
- Test: `tests/actions/audit.test.ts`, `tests/helpers/db.ts`

**Interfaces:**
- Consumes: `lib/db.ts` (Task 2)
- Produces: `writeAudit(tx, { checkId?, actorType, userId?, action, details?, remarks? }): Promise<void>` where `tx` is a `PrismaClient` or transaction client. This is the only function in the codebase that creates audit rows.

- [ ] **Step 1: Write the test helper**

`tests/helpers/db.ts`:

```ts
import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './test-db-url'

export const testDb = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
})

export async function resetDb() {
  // Order matters: children before parents.
  await testDb.auditLog.deleteMany()
  await testDb.portalEvent.deleteMany()
  await testDb.notification.deleteMany()
  await testDb.checkBill.deleteMany()
  await testDb.check.deleteMany()
  await testDb.cashAccount.deleteMany()
  await testDb.checkBook.deleteMany()
  await testDb.vendor.deleteMany()
  await testDb.company.deleteMany()
  await testDb.bank.deleteMany()
  await testDb.user.deleteMany()
}
```

- [ ] **Step 2: Write the failing test**

`tests/actions/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { writeAudit } from '@/lib/audit'

beforeEach(resetDb)

describe('writeAudit', () => {
  it('appends a system row', async () => {
    await writeAudit(testDb, { actorType: 'SYSTEM', action: 'imported_from_acumatica', remarks: 'New check' })
    const rows = await testDb.auditLog.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].actorType).toBe('SYSTEM')
    expect(rows[0].action).toBe('imported_from_acumatica')
  })

  it('appends a user row carrying structured details', async () => {
    const user = await testDb.user.create({
      data: { email: 'a@b.com', name: 'Finance User', passwordHash: 'x' },
    })
    await writeAudit(testDb, {
      actorType: 'USER', userId: user.id, action: 'ready_for_release',
      details: { pickupDate: '2026-09-03' },
    })
    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row.userId).toBe(user.id)
    expect(row.details).toEqual({ pickupDate: '2026-09-03' })
  })

  it('exposes no update or delete helper', async () => {
    const mod = await import('@/lib/audit')
    expect(Object.keys(mod)).toEqual(['writeAudit'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/actions/audit.test.ts`
Expected: FAIL with "Cannot find module '@/lib/audit'".

- [ ] **Step 4: Write `lib/audit.ts`**

```ts
import type { Prisma, PrismaClient, ActorType } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type AuditInput = {
  checkId?: string
  actorType: ActorType
  userId?: string
  action: string
  details?: Prisma.InputJsonValue
  remarks?: string
}

// The ONLY way audit rows are created. There is deliberately no update or
// delete counterpart: audit history is append-only, and the database revokes
// UPDATE/DELETE for the application role as a second line of defence.
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      checkId: input.checkId,
      actorType: input.actorType,
      userId: input.userId,
      action: input.action,
      details: input.details,
      remarks: input.remarks,
    },
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/actions/audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the database-level guarantee**

Create `prisma/migrations/20260901120000_audit_append_only/migration.sql`:

```sql
-- Second line of defence: even a bug in application code cannot rewrite
-- history. The migration role keeps full rights; the runtime role does not.
-- Replace check_monitoring_app with the role your app connects as.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'check_monitoring_app') THEN
    REVOKE UPDATE, DELETE ON TABLE "AuditLog" FROM check_monitoring_app;
    GRANT SELECT, INSERT ON TABLE "AuditLog" TO check_monitoring_app;
  END IF;
END
$$;
```

Then apply it:

```bash
npx prisma migrate deploy
```

Expected: migration applied. The `IF EXISTS` guard means this is a no-op on a developer machine where the app role does not exist yet, and takes effect in staging and production where it does.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add append-only audit log with database-level UPDATE/DELETE revoke

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Transactional Domain Actions

**Files:**
- Create: `lib/domain/actions.ts`
- Test: `tests/actions/actions.test.ts`, `tests/helpers/factory.ts`

**Interfaces:**
- Consumes: `lib/audit.ts`, `lib/domain/check-status.ts`, `lib/domain/errors.ts`, and Prisma's generated types. It does **not** import the Prisma client — the caller always passes `db`, which is what makes these functions testable against the test database and composable inside a larger transaction.
- Produces, all taking `(db: Db, args)` and returning the updated `Check`:
  - `markSigned(db, { checkId, userId, now })`
  - `markReadyForRelease(db, { checkId, userId, availablePickupDate, now })`
  - `revertAvailability(db, { checkId, userId, reason, now })`
  - `markReleased(db, { checkId, userId, orNumber?, orDate?, remarks?, now })`
  - `recordClearing(db, { checkId, userId, clearingStatus, crNumber?, clearedDate?, now })`
  - `cancelCheck(db, { checkId, userId, reason, now })`
  - `applyPickupConfirmation(db, { checkId, pickupDate, pickupTime?, pickupRep?, confirmedAt })`

`now` is always injected so tests are deterministic.

- [ ] **Step 1: Write the test factory**

`tests/helpers/factory.ts`:

```ts
import { testDb } from './db'
import type { CheckStatus, Eligibility } from '@prisma/client'

export async function makeUser(role: 'FINANCE_USER' | 'FINANCE_ADMIN' = 'FINANCE_USER') {
  return testDb.user.create({
    data: { email: `u${Math.random().toString(36).slice(2)}@rcl.test`, name: 'Finance User', passwordHash: 'x', role },
  })
}

export async function makeCheck(overrides: {
  status?: CheckStatus
  eligibility?: Eligibility
  checkNumber?: string
  availablePickupDate?: Date | null
} = {}) {
  const company = await testDb.company.create({
    data: { code: `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson Packaging Inc.', legalNames: [] },
  })
  const bank = await testDb.bank.create({
    data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' },
  })
  const cashAccount = await testDb.cashAccount.create({
    data: { code: `BPI STK ${Math.random().toString(36).slice(2, 7)}`, bankId: bank.id, companyId: company.id },
  })
  return testDb.check.create({
    data: {
      companyId: company.id,
      cashAccountId: cashAccount.id,
      checkNumber: overrides.checkNumber ?? `600${Math.floor(Math.random() * 10_000_000)}`,
      checkDate: new Date('2026-09-01'),
      amount: '197715.42',
      payeeName: 'HENKEL PHILIPPINES INC.',
      eligibility: overrides.eligibility ?? 'SUPPLIER',
      status: overrides.status ?? 'SIGNED',
      availablePickupDate: overrides.availablePickupDate === undefined ? null : overrides.availablePickupDate,
    },
  })
}
```

- [ ] **Step 2: Write the failing tests**

`tests/actions/actions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markSigned, markReadyForRelease, revertAvailability, markReleased,
  recordClearing, cancelCheck, applyPickupConfirmation,
} from '@/lib/domain/actions'
import { DomainError } from '@/lib/domain/errors'

const NOW = new Date('2026-09-01T13:32:00+08:00')
const PICKUP = new Date('2026-09-03')

beforeEach(resetDb)

describe('markSigned', () => {
  it('moves SIGNATURE_PENDING to SIGNED and records who and when', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const out = await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    expect(out.status).toBe('SIGNED')
    expect(out.signedById).toBe(user.id)
    expect(out.signedAt).toEqual(NOW)
  })

  it('writes an audit row', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await markSigned(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    expect(audit.action).toBe('marked_signed')
    expect(audit.userId).toBe(user.id)
  })
})

describe('markReadyForRelease', () => {
  it('sets status, actor, timestamp and the availability date', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.readyById).toBe(user.id)
    expect(out.readyAt).toEqual(NOW)
    expect(out.availablePickupDate).toEqual(PICKUP)
  })

  it('queues a portal event for a SUPPLIER check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id } })
    expect(events).toHaveLength(1)
    expect(events[0].direction).toBe('OUT')
    expect(events[0].status).toBe('PENDING')
    const updated = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(updated.portalSyncStatus).toBe('PENDING')
  })

  it('queues NO portal event for an INTERNAL check but still changes status', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    const out = await markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('refuses a check that is not SIGNED and leaves it untouched', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW,
    })).rejects.toMatchObject({ code: 'NOT_SIGNED' })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('refuses when the availability date is missing', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(markReadyForRelease(testDb, {
      checkId: check.id, userId: user.id, availablePickupDate: null, now: NOW,
    })).rejects.toMatchObject({ code: 'MISSING_FIELDS' })
  })
})

describe('revertAvailability', () => {
  it('returns the check to SIGNED, requires a reason, and never deletes it', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await revertAvailability(testDb, {
      checkId: check.id, userId: user.id,
      reason: 'Check temporarily unavailable due to operational circumstances.', now: NOW,
    })
    expect(out.status).toBe('SIGNED')
    expect(out.availablePickupDate).toBeNull()
    expect(await testDb.check.count({ where: { id: check.id } })).toBe(1)
    const audit = await testDb.auditLog.findFirst({
      where: { checkId: check.id, action: 'reverted_availability' },
    })
    expect(audit?.remarks).toContain('operational circumstances')
  })

  it('clears any supplier-confirmed pickup so no phantom schedule survives', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan', confirmedAt: NOW,
    })
    const out = await revertAvailability(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    expect(out.status).toBe('SIGNED')
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
    expect(out.pickupRep).toBeNull()
  })

  it('rejects a blank reason', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await expect(revertAvailability(testDb, {
      checkId: check.id, userId: user.id, reason: '   ', now: NOW,
    })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
  })
})

describe('applyPickupConfirmation', () => {
  it('moves READY_FOR_RELEASE to SCHEDULED', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan Dela Cruz', confirmedAt: NOW,
    })
    expect(out.status).toBe('SCHEDULED')
    expect(out.scheduledPickupTime).toBe('10:00')
    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { checkId: check.id, action: 'supplier_pickup_confirmed' },
    })
    expect(audit.actorType).toBe('SYSTEM')
  })

  it('cannot mark a check RELEASED', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await applyPickupConfirmation(testDb, { checkId: check.id, pickupDate: PICKUP, confirmedAt: NOW })
    expect(out.status).not.toBe('RELEASED')
  })

  it('refuses to confirm against a check that is not available', async () => {
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, confirmedAt: NOW,
    })).rejects.toBeInstanceOf(DomainError)
  })
})

describe('markReleased', () => {
  it('releases directly from READY_FOR_RELEASE without a confirmed slot', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    const out = await markReleased(testDb, {
      checkId: check.id, userId: user.id, remarks: 'Picked up by supplier', now: NOW,
    })
    expect(out.status).toBe('RELEASED')
    expect(out.releasedById).toBe(user.id)
    expect(out.releasedAt).toEqual(NOW)
    expect(out.remarks).toBe('Picked up by supplier')
  })

  it('refuses to release a check that was never made available', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })
})

describe('recordClearing', () => {
  it('records DEPOSITED then CLEARED with a CR number', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const dep = await recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'DEPOSITED', now: NOW,
    })
    expect(dep.clearingStatus).toBe('DEPOSITED')
    const cleared = await recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'CLEARED',
      crNumber: 'CR 6336', clearedDate: new Date('2026-09-10'), now: NOW,
    })
    expect(cleared.clearingStatus).toBe('CLEARED')
    expect(cleared.crNumber).toBe('CR 6336')
  })

  it('refuses clearing before the check is released', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(recordClearing(testDb, {
      checkId: check.id, userId: user.id, clearingStatus: 'DEPOSITED', now: NOW,
    })).rejects.toMatchObject({ code: 'ILLEGAL_CLEARING' })
  })
})

describe('cancelCheck', () => {
  it('cancels with a reason and keeps the record', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const out = await cancelCheck(testDb, {
      checkId: check.id, userId: user.id, reason: 'Spoiled check', now: NOW,
    })
    expect(out.status).toBe('CANCELLED')
    expect(out.cancelReason).toBe('Spoiled check')
    expect(await testDb.check.count({ where: { id: check.id } })).toBe(1)
  })

  it('refuses to cancel an already released check', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    await expect(cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- tests/actions/actions.test.ts`
Expected: FAIL with "Cannot find module '@/lib/domain/actions'".

- [ ] **Step 4: Write `lib/domain/actions.ts`**

```ts
import type { Check, Prisma, PrismaClient, ClearingStatus as PrismaClearing } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from './errors'
import {
  assertTransition, assertClearing, checkReadyForRelease,
  type CheckStatus, type ClearingStatus,
} from './check-status'

type Db = PrismaClient | Prisma.TransactionClient

// Every action runs in one transaction that updates the check AND appends its
// audit row. A caller can pass an existing transaction client; otherwise we
// open our own.
async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn)
  }
  return fn(db as Prisma.TransactionClient)
}

async function load(tx: Prisma.TransactionClient, checkId: string) {
  const check = await tx.check.findUnique({
    where: { id: checkId },
    include: { cashAccount: true },
  })
  if (!check) throw new DomainError('NOT_FOUND', 'Check not found.')
  return check
}

export async function markSigned(
  db: Db, args: { checkId: string; userId: string; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: { status: 'SIGNED', signedById: args.userId, signedAt: args.now },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'marked_signed',
    })
    return updated
  })
}

export async function markReadyForRelease(
  db: Db,
  args: { checkId: string; userId: string; availablePickupDate: Date | null; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)

    // Blocking guards. A failure aborts before anything is written.
    const guard = checkReadyForRelease({
      status: check.status as CheckStatus,
      checkNumber: check.checkNumber,
      payeeName: check.payeeName,
      amount: check.amount?.toString() ?? null,
      checkDate: check.checkDate,
      cashAccountCode: check.cashAccount?.code ?? null,
      availablePickupDate: args.availablePickupDate,
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')

    // Routing condition, NOT a guard: an INTERNAL check still changes status,
    // it simply never produces a portal event.
    const pushes = check.eligibility === 'SUPPLIER' || check.eligibility === 'BROKER'

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'READY_FOR_RELEASE',
        readyById: args.userId,
        readyAt: args.now,
        availablePickupDate: args.availablePickupDate,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: pushes ? (check.eligibility === 'BROKER' ? 'BROKER' : 'LOCAL') : null,
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id,
          direction: 'OUT',
          status: 'PENDING',
          payload: {
            action: 'MARK_AVAILABLE',
            checkNumber: check.checkNumber,
            payeeName: check.payeeName,
            amount: check.amount.toString(),
            availablePickupDate: args.availablePickupDate?.toISOString() ?? null,
          },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'ready_for_release',
      details: { availablePickupDate: args.availablePickupDate?.toISOString() ?? null, portalPush: pushes },
      remarks: `Pickup ${args.availablePickupDate?.toISOString().slice(0, 10) ?? 'unset'}`,
    })

    return updated
  })
}

export async function revertAvailability(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to revert availability.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNED')

    const pushes = check.portalSyncStatus !== 'NOT_APPLICABLE'

    // Clearing the confirmation matters: a stale pickup date on a check that is
    // no longer available shows up as a phantom schedule on the dashboard.
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'SIGNED',
        availablePickupDate: null,
        scheduledPickupDate: null,
        scheduledPickupTime: null,
        pickupRep: null,
        portalConfirmedAt: null,
        readyById: null,
        readyAt: null,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id, direction: 'OUT', status: 'PENDING',
          payload: { action: 'REVERT', checkNumber: check.checkNumber },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'reverted_availability', remarks: args.reason,
    })

    return updated
  })
}

export async function applyPickupConfirmation(
  db: Db,
  args: { checkId: string; pickupDate: Date; pickupTime?: string; pickupRep?: string; confirmedAt: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    // A portal message may only move READY_FOR_RELEASE -> SCHEDULED. It can
    // never release a check: physical release is Finance-only.
    assertTransition(check.status as CheckStatus, 'SCHEDULED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'SCHEDULED',
        scheduledPickupDate: args.pickupDate,
        scheduledPickupTime: args.pickupTime ?? null,
        pickupRep: args.pickupRep ?? null,
        portalConfirmedAt: args.confirmedAt,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'SYSTEM', action: 'supplier_pickup_confirmed',
      details: { pickupDate: args.pickupDate.toISOString(), pickupTime: args.pickupTime ?? null },
      remarks: args.pickupDate.toISOString().slice(0, 10),
    })
    return updated
  })
}

export async function markReleased(
  db: Db,
  args: { checkId: string; userId: string; orNumber?: string; orDate?: Date; remarks?: string; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'RELEASED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'RELEASED',
        releasedById: args.userId,
        releasedAt: args.now,
        orNumber: args.orNumber ?? null,
        orDate: args.orDate ?? null,
        remarks: args.remarks ?? check.remarks,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'released',
      remarks: args.remarks ?? null,
    })
    return updated
  })
}

export async function recordClearing(
  db: Db,
  args: {
    checkId: string; userId: string; clearingStatus: ClearingStatus
    crNumber?: string; clearedDate?: Date; now: Date
  },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertClearing(
      check.status as CheckStatus,
      check.clearingStatus as ClearingStatus,
      args.clearingStatus,
    )
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        clearingStatus: args.clearingStatus as PrismaClearing,
        crNumber: args.crNumber ?? check.crNumber,
        clearedDate: args.clearedDate ?? check.clearedDate,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'clearing_recorded',
      details: { clearingStatus: args.clearingStatus, crNumber: args.crNumber ?? null },
    })
    return updated
  })
}

export async function cancelCheck(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to cancel a check.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'CANCELLED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'CANCELLED',
        cancelledById: args.userId,
        cancelledAt: args.now,
        cancelReason: args.reason,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'cancelled', remarks: args.reason,
    })
    return updated
  })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/actions/actions.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all suites PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add transactional domain actions with audit and portal outbox

Each action updates the check and appends its audit row in one transaction.
INTERNAL checks change status without ever queueing a portal event.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Authentication and Roles

**Files:**
- Create: `lib/auth.ts`, `auth.config.ts`, `app/api/auth/[...nextauth]/route.ts`, `app/login/page.tsx`, `middleware.ts`, `lib/password.ts`
- Test: `tests/auth/password.test.ts`, `tests/auth/guards.test.ts`

**Interfaces:**
- Consumes: `lib/db.ts`, `Role` enum
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `validatePasswordStrength(plain: string): { ok: true } | { ok: false; message: string }`
  - `requireUser(): Promise<{ id: string; email: string; name: string; role: Role }>` — throws/redirects when unauthenticated
  - `requireAdmin(): Promise<...>` — as above, plus role check

- [ ] **Step 1: Write the failing password tests**

`tests/auth/password.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, validatePasswordStrength } from '@/lib/password'

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('Str0ng!Passw0rd')
    expect(hash).not.toContain('Str0ng!Passw0rd')
    expect(await verifyPassword(hash, 'Str0ng!Passw0rd')).toBe(true)
    expect(await verifyPassword(hash, 'wrong')).toBe(false)
  })

  it('produces a different hash for the same password each time', async () => {
    expect(await hashPassword('Str0ng!Passw0rd')).not.toBe(await hashPassword('Str0ng!Passw0rd'))
  })
})

describe('password strength', () => {
  it('accepts a strong password', () => {
    expect(validatePasswordStrength('Str0ng!Passw0rd')).toEqual({ ok: true })
  })

  it('rejects passwords under 12 characters', () => {
    const r = validatePasswordStrength('Sh0rt!1')
    expect(r.ok).toBe(false)
  })

  it('requires upper, lower, digit and symbol', () => {
    expect(validatePasswordStrength('alllowercase1!').ok).toBe(false)
    expect(validatePasswordStrength('ALLUPPERCASE1!').ok).toBe(false)
    expect(validatePasswordStrength('NoDigitsHere!!').ok).toBe(false)
    expect(validatePasswordStrength('NoSymbols1234').ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/auth/password.test.ts`
Expected: FAIL with "Cannot find module '@/lib/password'".

- [ ] **Step 3: Write `lib/password.ts`**

```ts
import argon2 from 'argon2'

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id })
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

const MIN_LENGTH = 12

export function validatePasswordStrength(plain: string): { ok: true } | { ok: false; message: string } {
  if (plain.length < MIN_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_LENGTH} characters.` }
  }
  const checks: [RegExp, string][] = [
    [/[a-z]/, 'a lowercase letter'],
    [/[A-Z]/, 'an uppercase letter'],
    [/[0-9]/, 'a digit'],
    [/[^A-Za-z0-9]/, 'a symbol'],
  ]
  const missing = checks.filter(([re]) => !re.test(plain)).map(([, label]) => label)
  if (missing.length) {
    return { ok: false, message: `Password must contain ${missing.join(', ')}.` }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run to verify the password tests pass**

Run: `npm test -- tests/auth/password.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the NextAuth configuration**

`auth.config.ts`:

```ts
import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/password'

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 30 * 60 },  // 30-minute idle timeout
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const email = String(credentials?.email ?? '').toLowerCase().trim()
        const password = String(credentials?.password ?? '')
        if (!email || !password) return null

        const user = await prisma.user.findUnique({ where: { email } })
        if (!user || !user.active) return null
        if (!(await verifyPassword(user.passwordHash, password))) return null

        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
        return { id: user.id, email: user.email, name: user.name, role: user.role }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id
        token.role = (user as { role: string }).role
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid as string
        session.user.role = token.role as string
      }
      return session
    },
  },
}
```

`lib/auth.ts`:

```ts
import NextAuth from 'next-auth'
import { redirect } from 'next/navigation'
import { authConfig } from '@/auth.config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)

export type SessionUser = { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }

export async function requireUser(): Promise<SessionUser> {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  return session.user as unknown as SessionUser
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') redirect('/')
  return user
}
```

`app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from '@/lib/auth'

export const { GET, POST } = handlers
```

`middleware.ts` — everything except `/login` and the auth endpoints requires a session:

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'

export default auth((req: NextRequest & { auth: unknown }) => {
  const isLoggedIn = Boolean(req.auth)
  const { pathname } = req.nextUrl
  const isPublic = pathname.startsWith('/login') || pathname.startsWith('/api/auth')
  if (!isLoggedIn && !isPublic) {
    return NextResponse.redirect(new URL('/login', req.nextUrl))
  }
  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 6: Write the login page**

`app/login/page.tsx`:

```tsx
import { signIn } from '@/lib/auth'

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <form
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200"
        action={async (formData: FormData) => {
          'use server'
          await signIn('credentials', {
            email: formData.get('email'),
            password: formData.get('password'),
            redirectTo: '/',
          })
        }}
      >
        <h1 className="mb-1 text-lg font-semibold tracking-wide">CHECK RELEASE MONITORING</h1>
        <p className="mb-6 text-sm text-slate-500">FINANCE USERS ONLY</p>

        {searchParams.error && (
          <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            Invalid email or password.
          </p>
        )}

        <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600">EMAIL</label>
        <input name="email" type="email" required autoComplete="username"
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600">PASSWORD</label>
        <input name="password" type="password" required autoComplete="current-password"
          className="mb-6 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <button type="submit"
          className="w-full rounded-lg bg-slate-900 py-2 text-sm font-medium text-white hover:bg-slate-800">
          SIGN IN
        </button>
      </form>
    </main>
  )
}
```

- [ ] **Step 7: Write the guard test**

`tests/auth/guards.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`) })
const auth = vi.fn()

vi.mock('next/navigation', () => ({ redirect }))
vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth, signIn: vi.fn(), signOut: vi.fn() }) }))
vi.mock('@/auth.config', () => ({ authConfig: {} }))

beforeEach(() => { redirect.mockClear(); auth.mockReset() })

describe('requireUser', () => {
  it('redirects an anonymous visitor to /login', async () => {
    auth.mockResolvedValue(null)
    const { requireUser } = await import('@/lib/auth')
    await expect(requireUser()).rejects.toThrow('REDIRECT:/login')
  })

  it('returns the session user when signed in', async () => {
    auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'FINANCE_USER' } })
    const { requireUser } = await import('@/lib/auth')
    await expect(requireUser()).resolves.toMatchObject({ id: 'u1', role: 'FINANCE_USER' })
  })
})

describe('requireAdmin', () => {
  it('sends a non-admin back to the dashboard', async () => {
    auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'FINANCE_USER' } })
    const { requireAdmin } = await import('@/lib/auth')
    await expect(requireAdmin()).rejects.toThrow('REDIRECT:/')
  })

  it('admits a Finance Admin', async () => {
    auth.mockResolvedValue({ user: { id: 'u2', email: 'x@y.z', name: 'B', role: 'FINANCE_ADMIN' } })
    const { requireAdmin } = await import('@/lib/auth')
    await expect(requireAdmin()).resolves.toMatchObject({ role: 'FINANCE_ADMIN' })
  })
})
```

- [ ] **Step 8: Run the tests**

Run: `npm test -- tests/auth`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add credentials auth with argon2, roles and 30-minute session timeout

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Seed Script

**Files:**
- Create: `prisma/seed.ts`, `lib/money.ts`
- Modify: `package.json` (add `tsx` dev dependency and the `prisma.seed` key)
- Test: `tests/seed.test.ts`

**Interfaces:**
- Consumes: schema from Task 2, `classifyEligibility` from Task 4, `hashPassword` from Task 7
- Produces: reference data (3 companies, 3 banks, cash accounts, checkbooks), 2 users, and 12 fixture checks spread across statuses so the dashboard is exercisable before the importer exists (Plan 2)
- Produces: `formatPhp(value: string | number | Prisma.Decimal): string` from `lib/money.ts`

- [ ] **Step 1: Install tsx and register the seed command**

```bash
npm install -D tsx
```

Add to `package.json` at the top level (a sibling of `"scripts"`):

```json
{
  "prisma": { "seed": "tsx prisma/seed.ts" }
}
```

- [ ] **Step 2: Write the failing money test**

`tests/seed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatPhp } from '@/lib/money'

describe('formatPhp', () => {
  it('formats with the peso sign, thousands separators and two decimals', () => {
    expect(formatPhp('197715.42')).toBe('\u20B1197,715.42')
    expect(formatPhp('7950')).toBe('\u20B17,950.00')
    expect(formatPhp('0')).toBe('\u20B10.00')
  })

  it('handles large treasury amounts without losing precision', () => {
    expect(formatPhp('16000000')).toBe('\u20B116,000,000.00')
    expect(formatPhp('1471800.5')).toBe('\u20B11,471,800.50')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- tests/seed.test.ts`
Expected: FAIL with "Cannot find module '@/lib/money'".

- [ ] **Step 4: Write `lib/money.ts`**

```ts
import { Prisma } from '@prisma/client'

// Amounts are Decimal end to end. Never convert to a JS number for arithmetic;
// this helper is presentation-only and formats from the decimal string.
export function formatPhp(value: string | number | Prisma.Decimal): string {
  const asString = typeof value === 'string' ? value : value.toString()
  const [whole, fraction = ''] = asString.split('.')
  const negative = whole.startsWith('-')
  const digits = negative ? whole.slice(1) : whole
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = (fraction + '00').slice(0, 2)
  return `${negative ? '-' : ''}\u20B1${grouped}.${cents}`
}
```

- [ ] **Step 5: Run to verify the money test passes**

Run: `npm test -- tests/seed.test.ts`
Expected: PASS.

- [ ] **Step 6: Write `prisma/seed.ts`**

Reference data uses the real codes found in the workbooks.

```ts
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../lib/password'
import { classifyEligibility } from '../lib/domain/eligibility'

const prisma = new PrismaClient()

const COMPANIES = [
  { code: 'STK', name: 'Starkson Packaging Inc.', legalNames: ['STARKSON PACKAGING INC.', 'STARKSON INDUSTRIES'] },
  { code: 'A1+', name: 'A1+ Multinational Packaging Inc.', legalNames: ['A1+ MULTINATIONAL PACKAGING INC.'] },
  { code: 'P&P', name: 'Paper and Plastic', legalNames: [] },
]

const BANKS = [
  { code: 'BPI', name: 'Bank of the Philippine Islands' },
  { code: 'MBTC', name: 'Metropolitan Bank and Trust Company' },
  { code: 'BDO', name: 'BDO Unibank' },
]

const CASH_ACCOUNTS = [
  { code: 'BPI STK', bank: 'BPI', company: 'STK' },
  { code: 'BPI P&P', bank: 'BPI', company: 'P&P' },
  { code: 'BPI A1', bank: 'BPI', company: 'A1+' },
  { code: 'MBTC A1+', bank: 'MBTC', company: 'A1+' },
  { code: 'MBTC P&P', bank: 'MBTC', company: 'P&P' },
  { code: 'BDO A1', bank: 'BDO', company: 'A1+' },
]

const CHECK_BOOKS = [
  { code: 'BPI-S-4636', bank: 'BPI', company: 'STK' },
  { code: 'BPI-A-5713', bank: 'BPI', company: 'A1+' },
  { code: 'BPI-S-8879', bank: 'BPI', company: 'P&P' },
  { code: 'BPI-A-8879', bank: 'BPI', company: 'P&P' },
  { code: 'MBT-A-4155', bank: 'MBTC', company: 'A1+' },
  { code: 'MBT-A-9048', bank: 'MBTC', company: 'P&P' },
  { code: 'MBT-S-9048', bank: 'MBTC', company: 'P&P' },
  { code: 'MBT-S-1121', bank: 'MBTC', company: 'STK' },
  { code: 'BDO-A-3838', bank: 'BDO', company: 'A1+' },
]

// Twelve fixture checks covering every status so the dashboard has something
// meaningful to render before the importer exists (Plan 2). Payees, amounts and
// check numbers are drawn from the real workbooks.
const FIXTURES = [
  { n: '6000329924', payee: 'HENKEL PHILIPPINES INC.',              amt: '197715.42', acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNATURE_PENDING', apv: 'AP-ST040284', po: 'PO-ST-028143' },
  { n: '6000330768', payee: 'Hoxin Builders & Construction Supply', amt: '32500.00',  acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNATURE_PENDING', apv: 'AP-ST040955', po: 'PO-ST-030072' },
  { n: '1791379619', payee: 'GDSM MARKETING',                       amt: '22300.00',  acct: 'MBTC P&P', cat: 'LOCAL SUPPLIER', status: 'SIGNED',            apv: 'AP-A1033419', po: 'PO-A1-025543' },
  { n: '6000339150', payee: 'ASIAQUEST VENTURES CORPORATION',       amt: '9240.00',   acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNED',            apv: 'AP-ST041373', po: 'PO-ST-030215' },
  { n: '6000339589', payee: 'AJZ Paint Center',                     amt: '7500.00',   acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNED',            apv: 'AP-ST041597', po: 'PO-ST-030378' },
  { n: '1791379613', payee: 'Kimiki Solutions Incorporated',        amt: '10138.66',  acct: 'MBTC P&P', cat: 'LOCAL SUPPLIER', status: 'READY_FOR_RELEASE', apv: 'AP-A1032167', po: 'PO-A1-024234' },
  { n: '6000339288', payee: 'Heatwave Industrial Sales',            amt: '27750.00',  acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'READY_FOR_RELEASE', apv: 'AP-ST041485', po: 'PO-ST-029574' },
  { n: '6000338178', payee: 'BELELIE ROBSON TRADING CORP.',         amt: '287520.50', acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SCHEDULED',         apv: 'AP-ST042627', po: 'PO-ST-030484' },
  { n: '6000306443', payee: 'Easytrip Services Corporation',        amt: '80552.41',  acct: 'BPI P&P',  cat: 'LOCAL SUPPLIER', status: 'RELEASED',          apv: 'AP-ST042946', po: 'PO-ST-031230' },
  { n: '6000308611', payee: 'STARKSON PACKAGING INC.',              amt: '1471800.00', acct: 'BPI STK', cat: 'PAYROLL',        status: 'SIGNED',            apv: 'AP-ST036371', po: 'PO-ST-027539' },
  { n: '1791259536', payee: 'STARKSON PACKAGING INC.',              amt: '9600000.00', acct: 'MBTC A1+', cat: 'FUND TRANSFER', status: 'SIGNED',            apv: 'AP-ST037609', po: '26XFT-0020'   },
  { n: '174602',     payee: 'A1+ MULTINATIONAL PACKAGING INC.',     amt: '16888.52',  acct: 'BDO A1',   cat: 'PAYROLL',        status: 'CANCELLED',         apv: 'AP-A1030465', po: 'PO-A1-023450' },
] as const

async function main() {
  const companies = new Map<string, string>()
  for (const c of COMPANIES) {
    const row = await prisma.company.upsert({
      where: { code: c.code }, update: {}, create: c,
    })
    companies.set(c.code, row.id)
  }

  const banks = new Map<string, string>()
  for (const b of BANKS) {
    const row = await prisma.bank.upsert({ where: { code: b.code }, update: {}, create: b })
    banks.set(b.code, row.id)
  }

  const accounts = new Map<string, string>()
  for (const a of CASH_ACCOUNTS) {
    const row = await prisma.cashAccount.upsert({
      where: { code: a.code }, update: {},
      create: { code: a.code, bankId: banks.get(a.bank)!, companyId: companies.get(a.company)! },
    })
    accounts.set(a.code, row.id)
  }

  for (const cb of CHECK_BOOKS) {
    await prisma.checkBook.upsert({
      where: { code: cb.code }, update: {},
      create: { code: cb.code, bankId: banks.get(cb.bank)!, companyId: companies.get(cb.company)! },
    })
  }

  const ownNames = COMPANIES.flatMap((c) => c.legalNames)

  await prisma.user.upsert({
    where: { email: 'admin@rcl.test' }, update: {},
    create: {
      email: 'admin@rcl.test', name: 'Finance Admin',
      passwordHash: await hashPassword('Adm1n!Passw0rd'), role: 'FINANCE_ADMIN',
    },
  })
  await prisma.user.upsert({
    where: { email: 'finance@rcl.test' }, update: {},
    create: {
      email: 'finance@rcl.test', name: 'Finance User',
      passwordHash: await hashPassword('F1nance!Passw0rd'), role: 'FINANCE_USER',
    },
  })

  for (const f of FIXTURES) {
    const accountCode = f.acct
    const company = CASH_ACCOUNTS.find((a) => a.code === accountCode)!.company
    const { eligibility } = classifyEligibility({
      payeeName: f.payee, category: f.cat, ownCompanyNames: ownNames,
    })
    const companyId = companies.get(company)!
    await prisma.check.upsert({
      where: { companyId_checkNumber: { companyId, checkNumber: f.n } },
      update: {},
      create: {
        companyId,
        cashAccountId: accounts.get(accountCode)!,
        checkNumber: f.n,
        checkDate: new Date('2026-09-01'),
        amount: f.amt,
        payeeName: f.payee,
        category: f.cat,
        eligibility,
        status: f.status,
        availablePickupDate:
          f.status === 'READY_FOR_RELEASE' || f.status === 'SCHEDULED' || f.status === 'RELEASED'
            ? new Date('2026-09-03') : null,
        scheduledPickupDate: f.status === 'SCHEDULED' ? new Date('2026-09-03') : null,
        releasedAt: f.status === 'RELEASED' ? new Date('2026-09-03T10:05:00+08:00') : null,
        cancelReason: f.status === 'CANCELLED' ? 'Spoiled check' : null,
        bills: { create: [{ apvNumber: f.apv, poNumber: f.po, amount: f.amt }] },
      },
    })
  }

  console.log('Seeded', COMPANIES.length, 'companies,', FIXTURES.length, 'checks')
}

main().finally(() => prisma.$disconnect())
```

- [ ] **Step 7: Run the seed**

```bash
npm run db:seed
```

Expected: `Seeded 3 companies, 12 checks`

- [ ] **Step 8: Verify eligibility was applied correctly**

```bash
npx prisma studio
```

Confirm in the `Check` table that the payroll, fund-transfer and inter-company rows carry `eligibility = INTERNAL`, and the trade suppliers carry `SUPPLIER`. Close Studio when done.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add seed with real reference data and status-spread fixtures

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Dashboard

**Files:**
- Create: `components/StatusPill.tsx`, `components/SummaryCards.tsx`, `components/CheckTable.tsx`, `lib/queries.ts`
- Modify: `app/page.tsx`
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `lib/db.ts`, `lib/money.ts`, `requireUser()` from Task 7
- Produces:
  - `getSummary(db): Promise<{ total: number; pendingSignature: number; signed: number; readyForRelease: number; scheduled: number; released: number; totalValue: string }>`
  - `type CheckFilters = { q?: string; status?: CheckStatus; companyId?: string; cashAccountId?: string; eligibility?: Eligibility; from?: Date; to?: Date }`
  - `listChecks(db, filters: CheckFilters, limit?: number): Promise<CheckRow[]>`

- [ ] **Step 1: Write the failing query tests**

`tests/queries.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from './helpers/db'
import { makeCheck } from './helpers/factory'
import { getSummary, listChecks } from '@/lib/queries'

beforeEach(resetDb)

describe('getSummary', () => {
  it('counts each status and totals the value of non-cancelled checks', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'SCHEDULED' })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'CANCELLED' })

    const s = await getSummary(testDb)
    expect(s.pendingSignature).toBe(1)
    expect(s.signed).toBe(1)
    expect(s.readyForRelease).toBe(1)
    expect(s.scheduled).toBe(1)
    expect(s.released).toBe(1)
    expect(s.total).toBe(6)
    // 5 non-cancelled checks at 197715.42 each
    expect(s.totalValue).toBe('988577.1')
  })
})

describe('listChecks', () => {
  it('finds a check by its number', async () => {
    await makeCheck({ checkNumber: '6000329924' })
    await makeCheck({ checkNumber: '1791379619' })
    const rows = await listChecks(testDb, { q: '6000329' })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000329924')
  })

  it('finds a check by payee, case-insensitively', async () => {
    await makeCheck({})
    const rows = await listChecks(testDb, { q: 'henkel' })
    expect(rows).toHaveLength(1)
  })

  it('filters by status', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })
    const rows = await listChecks(testDb, { status: 'RELEASED' })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('RELEASED')
  })

  it('filters by eligibility so INTERNAL checks can be reviewed separately', async () => {
    await makeCheck({ eligibility: 'INTERNAL' })
    await makeCheck({ eligibility: 'SUPPLIER' })
    const rows = await listChecks(testDb, { eligibility: 'INTERNAL' })
    expect(rows).toHaveLength(1)
  })

  it('returns an empty list rather than throwing when nothing matches', async () => {
    expect(await listChecks(testDb, { q: 'no-such-check' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/queries.test.ts`
Expected: FAIL with "Cannot find module '@/lib/queries'".

- [ ] **Step 3: Write `lib/queries.ts`**

```ts
import type { Prisma, PrismaClient, CheckStatus, Eligibility } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type CheckFilters = {
  q?: string
  status?: CheckStatus
  companyId?: string
  cashAccountId?: string
  eligibility?: Eligibility
  from?: Date
  to?: Date
}

export async function getSummary(db: Db) {
  const [grouped, valueAgg, total] = await Promise.all([
    db.check.groupBy({ by: ['status'], _count: { _all: true } }),
    db.check.aggregate({ _sum: { amount: true }, where: { status: { not: 'CANCELLED' } } }),
    db.check.count(),
  ])
  const count = (s: CheckStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0
  return {
    total,
    pendingSignature: count('GENERATED') + count('SIGNATURE_PENDING'),
    signed: count('SIGNED'),
    readyForRelease: count('READY_FOR_RELEASE'),
    scheduled: count('SCHEDULED'),
    released: count('RELEASED'),
    totalValue: (valueAgg._sum.amount ?? 0).toString(),
  }
}

export async function listChecks(db: Db, filters: CheckFilters, limit = 200) {
  const where: Prisma.CheckWhereInput = {}

  if (filters.status) where.status = filters.status
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.cashAccountId) where.cashAccountId = filters.cashAccountId
  if (filters.eligibility) where.eligibility = filters.eligibility
  if (filters.from || filters.to) {
    where.checkDate = { gte: filters.from, lte: filters.to }
  }

  const q = filters.q?.trim()
  if (q) {
    where.OR = [
      { checkNumber: { contains: q, mode: 'insensitive' } },
      { cvNumber: { contains: q, mode: 'insensitive' } },
      { payeeName: { contains: q, mode: 'insensitive' } },
      { bills: { some: { apvNumber: { contains: q, mode: 'insensitive' } } } },
      { bills: { some: { poNumber: { contains: q, mode: 'insensitive' } } } },
    ]
  }

  return db.check.findMany({
    where,
    include: { company: true, cashAccount: true, bills: { take: 1 } },
    orderBy: [{ checkDate: 'desc' }, { checkNumber: 'asc' }],
    take: limit,
  })
}

export type CheckRow = Awaited<ReturnType<typeof listChecks>>[number]
```

- [ ] **Step 4: Run to verify the query tests pass**

Run: `npm test -- tests/queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the presentational components**

`components/StatusPill.tsx`:

```tsx
const STYLES: Record<string, string> = {
  GENERATED:         'bg-slate-100 text-slate-700',
  SIGNATURE_PENDING: 'bg-amber-50 text-amber-800',
  SIGNED:            'bg-sky-50 text-sky-800',
  READY_FOR_RELEASE: 'bg-emerald-50 text-emerald-800',
  SCHEDULED:         'bg-indigo-50 text-indigo-800',
  RELEASED:          'bg-violet-50 text-violet-800',
  CANCELLED:         'bg-rose-50 text-rose-800',
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${STYLES[status] ?? STYLES.GENERATED}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}
```

`components/SummaryCards.tsx`:

```tsx
import { formatPhp } from '@/lib/money'

type Summary = {
  total: number; pendingSignature: number; signed: number
  readyForRelease: number; scheduled: number; released: number; totalValue: string
}

function Card({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-5 ring-1 ${accent ? 'bg-emerald-50 ring-emerald-200' : 'bg-white ring-slate-200'}`}>
      <p className="text-xs font-medium tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  )
}

// Card order follows the spec's priority: READY FOR RELEASE is the primary
// daily Finance activity and leads the row.
export function SummaryCards({ summary }: { summary: Summary }) {
  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
      <Card label="READY FOR RELEASE" value={String(summary.readyForRelease)} accent />
      <Card label="SCHEDULED" value={String(summary.scheduled)} />
      <Card label="PENDING SIGNATURE" value={String(summary.pendingSignature)} />
      <Card label="RELEASED" value={String(summary.released)} />
      <Card label="SIGNED" value={String(summary.signed)} />
      <Card label="TOTAL CHECKS" value={String(summary.total)} />
      <Card label="TOTAL CHECK VALUE" value={formatPhp(summary.totalValue)} />
    </section>
  )
}
```

`components/CheckTable.tsx`:

```tsx
import Link from 'next/link'
import { formatPhp } from '@/lib/money'
import { StatusPill } from './StatusPill'
import type { CheckRow } from '@/lib/queries'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '\u2014'

export function CheckTable({ rows }: { rows: CheckRow[] }) {
  if (rows.length === 0) {
    return <p className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">NO CHECKS MATCH THESE FILTERS.</p>
  }
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">CHECK NUMBER</th>
            <th className="px-4 py-3">APV NUMBER</th>
            <th className="px-4 py-3">SUPPLIER NAME</th>
            <th className="px-4 py-3">COMPANY</th>
            <th className="px-4 py-3">CHECK DATE</th>
            <th className="px-4 py-3 text-right">AMOUNT</th>
            <th className="px-4 py-3">STATUS</th>
            <th className="px-4 py-3">AVAILABLE DATE</th>
            <th className="px-4 py-3">PICKUP SCHEDULE</th>
            <th className="px-4 py-3">ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
              <td className="px-4 py-3 font-medium">{r.checkNumber}</td>
              <td className="px-4 py-3 text-slate-600">{r.bills[0]?.apvNumber ?? '\u2014'}</td>
              <td className="px-4 py-3">
                {r.payeeName}
                {r.eligibility === 'INTERNAL' && (
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tracking-wide text-slate-600">
                    INTERNAL
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-slate-600">{r.company.code}</td>
              <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatPhp(r.amount)}</td>
              <td className="px-4 py-3"><StatusPill status={r.status} /></td>
              <td className="px-4 py-3 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
              <td className="px-4 py-3 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
              <td className="px-4 py-3">
                <Link href={`/checks/${r.id}`} className="text-sm font-medium text-slate-900 underline underline-offset-2">
                  OPEN
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 6: Rewrite `app/page.tsx`**

```tsx
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSummary, listChecks } from '@/lib/queries'
import { SummaryCards } from '@/components/SummaryCards'
import { CheckTable } from '@/components/CheckTable'
import type { CheckStatus } from '@prisma/client'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [summary, rows] = await Promise.all([
    getSummary(prisma),
    listChecks(prisma, {
      q: params.q,
      status: params.status ? (params.status as CheckStatus) : undefined,
    }),
  ])

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-wide">CHECK RELEASE MONITORING</h1>
        <p className="text-sm text-slate-500">{user.name} \u00B7 {user.role.replace(/_/g, ' ')}</p>
      </header>

      <SummaryCards summary={summary} />

      <form className="flex flex-wrap gap-3" method="get">
        <input
          name="q" defaultValue={params.q ?? ''}
          placeholder="SEARCH CHECK NO., APV, PO OR SUPPLIER"
          className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <select name="status" defaultValue={params.status ?? ''}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">ALL STATUSES</option>
          {['SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          APPLY
        </button>
      </form>

      <CheckTable rows={rows} />
    </main>
  )
}
```

- [ ] **Step 7: Run the app and confirm the dashboard renders**

```bash
npm run dev
```

Open `http://localhost:3000`, sign in as `finance@rcl.test` / `F1nance!Passw0rd`.
Expected: seven summary cards with READY FOR RELEASE first showing 2, and a table of 12 seeded checks. Searching `henkel` narrows to one row. The payroll and fund-transfer rows show an `INTERNAL` badge.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add dashboard with summary cards, search, filters and monitoring table

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Check Detail Page and Wired Actions

**Files:**
- Create: `app/checks/[id]/page.tsx`, `app/checks/actions.ts`, `components/AuditTrail.tsx`, `components/ReadyForReleaseForm.tsx`
- Test: `tests/actions/server-actions.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9
- Produces server actions, each returning `{ ok: true } | { ok: false; message: string }`:
  - `signAction(formData: FormData)`
  - `readyForReleaseAction(formData: FormData)`
  - `revertAction(formData: FormData)`
  - `releaseAction(formData: FormData)`
  - `clearingAction(formData: FormData)`
  - `cancelAction(formData: FormData)`

- [ ] **Step 1: Write the failing server-action tests**

`tests/actions/server-actions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  const u = await makeUser()
  currentUser.id = u.id
})

function fd(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

describe('readyForReleaseAction', () => {
  it('marks a signed check ready and reports success', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
  })

  it('returns the exact spec warning for an unsigned check', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result).toEqual({
      ok: false,
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    })
  })

  it('rejects a missing availability date without throwing', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('revertAction', () => {
  it('requires a reason', async () => {
    const { readyForReleaseAction, revertAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await revertAction(fd({ checkId: check.id, reason: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('releaseAction', () => {
  it('releases an available check', async () => {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await releaseAction(fd({ checkId: check.id, remarks: 'Picked up by supplier' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/actions/server-actions.test.ts`
Expected: FAIL with "Cannot find module '@/app/checks/actions'".

- [ ] **Step 3: Write `app/checks/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import {
  markSigned, markReadyForRelease, revertAvailability,
  markReleased, recordClearing, cancelCheck,
} from '@/lib/domain/actions'
import type { ClearingStatus } from '@/lib/domain/check-status'

export type ActionResult = { ok: true } | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
const date = (f: FormData, k: string) => {
  const v = str(f, k)
  return v ? new Date(v) : null
}

// Domain errors carry user-facing copy written to the spec; anything else is a
// bug and must not leak its message to a Finance user.
async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn()
    revalidatePath('/')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function signAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(() => markSigned(prisma, { checkId, userId: user.id, now: new Date() }))
}

export async function readyForReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(() => markReadyForRelease(prisma, {
    checkId, userId: user.id,
    availablePickupDate: date(formData, 'availablePickupDate'),
    now: new Date(),
  }))
}

export async function revertAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => revertAvailability(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}

export async function releaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => markReleased(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    orNumber: str(formData, 'orNumber') || undefined,
    orDate: date(formData, 'orDate') ?? undefined,
    remarks: str(formData, 'remarks') || undefined,
    now: new Date(),
  }))
}

export async function clearingAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => recordClearing(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    clearingStatus: str(formData, 'clearingStatus') as ClearingStatus,
    crNumber: str(formData, 'crNumber') || undefined,
    clearedDate: date(formData, 'clearedDate') ?? undefined,
    now: new Date(),
  }))
}

export async function cancelAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  return run(() => cancelCheck(prisma, {
    checkId: str(formData, 'checkId'), userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}
```

- [ ] **Step 4: Run to verify the server-action tests pass**

Run: `npm test -- tests/actions/server-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `components/AuditTrail.tsx`**

```tsx
type Row = {
  id: string
  createdAt: Date
  actorType: string
  action: string
  remarks: string | null
  user: { name: string } | null
}

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function AuditTrail({ rows }: { rows: Row[] }) {
  return (
    <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
      <h2 className="mb-4 text-sm font-semibold tracking-wide">AUDIT TRAIL</h2>
      <table className="w-full text-sm">
        <thead className="text-left text-xs tracking-wide text-slate-500">
          <tr>
            <th className="pb-2">DATE/TIME</th>
            <th className="pb-2">USER</th>
            <th className="pb-2">ACTION</th>
            <th className="pb-2">REMARKS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="py-2 text-slate-600">{fmt(r.createdAt)}</td>
              <td className="py-2">{r.actorType === 'SYSTEM' ? 'SYSTEM' : r.user?.name ?? '\u2014'}</td>
              <td className="py-2">{r.action.replace(/_/g, ' ').toUpperCase()}</td>
              <td className="py-2 text-slate-600">{r.remarks ?? '\u2014'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 6: Write `components/ReadyForReleaseForm.tsx`**

The confirmation dialog is required by the spec before the status changes.

```tsx
'use client'

import { useState, useTransition } from 'react'
import { readyForReleaseAction, type ActionResult } from '@/app/checks/actions'

export function ReadyForReleaseForm({ checkId, defaultDate }: { checkId: string; defaultDate: string }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!confirm('Are you sure you want to mark this check as READY FOR RELEASE?')) return
        const formData = new FormData(e.currentTarget)
        startTransition(async () => setResult(await readyForReleaseAction(formData)))
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      <label className="block text-xs font-medium tracking-wide text-slate-600">AVAILABLE PICKUP DATE</label>
      <input name="availablePickupDate" type="date" required defaultValue={defaultDate}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />

      <button type="submit" disabled={pending}
        className="block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? 'SAVING\u2026' : 'MARK READY FOR RELEASE'}
      </button>

      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
      {result?.ok && (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          Check is now READY FOR RELEASE.
        </p>
      )}
    </form>
  )
}
```

- [ ] **Step 7: Write `app/checks/[id]/page.tsx`**

```tsx
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { formatPhp } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { AuditTrail } from '@/components/AuditTrail'
import { ReadyForReleaseForm } from '@/components/ReadyForReleaseForm'
import { signAction, releaseAction } from '../actions'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '\u2014'
const fmtDateTime = (d: Date | null) =>
  d ? d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '\u2014'

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  )
}

export default async function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser()
  const { id } = await params

  const check = await prisma.check.findUnique({
    where: { id },
    include: {
      company: true, cashAccount: true, checkBook: true, bills: true,
      signedBy: true, readyBy: true, releasedBy: true,
      auditLogs: { include: { user: true }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!check) notFound()

  const today = new Date().toISOString().slice(0, 10)

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <Link href="/" className="text-sm text-slate-500 underline underline-offset-2">\u2190 BACK TO DASHBOARD</Link>

      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-wide">CHECK {check.checkNumber}</h1>
          <p className="text-sm text-slate-500">{check.payeeName}</p>
        </div>
        <StatusPill status={check.status} />
      </header>

      {check.eligibility === 'INTERNAL' && (
        <p className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-700">
          <strong>NOT PORTAL-ELIGIBLE.</strong> This is an internal payment (payroll, tax,
          fund transfer or inter-company). It is tracked here but is never sent to the Supplier Portal.
        </p>
      )}

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="mb-4 text-sm font-semibold tracking-wide">CHECK INFORMATION</h2>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="CHECK NUMBER" value={check.checkNumber} />
          <Field label="CV NUMBER" value={check.cvNumber ?? '\u2014'} />
          <Field label="APV NUMBER" value={check.bills[0]?.apvNumber ?? '\u2014'} />
          <Field label="PAYEE" value={check.payeeName} />
          <Field label="COMPANY" value={check.company.code} />
          <Field label="CHECK DATE" value={fmtDate(check.checkDate)} />
          <Field label="AMOUNT" value={formatPhp(check.amount)} />
          <Field label="CASH ACCOUNT" value={check.cashAccount?.code ?? '\u2014'} />
          <Field label="CHECK BOOK" value={check.checkBook?.code ?? '\u2014'} />
          <Field label="CURRENCY" value={check.currency} />
          <Field label="CATEGORY" value={check.category ?? '\u2014'} />
          <Field label="ELIGIBILITY" value={check.eligibility} />
        </dl>
      </section>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="mb-4 text-sm font-semibold tracking-wide">RELEASE MONITORING</h2>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="SIGNED BY" value={check.signedBy?.name ?? '\u2014'} />
          <Field label="SIGNED DATE/TIME" value={fmtDateTime(check.signedAt)} />
          <Field label="READY BY" value={check.readyBy?.name ?? '\u2014'} />
          <Field label="READY DATE/TIME" value={fmtDateTime(check.readyAt)} />
          <Field label="AVAILABLE PICKUP DATE" value={fmtDate(check.availablePickupDate)} />
          <Field label="SUPPLIER PICKUP SCHEDULE" value={fmtDate(check.scheduledPickupDate)} />
          <Field label="RELEASED BY" value={check.releasedBy?.name ?? '\u2014'} />
          <Field label="RELEASED DATE/TIME" value={fmtDateTime(check.releasedAt)} />
          <Field label="CLEARING STATUS" value={check.clearingStatus} />
          <Field label="CR NUMBER" value={check.crNumber ?? '\u2014'} />
          <Field label="REMARKS" value={check.remarks ?? '\u2014'} />
        </dl>
      </section>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="mb-4 text-sm font-semibold tracking-wide">ACTIONS</h2>

        {check.status === 'SIGNATURE_PENDING' && (
          <form action={signAction}>
            <input type="hidden" name="checkId" value={check.id} />
            <button className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white">MARK SIGNED</button>
          </form>
        )}

        {check.status === 'SIGNED' && (
          <ReadyForReleaseForm checkId={check.id} defaultDate={today} />
        )}

        {(check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') && (
          <form action={releaseAction} className="space-y-3">
            <input type="hidden" name="checkId" value={check.id} />
            <label className="block text-xs font-medium tracking-wide text-slate-600">REMARKS</label>
            <input name="remarks" placeholder="Picked up by supplier"
              className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button className="block rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white">
              MARK RELEASED
            </button>
          </form>
        )}

        {check.status === 'RELEASED' && (
          <p className="text-sm text-slate-500">This check has been released.</p>
        )}
        {check.status === 'CANCELLED' && (
          <p className="text-sm text-rose-700">CANCELLED \u2014 {check.cancelReason}</p>
        )}
      </section>

      <AuditTrail rows={check.auditLogs} />
    </main>
  )
}
```

- [ ] **Step 8: Walk the full workflow in the browser**

```bash
npm run dev
```

Sign in as `finance@rcl.test`. Open the `HENKEL PHILIPPINES INC.` check (status SIGNATURE PENDING) and confirm each step:

1. Click **MARK SIGNED** → status becomes SIGNED, audit row appears.
2. Set an available pickup date, click **MARK READY FOR RELEASE**, accept the confirmation → status becomes READY FOR RELEASE.
3. Click **MARK RELEASED** with remarks → status becomes RELEASED and the audit trail shows all three actions with user and timestamp.
4. Open the payroll check (`6000308611`) and confirm the **NOT PORTAL-ELIGIBLE** banner appears and that ticking ready still works.

- [ ] **Step 9: Run the complete suite and build**

```bash
npm test
npm run build
```

Expected: all tests pass, build succeeds with no TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add check detail page with wired sign/ready/release actions and audit trail

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Plan 1 Completion Criteria

- [ ] `npm test` passes with no failures
- [ ] `npm run build` succeeds
- [ ] A Finance user can sign in, and cannot reach any page while signed out
- [ ] A check can be driven SIGNATURE_PENDING → SIGNED → READY_FOR_RELEASE → RELEASED through the UI
- [ ] Attempting READY FOR RELEASE on an unsigned check shows the exact spec warning
- [ ] An INTERNAL check shows the NOT PORTAL-ELIGIBLE banner and produces no `PortalEvent` row
- [ ] Every action appears in the audit trail with actor and timestamp
- [ ] No supplier-facing route exists anywhere in `app/`

## What Plan 1 Deliberately Leaves Out

| Deferred to | Item |
| --- | --- |
| Plan 2 | Workbook importer, field sniffer, reconciliation report, Acumatica client, sync service |
| Plan 3 | PortalClient and outbox worker (events are queued in Plan 1 but nothing drains them), pickup polling, unmatched queue, batch release, reports and exports, notifications, user administration |
