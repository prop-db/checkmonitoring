# PORTAL RELEASES Read-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Checks released on the Supplier Portal become RELEASED in Check Monitoring, with the portal's release date and OR, read back on every scheduled sync and on SYNC NOW.

**Architecture:** The Supplier Portal gets one read-only, token-guarded endpoint listing released rows since an instant. Check Monitoring gets a reader (HTTP + pure mapper), a sync run with its own `SyncRun` mode and watermark that matches each row to one live check on check number + APV and releases it in its own transaction (no outbox echo), wiring into the cron and SYNC NOW, a "needing a look" list on `/admin/portal`, and rewritten rules 5 and 12.

**Tech Stack:** Supplier Portal: Node/Express, `pg`, `node --test`. Check Monitoring: Next.js 15, Prisma 6, Vitest, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-19-portal-releases-read-back-design.md`

## Global Constraints

- A portal release applies only to a check that is GENERATED, SIGNATURE_PENDING, SIGNED, READY_FOR_RELEASE or SCHEDULED here. CANCELLED or VOIDED here: never released, listed `DEAD_HERE`. Already RELEASED: nothing.
- Match on canonical check number (`canonicalCheckNumber`, `lib/import/normalise.ts`) **and** a shared APV. None → `NOT_FOUND`; more than one → `AMBIGUOUS`.
- Skip rows with `releasedByService = true` (this app's own echo).
- Release write: `status = RELEASED`; `releasedAt` = portal `releasedAt`, else `statedReleaseDate` = portal `releaseDate`; `releasedById` null; `orNumber`/`orDate` only when the check has no `orNumber` yet; `receiptType` null; never `crNumber` (rule 11). One audit row `released_on_supplier_portal`. **No `PortalEvent` is created.**
- `SyncRun.mode = 'PORTAL_RELEASES'`, in `NON_PAYMENT_MODES`. Watermark = last row's `updatedAt` − 10 minutes; held (null) when any write failed. First read (no watermark) starts at `2026-10-19T00:00:00+08:00`.
- Portal endpoint: `GET /api/integrations/check-monitoring/releases?since=<ISO>&limit=<1..1000>`, guarded by `requireServiceToken(pool, { envName: 'CHECK_MONITORING_TOKEN', username: 'check-monitoring' })`, read-only.
- Check Monitoring reads with `PORTAL_BASE_URL` / `PORTAL_TOKEN`; unset → the run is skipped (`SKIPPED_NOT_CONFIGURED`), never an error.
- Work in worktrees, never the shared main checkouts. **Local `.env` DATABASE_URL is PRODUCTION in both repos where present — never run scripts or servers against it.** Tests use the TEST databases only.
- Check Monitoring: `node node_modules/vitest/vitest.mjs run <files>`, `node node_modules/typescript/bin/tsc --noEmit`, regenerate Prisma first. Supplier Portal: `node --test test/<file>`.
- Spell "check", not "cheque". Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Pushing to master and deploying are done by the user. **Deploy order: the portal first (the endpoint), then Check Monitoring.**

---

## File Structure

| Repo | File | Responsibility |
| --- | --- | --- |
| Supplier Portal | `src/integrations/check-monitoring-releases.js` (create) | `listReleasesSince(pool, { since, limit })` — the read |
| Supplier Portal | `src/server.js` (modify) | the GET route, beside the events route |
| Supplier Portal | `test/check-monitoring-releases.test.js` (create) | endpoint tests |
| Check Monitoring | `lib/sync/modes.ts` (modify) | `PORTAL_RELEASES_MODE` |
| Check Monitoring | `lib/integrations/portal/releases.ts` (create) | types, `mapPortalRelease`, `createPortalReleasesReader` |
| Check Monitoring | `lib/integrations/portal/from-env.ts` (modify) | `createPortalReleasesReaderFromEnv` |
| Check Monitoring | `lib/sync/portal-releases.ts` (create) | the run: match, decide, write, watermark; scheduled wrapper |
| Check Monitoring | `app/api/cron/sync/route.ts` (modify) | runs the read after BILL_REFS |
| Check Monitoring | `app/admin/actions.ts` (modify) | SYNC NOW runs it too |
| Check Monitoring | `app/admin/portal/page.tsx` (modify) | "PORTAL RELEASES NEEDING A LOOK" |
| Check Monitoring | `CLAUDE.md` (modify) | rules 5 and 12; the read |

---

### Task 1 (Supplier Portal): the releases endpoint

Work in a new worktree of the Supplier Portal repo: from `C:\Users\User\Desktop\RCL PROJECTS\Supplier Portal`, `git worktree add -b feature/cm-releases-endpoint ..\sp-cm-releases origin/main` (use the repo's default branch name if it is not `main`: `git symbolic-ref refs/remotes/origin/HEAD`). Install or junction `node_modules` as that repo does for worktrees; read its CLAUDE.md first for test database rules.

**Files:**
- Create: `src/integrations/check-monitoring-releases.js`
- Modify: `src/server.js` (after the `app.post('/api/integrations/check-monitoring/events', …)` block)
- Test: `test/check-monitoring-releases.test.js`

**Interfaces:**
- Produces: `GET /api/integrations/check-monitoring/releases?since&limit` → `{ rows: Release[], next: string|null }`, `Release = { domain: 'LOCAL'|'BROKER', releaseId: number, checkNumber: string, apvNumbers: string[], releaseDate: string|null (YYYY-MM-DD), releasedAt: string|null (ISO), orNumber: string|null, orDate: string|null, releasedByName: string|null, releasedByService: boolean, updatedAt: string (ISO) }`.

- [ ] **Step 1: Write the failing test** — `test/check-monitoring-releases.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/server');
const { testPool } = require('./helpers/db');

async function boot(pool) {
  const app = createApp({ pool, secret: 'test-secret' });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`,
    async stop() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
async function get(base, qs, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}/api/integrations/check-monitoring/releases?${qs}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function fixture(t) {
  const pool = testPool();
  await runMigrations(pool);
  await pool.query("insert into tenant (name,slug) values ('T','t')");
  const tn = (await pool.query('select id from tenant')).rows[0].id;
  await pool.query("insert into supplier (canonical_name) values ('S1')");
  const s = (await pool.query('select id from supplier')).rows[0].id;
  await pool.query('insert into supplier_tenant (supplier_id,tenant_id) values ($1,$2)', [s, tn]);
  for (const [nk, apv] of [['nk1', 'AP-1001'], ['nk2', 'AP-1002']]) {
    await pool.query(`insert into trade (tenant_id,supplier_id,natural_key,apv_number,description,po_amount,balance,settled,payment_terms)
      values ($1,$2,$3,$4,'A',100,100,false,'COD')`, [tn, s, nk, apv]);
  }
  const [t1, t2] = (await pool.query('select id from trade order by natural_key')).rows.map(r => r.id);
  const svc = (await pool.query("select id from app_user where username='check-monitoring'")).rows[0].id;
  // Released by a person at 10:00 UTC, released by the service at 11:00, and one not released.
  await pool.query(`insert into check_release (trade_id, check_number, status, release_date, released_at, or_number, or_date, released_by_name, updated_at)
    values ($1,'6000354897','RELEASED','2026-10-19','2026-10-19T10:00:00Z','4852','2026-10-19','LUSIE','2026-10-19T10:00:00Z')`, [t1]);
  await pool.query(`insert into check_release (trade_id, check_number, status, released_by, released_at, release_date, updated_at)
    values ($1,'6000354898','RELEASED',$2,'2026-10-19T11:00:00Z','2026-10-19','2026-10-19T11:00:00Z')`, [t2, svc]);
  const srv = await boot(pool);
  t.after(async () => { await srv.stop(); await pool.end(); delete process.env.CHECK_MONITORING_TOKEN; });
  return { pool, srv, t1 };
}

test('releases route: guarded by the service token', async (t) => {
  const { srv } = await fixture(t);
  delete process.env.CHECK_MONITORING_TOKEN;
  assert.strictEqual((await get(srv.base, 'since=2026-10-01T00:00:00Z', 'x')).status, 503);
  process.env.CHECK_MONITORING_TOKEN = 'tok';
  assert.strictEqual((await get(srv.base, 'since=2026-10-01T00:00:00Z', 'wrong')).status, 401);
  assert.strictEqual((await get(srv.base, 'since=2026-10-01T00:00:00Z')).status, 401);
});

test('releases route: RELEASED rows since an instant, oldest first, with the echo flagged', async (t) => {
  const { srv } = await fixture(t);
  process.env.CHECK_MONITORING_TOKEN = 'tok';
  const r = await get(srv.base, 'since=2026-10-19T00:00:00Z', 'tok');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.rows.map(x => [x.checkNumber, x.apvNumbers, x.releasedByService]), [
    ['6000354897', ['AP-1001'], false],
    ['6000354898', ['AP-1002'], true],
  ]);
  const first = r.body.rows[0];
  assert.strictEqual(first.domain, 'LOCAL');
  assert.strictEqual(first.releaseDate, '2026-10-19');
  assert.strictEqual(first.orNumber, '4852');
  assert.strictEqual(first.releasedByName, 'LUSIE');
  assert.strictEqual(first.releasedAt, '2026-10-19T10:00:00.000Z');
  assert.strictEqual(r.body.next, null);
  const later = await get(srv.base, 'since=2026-10-19T10:30:00Z', 'tok');
  assert.deepStrictEqual(later.body.rows.map(x => x.checkNumber), ['6000354898']);
});

test('releases route: pages with limit and next', async (t) => {
  const { srv } = await fixture(t);
  process.env.CHECK_MONITORING_TOKEN = 'tok';
  const p1 = await get(srv.base, 'since=2026-10-19T00:00:00Z&limit=1', 'tok');
  assert.strictEqual(p1.body.rows.length, 1);
  assert.strictEqual(p1.body.next, '2026-10-19T10:00:00.000Z');
  const p2 = await get(srv.base, `since=${encodeURIComponent(p1.body.next)}&limit=1`, 'tok');
  assert.deepStrictEqual(p2.body.rows.map(x => x.checkNumber), ['6000354898']);
});

test('releases route: a bad since is 400', async (t) => {
  const { srv } = await fixture(t);
  process.env.CHECK_MONITORING_TOKEN = 'tok';
  assert.strictEqual((await get(srv.base, 'since=nonsense', 'tok')).status, 400);
});
```

If `check_release` has other NOT NULL columns without defaults in the current migrations, add them to the two inserts (read `migrations/011_check_release.sql` and later `alter table check_release` migrations first).

- [ ] **Step 2: Run it — expect 404s / failures**

Run: `node --test test/check-monitoring-releases.test.js`
Expected: FAIL (route not found → 404, not 503/401/200).

- [ ] **Step 3: Implement the read** — `src/integrations/check-monitoring-releases.js`:

```js
// Supplier Portal -> Check Monitoring, READ-ONLY (spec 2026-10-19-portal-releases-read-back-design,
// Check Monitoring repo). Checks released on the portal, for Check Monitoring to record as RELEASED.
// RELEASED rows of both domains changed after `since`, oldest first; `next` is the last row's
// updated_at when the page is full. `releasedByService` marks a release Check Monitoring itself sent
// (released_by = the check-monitoring service user), which the reader skips as its own echo.
const MAX_LIMIT = 1000;

async function listReleasesSince(pool, { since, limit = MAX_LIMIT }) {
  const n = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || MAX_LIMIT));
  const { rows } = await pool.query(
    `with svc as (select id from app_user where username = 'check-monitoring')
     select * from (
       select 'LOCAL' as domain, cr.id as "releaseId", cr.check_number as "checkNumber",
              array_remove(array[t.apv_number], null) as "apvNumbers",
              to_char(cr.release_date, 'YYYY-MM-DD') as "releaseDate", cr.released_at as "releasedAt",
              nullif(cr.or_number, '') as "orNumber", to_char(cr.or_date, 'YYYY-MM-DD') as "orDate",
              cr.released_by_name as "releasedByName",
              (cr.released_by is not null and cr.released_by in (select id from svc)) as "releasedByService",
              cr.updated_at as "updatedAt"
         from check_release cr join trade t on t.id = cr.trade_id
        where cr.status = 'RELEASED' and cr.updated_at > $1
       union all
       select 'BROKER', bcr.id, bcr.check_number, array_remove(array[bt.apv_number], null),
              to_char(bcr.release_date, 'YYYY-MM-DD'), bcr.released_at,
              nullif(bcr.or_number, ''), to_char(bcr.or_date, 'YYYY-MM-DD'), bcr.released_by_name,
              (bcr.released_by is not null and bcr.released_by in (select id from svc)), bcr.updated_at
         from broker_check_release bcr join broker_transaction bt on bt.id = bcr.broker_transaction_id
        where bcr.status = 'RELEASED' and bcr.updated_at > $1
     ) x order by "updatedAt", domain, "releaseId" limit $2`,
    [since, n]);
  const out = rows.map(r => ({
    ...r,
    releasedAt: r.releasedAt ? new Date(r.releasedAt).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
  return { rows: out, next: out.length === n ? out[out.length - 1].updatedAt : null };
}

module.exports = { listReleasesSince, MAX_LIMIT };
```

- [ ] **Step 4: Add the route** in `src/server.js`, right after the events route block:

```js
  // Supplier Portal -> Check Monitoring, READ-ONLY (2026-10-19): checks released here, for Check
  // Monitoring to record. Same guard as the events route; no write.
  app.get('/api/integrations/check-monitoring/releases',
    requireServiceToken(pool, { envName: 'CHECK_MONITORING_TOKEN', username: 'check-monitoring' }),
    wrap(async (req, res) => {
      const since = new Date(String(req.query.since ?? ''));
      if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be an ISO instant' });
      res.json(await cmReleases.listReleasesSince(pool, { since: since.toISOString(), limit: req.query.limit }));
    }));
```

and at the top of `src/server.js`, beside the other requires: `const cmReleases = require('./integrations/check-monitoring-releases');`

- [ ] **Step 5: Run the tests — expect PASS**, plus the existing integration tests:

Run: `node --test test/check-monitoring-releases.test.js test/check-monitoring-api.test.js test/auth-service-token.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit and push the branch** (the user merges and deploys the portal first):

```bash
git add src/integrations/check-monitoring-releases.js src/server.js test/check-monitoring-releases.test.js
git commit -m "feat(integrations): read-only releases endpoint for Check Monitoring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feature/cm-releases-endpoint
```

---

### Task 2 (Check Monitoring): the mode and the reader

Work in `C:\Users\User\Desktop\RCL PROJECTS\cm-portal-releases` (branch `feature/portal-releases`). Copy `.env` from the main checkout and junction `node_modules` first (`cmd //c mklink //J node_modules "..\\Check Monitoring\\node_modules"`), then `node node_modules/prisma/build/index.js generate`.

**Files:**
- Modify: `lib/sync/modes.ts`
- Create: `lib/integrations/portal/releases.ts`
- Modify: `lib/integrations/portal/from-env.ts`
- Test: `tests/integrations/portal-releases.test.ts`, `tests/sync/modes.test.ts`

**Interfaces:**
- Produces: `PORTAL_RELEASES_MODE = 'PORTAL_RELEASES'` (in `NON_PAYMENT_MODES`);
  `type PortalRelease = { domain: 'LOCAL' | 'BROKER'; releaseId: number; checkNumber: string; apvNumbers: string[]; releaseDate: string | null; releasedAt: Date | null; orNumber: string | null; orDate: string | null; releasedByName: string | null; releasedByService: boolean; updatedAt: Date }`;
  `mapPortalRelease(raw: unknown): PortalRelease | null`;
  `type PortalReleasesReader = { list(since: Date, limit: number): Promise<{ rows: PortalRelease[]; next: Date | null }> }`;
  `createPortalReleasesReader(opts: { baseUrl: string; token: string; fetchImpl?: ReleasesFetch; timeoutMs?: number }): PortalReleasesReader`;
  `createPortalReleasesReaderFromEnv(): PortalReleasesReader` (throws when unset, naming the variable).

- [ ] **Step 1: Failing tests** — append to `tests/sync/modes.test.ts`:

```ts
import { PORTAL_RELEASES_MODE } from '@/lib/sync/modes'
it('PORTAL_RELEASES is a non-payment mode', () => {
  expect(PORTAL_RELEASES_MODE).toBe('PORTAL_RELEASES')
  expect(NON_PAYMENT_MODES).toContain('PORTAL_RELEASES')
})
```

(Use the file's existing import of `NON_PAYMENT_MODES`; put the `it` inside the existing top-level `describe` if there is one.)

Create `tests/integrations/portal-releases.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapPortalRelease, createPortalReleasesReader } from '@/lib/integrations/portal/releases'

const raw = {
  domain: 'LOCAL', releaseId: 7, checkNumber: ' 6000354897 ', apvNumbers: ['ap-st045048'],
  releaseDate: '2026-10-19', releasedAt: '2026-10-19T02:30:00.000Z', orNumber: '4852', orDate: '2026-10-19',
  releasedByName: 'LUSIE', releasedByService: false, updatedAt: '2026-10-19T02:30:05.000Z',
}

describe('mapPortalRelease', () => {
  it('maps every field, trimming and upper-casing references', () => {
    expect(mapPortalRelease(raw)).toEqual({
      domain: 'LOCAL', releaseId: 7, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'],
      releaseDate: '2026-10-19', releasedAt: new Date('2026-10-19T02:30:00.000Z'), orNumber: '4852', orDate: '2026-10-19',
      releasedByName: 'LUSIE', releasedByService: false, updatedAt: new Date('2026-10-19T02:30:05.000Z'),
    })
  })
  it('missing optional values are null; a broker row keeps its domain', () => {
    const m = mapPortalRelease({ ...raw, domain: 'BROKER', releasedAt: null, orNumber: '', orDate: null, releaseDate: null })!
    expect(m).toMatchObject({ domain: 'BROKER', releasedAt: null, orNumber: null, orDate: null, releaseDate: null })
  })
  it('refuses a row without a check number, an updatedAt or a known domain', () => {
    expect(mapPortalRelease({ ...raw, checkNumber: '' })).toBeNull()
    expect(mapPortalRelease({ ...raw, updatedAt: 'x' })).toBeNull()
    expect(mapPortalRelease({ ...raw, domain: 'OTHER' })).toBeNull()
    expect(mapPortalRelease(null)).toBeNull()
  })
})

describe('createPortalReleasesReader', () => {
  it('GETs the endpoint with the bearer and since/limit, and maps the page', async () => {
    const calls: string[] = []
    const reader = createPortalReleasesReader({
      baseUrl: 'https://portal.test/', token: 'tok',
      fetchImpl: async (url, init) => {
        calls.push(`${init.method} ${url} ${init.headers.authorization}`)
        return { ok: true, status: 200, text: async () => JSON.stringify({ rows: [raw, { bad: 1 }], next: '2026-10-19T02:30:05.000Z' }) }
      },
    })
    const page = await reader.list(new Date('2026-10-19T00:00:00Z'), 500)
    expect(calls).toEqual(['GET https://portal.test/api/integrations/check-monitoring/releases?since=2026-10-19T00%3A00%3A00.000Z&limit=500 Bearer tok'])
    expect(page.rows.map((r) => r.checkNumber)).toEqual(['6000354897'])
    expect(page.next).toEqual(new Date('2026-10-19T02:30:05.000Z'))
  })
  it('throws on a non-200 answer, naming the status', async () => {
    const reader = createPortalReleasesReader({ baseUrl: 'https://p', token: 't', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }) })
    await expect(reader.list(new Date(), 10)).rejects.toThrow(/401/)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/portal-releases.test.ts tests/sync/modes.test.ts`

- [ ] **Step 3: Implement.** In `lib/sync/modes.ts` add the mode to the comment table (`PORTAL_RELEASES  lib/sync/portal-releases.ts  Supplier Portal releases -> Check RELEASED`) and:

```ts
export const PORTAL_RELEASES_MODE = 'PORTAL_RELEASES'
export const NON_PAYMENT_MODES = [BILLS_MODE, BILL_REFS_MODE, PORTAL_RELEASES_MODE] as const
```

Create `lib/integrations/portal/releases.ts`:

```ts
/**
 * Supplier Portal -> Check Monitoring, the ONE read back from the portal (rule 12, rewritten
 * 2026-10-19): checks released on the portal (spec 2026-10-19-portal-releases-read-back-design.md).
 * GET only, with the outbox's bearer. Pure mapper; the client is the only network code.
 */
export type ReleasesFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type PortalRelease = {
  domain: 'LOCAL' | 'BROKER'
  releaseId: number
  checkNumber: string
  apvNumbers: string[]
  releaseDate: string | null
  releasedAt: Date | null
  orNumber: string | null
  orDate: string | null
  releasedByName: string | null
  releasedByService: boolean
  updatedAt: Date
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null)
const instant = (v: unknown) => { const s = str(v); if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d }

export function mapPortalRelease(raw: unknown): PortalRelease | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const domain = str(r.domain)
  const checkNumber = str(r.checkNumber)
  const updatedAt = instant(r.updatedAt)
  if ((domain !== 'LOCAL' && domain !== 'BROKER') || !checkNumber || !updatedAt) return null
  return {
    domain,
    releaseId: Number(r.releaseId),
    checkNumber,
    apvNumbers: Array.isArray(r.apvNumbers) ? r.apvNumbers.map((a) => str(a).toUpperCase()).filter(Boolean) : [],
    releaseDate: day(r.releaseDate),
    releasedAt: instant(r.releasedAt),
    orNumber: str(r.orNumber) || null,
    orDate: day(r.orDate),
    releasedByName: str(r.releasedByName) || null,
    releasedByService: r.releasedByService === true,
    updatedAt,
  }
}

export type PortalReleasesReader = { list(since: Date, limit: number): Promise<{ rows: PortalRelease[]; next: Date | null }> }

export function createPortalReleasesReader(opts: { baseUrl: string; token: string; fetchImpl?: ReleasesFetch; timeoutMs?: number }): PortalReleasesReader {
  const fetchImpl: ReleasesFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/integrations/check-monitoring/releases`
  return {
    async list(since, limit) {
      const url = `${base}?since=${encodeURIComponent(since.toISOString())}&limit=${limit}`
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
      const text = await res.text()
      if (res.status !== 200) throw new Error(`The Supplier Portal answered ${res.status} to the releases read: ${text.slice(0, 200)}`)
      const body = JSON.parse(text) as { rows?: unknown[]; next?: unknown }
      return {
        rows: (body.rows ?? []).map(mapPortalRelease).filter((r): r is PortalRelease => r !== null),
        next: instant(body.next),
      }
    },
  }
}
```

Append to `lib/integrations/portal/from-env.ts`:

```ts
import { createPortalReleasesReader, type PortalReleasesReader } from './releases'

/** The releases reader from the same configuration as the outbox client. */
export function createPortalReleasesReaderFromEnv(): PortalReleasesReader {
  const baseUrl = process.env.PORTAL_BASE_URL ?? ''
  const token = process.env.PORTAL_TOKEN ?? ''
  if (!baseUrl) throw new Error('PORTAL_BASE_URL is not set, so the Supplier Portal cannot be reached.')
  if (!token) throw new Error('PORTAL_TOKEN is not set, so the Supplier Portal cannot be reached.')
  return createPortalReleasesReader({ baseUrl, token })
}
```

(Move the new import to the top of the file with the existing one.)

- [ ] **Step 4: Run — expect PASS**; also `tsc`:

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/portal-releases.test.ts tests/sync/modes.test.ts` then `node node_modules/typescript/bin/tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add lib/sync/modes.ts lib/integrations/portal/releases.ts lib/integrations/portal/from-env.ts tests/integrations/portal-releases.test.ts tests/sync/modes.test.ts
git commit -m "feat(portal): PORTAL_RELEASES mode and the releases reader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3 (Check Monitoring): the run

**Files:**
- Create: `lib/sync/portal-releases.ts`
- Test: `tests/sync/portal-releases.test.ts`

**Interfaces:**
- Consumes: `PortalRelease`, `PortalReleasesReader` (Task 2); `PORTAL_RELEASES_MODE`; `canonicalCheckNumber` (`lib/import/normalise.ts`); `writeAudit` (`lib/audit.ts`); `SYNC_IN_PROGRESS` pattern from `lib/sync/bill-refs.ts`.
- Produces:
  - `PORTAL_RELEASES_FIRST_SINCE = new Date('2026-10-19T00:00:00+08:00')`
  - `RELEASED_ON_PORTAL_ACTION = 'released_on_supplier_portal'`
  - `type Look = { kind: 'DEAD_HERE' | 'NOT_FOUND' | 'AMBIGUOUS'; checkNumber: string; apvNumbers: string[]; detail: string }`
  - `type PortalReleasesResult = { syncRunId: string; read: number; echo: number; released: number; already: number; look: Look[]; errors: number; watermark: Date | null }`
  - `lastPortalReleasesWatermark(db): Promise<Date | null>`
  - `runPortalReleasesSync(db: PrismaClient, args: { reader: PortalReleasesReader; since: Date | null; now: Date; trigger: 'MANUAL' | 'SCHEDULED' }): Promise<PortalReleasesResult>`
  - `type ScheduledPortalReleasesOutcome = { outcome: 'RAN'; syncRunId: string; released: number; already: number; look: number; errors: number } | { outcome: 'SKIPPED_NOT_CONFIGURED' } | { outcome: 'SKIPPED_TIME_BUDGET' } | { outcome: 'FAILED'; message: string }`
  - `runScheduledPortalReleases(db: PrismaClient, args: { now: Date; reader: () => PortalReleasesReader }): Promise<ScheduledPortalReleasesOutcome>`

- [ ] **Step 1: Failing tests** — `tests/sync/portal-releases.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  runPortalReleasesSync, lastPortalReleasesWatermark, runScheduledPortalReleases,
  RELEASED_ON_PORTAL_ACTION, PORTAL_RELEASES_FIRST_SINCE,
} from '@/lib/sync/portal-releases'
import type { PortalRelease, PortalReleasesReader } from '@/lib/integrations/portal/releases'

const NOW = new Date('2026-10-19T12:00:00+08:00')
beforeEach(resetDb)

const rel = (o: Partial<PortalRelease> = {}): PortalRelease => ({
  domain: 'LOCAL', releaseId: 1, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'],
  releaseDate: '2026-10-19', releasedAt: new Date('2026-10-19T02:30:00Z'), orNumber: '4852', orDate: '2026-10-19',
  releasedByName: 'LUSIE', releasedByService: false, updatedAt: new Date('2026-10-19T02:30:05Z'), ...o,
})
function reader(rows: PortalRelease[], seen: Date[] = []): PortalReleasesReader {
  return { async list(since) { seen.push(since); return { rows, next: null } } }
}
const run = (rows: PortalRelease[], since: Date | null = null, seen: Date[] = []) =>
  runPortalReleasesSync(testDb, { reader: reader(rows, seen), since, now: NOW, trigger: 'MANUAL' })

describe('runPortalReleasesSync', () => {
  it.each(['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const)(
    'releases a %s check with the portal date and OR, one audit row, no portal event', async (status) => {
      const c = await makeCheck({ status, checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
      const res = await run([rel()])
      expect(res).toMatchObject({ read: 1, released: 1, already: 0, look: [], errors: 0 })
      expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
        status: 'RELEASED', releasedAt: new Date('2026-10-19T02:30:00Z'), releasedById: null,
        orNumber: '4852', orDate: new Date('2026-10-19T00:00:00Z'), receiptType: null, crNumber: null,
      })
      const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: RELEASED_ON_PORTAL_ACTION } })
      expect(audit.details).toMatchObject({ from: status, releaseId: 1, domain: 'LOCAL', releasedByName: 'LUSIE', orNumber: '4852' })
      expect(await testDb.portalEvent.count()).toBe(0)
    })

  it('with no portal instant, records the release day as the stated release date', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await run([rel({ releasedAt: null })])
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'RELEASED', releasedAt: null, statedReleaseDate: new Date('2026-10-19T00:00:00Z'),
    })
  })

  it('keeps an existing receipt (rule 11: never overwritten)', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await testDb.check.update({ where: { id: c.id }, data: { orNumber: '1111', receiptType: 'OR' } })
    await run([rel()])
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'RELEASED', orNumber: '1111', receiptType: 'OR' })
  })

  it('already RELEASED: nothing; CANCELLED / VOIDED: listed, untouched', async () => {
    const a = await makeCheck({ status: 'RELEASED', checkNumber: '6000000001', apvNumbers: ['AP-1'] })
    const b = await makeCheck({ status: 'CANCELLED', checkNumber: '6000000002', apvNumbers: ['AP-2'] })
    const v = await makeCheck({ status: 'VOIDED', checkNumber: '6000000003', apvNumbers: ['AP-3'] })
    const res = await run([
      rel({ checkNumber: '6000000001', apvNumbers: ['AP-1'] }),
      rel({ checkNumber: '6000000002', apvNumbers: ['AP-2'] }),
      rel({ checkNumber: '6000000003', apvNumbers: ['AP-3'] }),
    ])
    expect(res).toMatchObject({ released: 0, already: 1 })
    expect(res.look.map((l) => [l.kind, l.checkNumber])).toEqual([['DEAD_HERE', '6000000002'], ['DEAD_HERE', '6000000003']])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CANCELLED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('VOIDED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
  })

  it('matches on number AND APV: a reused number with another APV is NOT_FOUND; two matches are AMBIGUOUS', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-OLD'] })
    const r1 = await run([rel({ checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })])
    expect(r1.look.map((l) => l.kind)).toEqual(['NOT_FOUND'])
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })
    const r2 = await run([rel({ checkNumber: '1791379613', apvNumbers: ['AP-NEW'] })])
    expect(r2.look.map((l) => l.kind)).toEqual(['AMBIGUOUS'])
    expect(r2.released).toBe(0)
  })

  it('a bank-prefixed portal number matches the bare number here', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    await run([rel({ checkNumber: 'BPI 6000354897' })])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('RELEASED')
  })

  it('skips its own echo', async () => {
    const c = await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const res = await run([rel({ releasedByService: true })])
    expect(res).toMatchObject({ echo: 1, released: 0 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
  })

  it('records a SyncRun, moves the watermark to the last updatedAt minus 10 minutes, and a re-run is idempotent', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '6000354897', apvNumbers: ['AP-ST045048'] })
    const seen: Date[] = []
    const res = await run([rel()], null, seen)
    expect(seen[0]).toEqual(PORTAL_RELEASES_FIRST_SINCE)
    expect(res.watermark).toEqual(new Date('2026-10-19T02:20:05Z'))
    expect(await lastPortalReleasesWatermark(testDb)).toEqual(new Date('2026-10-19T02:20:05Z'))
    const runRow = await testDb.syncRun.findUniqueOrThrow({ where: { id: res.syncRunId } })
    expect(runRow).toMatchObject({ mode: 'PORTAL_RELEASES', imported: 1, errors: 0 })
    const again = await run([rel()], res.watermark)
    expect(again).toMatchObject({ released: 0, already: 1 })
    expect(await testDb.auditLog.count({ where: { action: RELEASED_ON_PORTAL_ACTION } })).toBe(1)
  })
})

describe('runScheduledPortalReleases', () => {
  it('is SKIPPED_NOT_CONFIGURED when the reader cannot be built', async () => {
    const out = await runScheduledPortalReleases(testDb, { now: NOW, reader: () => { throw new Error('PORTAL_BASE_URL is not set') } })
    expect(out).toEqual({ outcome: 'SKIPPED_NOT_CONFIGURED' })
  })
  it('is FAILED, never throwing, when the portal errors', async () => {
    const out = await runScheduledPortalReleases(testDb, { now: NOW, reader: () => ({ async list() { throw new Error('answered 500') } }) })
    expect(out).toMatchObject({ outcome: 'FAILED' })
  })
})
```

If `makeCheck` does not accept `status: 'GENERATED'`/`'SCHEDULED'`/`'VOIDED'`, widen its `status` type in `tests/helpers/factory.ts` (it is typed `CheckStatus`, which already includes them).

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `node node_modules/prisma/build/index.js generate && node node_modules/vitest/vitest.mjs run tests/sync/portal-releases.test.ts`

- [ ] **Step 3: Implement** — `lib/sync/portal-releases.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { canonicalCheckNumber } from '@/lib/import/normalise'
import { PORTAL_RELEASES_MODE } from '@/lib/sync/modes'
import type { PortalRelease, PortalReleasesReader } from '@/lib/integrations/portal/releases'

/**
 * THE PORTAL RELEASES READ (spec 2026-10-19-portal-releases-read-back-design.md; rules 5 and 12 as
 * rewritten that day). Checks released on the Supplier Portal — handed to the vendor — become
 * RELEASED here, with the portal's release instant (or day) and OR. Match on canonical check number
 * AND a shared APV (numbers are reused: 1791379613, 2026-10-19). A live check is released in its own
 * transaction, conditional on the status it was read in; CANCELLED / VOIDED here, no match, or two
 * matches are listed for a person. No PortalEvent is written: the portal already has the release.
 * Rows this app itself sent (`releasedByService`) are skipped as the echo.
 */
type Db = PrismaClient | Prisma.TransactionClient
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const PAGE = 500
const OVERLAP_MS = 10 * 60_000
const LIVE = ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const

export const PORTAL_RELEASES_FIRST_SINCE = new Date('2026-10-19T00:00:00+08:00')
export const RELEASED_ON_PORTAL_ACTION = 'released_on_supplier_portal'

export type Look = { kind: 'DEAD_HERE' | 'NOT_FOUND' | 'AMBIGUOUS'; checkNumber: string; apvNumbers: string[]; detail: string }
export type PortalReleasesResult = {
  syncRunId: string; read: number; echo: number; released: number; already: number; look: Look[]; errors: number; watermark: Date | null
}

export async function lastPortalReleasesWatermark(db: Db): Promise<Date | null> {
  const r = await db.syncRun.findFirst({
    where: { mode: PORTAL_RELEASES_MODE, watermark: { not: null } }, orderBy: { startedAt: 'desc' }, select: { watermark: true },
  })
  return r?.watermark ?? null
}

const dayDate = (d: string) => new Date(`${d}T00:00:00.000Z`)

function message(look: readonly Look[], problems: readonly string[]): string | null {
  const parts: string[] = []
  for (const kind of ['DEAD_HERE', 'NOT_FOUND', 'AMBIGUOUS'] as const) {
    const xs = look.filter((l) => l.kind === kind)
    if (xs.length) parts.push(`${kind} ${xs.length}: ${xs.slice(0, 10).map((l) => l.checkNumber).join(', ')}`)
  }
  if (problems.length) parts.push(`errors: ${[...new Set(problems)].slice(0, 5).join(' | ')}`)
  return parts.length ? parts.join(' · ').slice(0, 1000) : null
}

export async function runPortalReleasesSync(
  db: PrismaClient,
  args: { reader: PortalReleasesReader; since: Date | null; now: Date; trigger: 'MANUAL' | 'SCHEDULED' },
): Promise<PortalReleasesResult> {
  const since = args.since ?? PORTAL_RELEASES_FIRST_SINCE
  const run = await db.syncRun.create({ data: { mode: PORTAL_RELEASES_MODE, startedAt: args.now, trigger: args.trigger } })
  let read = 0, echo = 0, released = 0, already = 0, errors = 0
  const look: Look[] = []
  const problems: string[] = []
  let maxSeen: Date | null = null

  const finish = (watermark: Date | null) => db.syncRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), imported: released, updated: already, staged: look.length, errors, watermark, message: message(look, problems) },
  })

  let cursor = since
  try {
    for (;;) {
      const page = await args.reader.list(cursor, PAGE)
      for (const r of page.rows) {
        read++
        if (!maxSeen || r.updatedAt > maxSeen) maxSeen = r.updatedAt
        if (r.releasedByService) { echo++; continue }
        try {
          const outcome = await applyOne(db, r)
          if (outcome === 'RELEASED') released++
          else if (outcome === 'ALREADY') already++
          else look.push(outcome)
        } catch (e) {
          errors++
          problems.push(`${r.checkNumber}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
        }
      }
      if (!page.next) break
      cursor = page.next
    }
  } catch (e) {
    errors++
    problems.push(e instanceof Error ? e.message.slice(0, 300) : String(e))
    await finish(null)
    throw e
  }
  const watermark = errors > 0 || !maxSeen ? null : new Date(maxSeen.getTime() - OVERLAP_MS)
  await finish(watermark)
  return { syncRunId: run.id, read, echo, released, already, look, errors, watermark }
}

async function applyOne(db: PrismaClient, r: PortalRelease): Promise<'RELEASED' | 'ALREADY' | Look> {
  const number = canonicalCheckNumber(r.checkNumber) ?? r.checkNumber
  const apvs = new Set(r.apvNumbers)
  const same = await db.check.findMany({
    where: { checkNumber: number },
    select: { id: true, status: true, orNumber: true, apvNumbers: true, bills: { select: { apvNumber: true } } },
  })
  const matched = same.filter((c) => [...c.apvNumbers, ...c.bills.map((b) => b.apvNumber)].some((a) => apvs.has(a.toUpperCase())))
  const base = { checkNumber: number, apvNumbers: r.apvNumbers }
  if (matched.length === 0) return { kind: 'NOT_FOUND', ...base, detail: same.length ? `${same.length} check(s) with this number, none paying ${r.apvNumbers.join(', ')}` : 'no check with this number' }
  if (matched.length > 1) return { kind: 'AMBIGUOUS', ...base, detail: `${matched.length} checks with this number pay these APVs` }
  const c = matched[0]
  if (c.status === 'RELEASED') return 'ALREADY'
  if (!(LIVE as readonly string[]).includes(c.status)) return { kind: 'DEAD_HERE', ...base, detail: `${c.status} here, released on the portal ${r.releaseDate ?? ''}`.trim() }

  const takeReceipt = !c.orNumber && !!r.orNumber
  const done = await db.$transaction(async (tx) => {
    const moved = await tx.check.updateMany({
      where: { id: c.id, status: c.status },
      data: {
        status: 'RELEASED',
        releasedById: null,
        ...(r.releasedAt ? { releasedAt: r.releasedAt } : r.releaseDate ? { statedReleaseDate: dayDate(r.releaseDate) } : {}),
        ...(takeReceipt ? { orNumber: r.orNumber, orDate: r.orDate ? dayDate(r.orDate) : null, receiptType: null } : {}),
      },
    })
    if (!moved.count) return false
    await writeAudit(tx, {
      checkId: c.id, actorType: 'SYSTEM', action: RELEASED_ON_PORTAL_ACTION,
      details: {
        from: c.status, to: 'RELEASED', domain: r.domain, releaseId: r.releaseId, releaseDate: r.releaseDate,
        releasedAt: r.releasedAt?.toISOString() ?? null, orNumber: r.orNumber, orDate: r.orDate,
        receiptTaken: takeReceipt, releasedByName: r.releasedByName,
      },
      remarks: `Released on the Supplier Portal${r.releasedByName ? ` by ${r.releasedByName}` : ''}${r.releaseDate ? ` on ${r.releaseDate}` : ''}. Read back by the PORTAL RELEASES read (rule 5, 2026-10-19).`,
    })
    return true
  }, TX_OPTIONS)
  return done ? 'RELEASED' : 'ALREADY'
}

export type ScheduledPortalReleasesOutcome =
  | { outcome: 'RAN'; syncRunId: string; released: number; already: number; look: number; errors: number }
  | { outcome: 'SKIPPED_NOT_CONFIGURED' }
  | { outcome: 'SKIPPED_TIME_BUDGET' }
  | { outcome: 'FAILED'; message: string }

/** The cron's and SYNC NOW's entry point. Never throws. */
export async function runScheduledPortalReleases(
  db: PrismaClient, args: { now: Date; reader: () => PortalReleasesReader },
): Promise<ScheduledPortalReleasesOutcome> {
  let reader: PortalReleasesReader
  try { reader = args.reader() } catch { return { outcome: 'SKIPPED_NOT_CONFIGURED' } }
  try {
    const since = await lastPortalReleasesWatermark(db)
    const r = await runPortalReleasesSync(db, { reader, since, now: args.now, trigger: 'SCHEDULED' })
    return { outcome: 'RAN', syncRunId: r.syncRunId, released: r.released, already: r.already, look: r.look.length, errors: r.errors }
  } catch (e) {
    return { outcome: 'FAILED', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
  }
}
```

Note on `ALREADY` from a raced update: when the conditional update matches nothing (the status changed between the read and the write), the check is left as it now is and counted as `already`; the next run re-reads it inside the 10-minute overlap.

- [ ] **Step 4: Run — expect PASS**, then `tsc`.

Run: `node node_modules/vitest/vitest.mjs run tests/sync/portal-releases.test.ts tests/sync/modes.test.ts` then `node node_modules/typescript/bin/tsc --noEmit`

- [ ] **Step 5: Confirm no payment reader picks the new mode** — run the files that filter on `NON_PAYMENT_MODES`:

Run: `node node_modules/vitest/vitest.mjs run tests/sync/run.test.ts tests/admin/sync-overview.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/sync/portal-releases.ts tests/sync/portal-releases.test.ts tests/helpers/factory.ts
git commit -m "feat(sync): PORTAL RELEASES read - portal releases become RELEASED here

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4 (Check Monitoring): wire it into the cron and SYNC NOW

**Files:**
- Modify: `app/api/cron/sync/route.ts`
- Modify: `app/admin/actions.ts` (`syncNowAction`)
- Test: `tests/sync/cron-route.test.ts`

**Interfaces:**
- Consumes: `runScheduledPortalReleases`, `ScheduledPortalReleasesOutcome` (Task 3); `createPortalReleasesReaderFromEnv` (Task 2).
- Produces: the cron JSON response gains `portalReleases: ScheduledPortalReleasesOutcome`.

- [ ] **Step 1: Failing test** — in `tests/sync/cron-route.test.ts`, read how it mocks `createClientForTenant` and the portal env first. Add:

```ts
it('runs the PORTAL RELEASES read after BILL_REFS and reports it; unset portal env is SKIPPED_NOT_CONFIGURED', async () => {
  delete process.env.PORTAL_BASE_URL
  delete process.env.PORTAL_TOKEN
  const res = await callCron() // the file's existing helper that GETs the route with the bearer
  const body = await res.json()
  expect(body.portalReleases).toEqual({ outcome: 'SKIPPED_NOT_CONFIGURED' })
})
```

Use the file's actual helper name for calling the route with `CRON_SECRET` (search for `Authorization`/`Bearer` in the file).

- [ ] **Step 2: Run — expect FAIL** (`portalReleases` undefined)

Run: `node node_modules/vitest/vitest.mjs run tests/sync/cron-route.test.ts`

- [ ] **Step 3: Implement** in `app/api/cron/sync/route.ts`:

Imports:

```ts
import { runScheduledPortalReleases, type ScheduledPortalReleasesOutcome } from '@/lib/sync/portal-releases'
import { createPortalReleasesReaderFromEnv } from '@/lib/integrations/portal/from-env'
```

Constant beside `BILL_REFS_SKIP_AFTER_MS`:

```ts
/**
 * The PORTAL RELEASES read (2026-10-19) is not begun once this much of the budget is spent; its
 * watermark stays, so the next run catches up.
 */
const PORTAL_RELEASES_SKIP_AFTER_MS = 25_000
```

After the `billRefs` loop and before `runAutoSign`:

```ts
  // Checks released on the Supplier Portal become RELEASED here (rules 5 and 12, 2026-10-19).
  // Not tenant-bound: one portal. Before auto-sign so a check released on the portal is not
  // signed afterwards. Never throws; unset portal env is a skip.
  const portalReleases: ScheduledPortalReleasesOutcome =
    Date.now() - now.getTime() > PORTAL_RELEASES_SKIP_AFTER_MS
      ? { outcome: 'SKIPPED_TIME_BUDGET' }
      : await runScheduledPortalReleases(prisma, { now, reader: createPortalReleasesReaderFromEnv })
```

Add `portalReleases` to the final JSON object, and to the `failed` expression: `|| portalReleases.outcome === 'FAILED'`.

In `app/admin/actions.ts` `syncNowAction`, after `await runScheduledBillRefsSync(prisma, readOnly)`:

```ts
    // Releases recorded on the Supplier Portal (2026-10-19), so SYNC NOW shows them at once.
    await runScheduledPortalReleases(prisma, { now: new Date(), reader: createPortalReleasesReaderFromEnv })
```

with the two imports at the top of the file.

- [ ] **Step 4: Run — expect PASS**, then `tsc`:

Run: `node node_modules/vitest/vitest.mjs run tests/sync/cron-route.test.ts tests/admin/actions.test.ts` then `node node_modules/typescript/bin/tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/sync/route.ts app/admin/actions.ts tests/sync/cron-route.test.ts
git commit -m "feat(sync): the cron and SYNC NOW read releases back from the Supplier Portal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5 (Check Monitoring): "needing a look" on /admin/portal, and the rules

**Files:**
- Modify: `app/admin/portal/page.tsx`
- Modify: `CLAUDE.md`
- Test: `tests/admin/portal-overview.test.ts` (only if the page's data comes from `lib/admin/portal-overview.ts`; otherwise none — a server page with a direct query is verified by `next build` and the browser)

- [ ] **Step 1: Add the list to `/admin/portal`.** Read `app/admin/portal/page.tsx` first. Below the existing content, add a section that shows the latest finished `PORTAL_RELEASES` run's `message` and time:

```tsx
// In the page's data loading (beside its other queries):
const lastPortalRead = await prisma.syncRun.findFirst({
  where: { mode: PORTAL_RELEASES_MODE, finishedAt: { not: null } },
  orderBy: { startedAt: 'desc' },
  select: { startedAt: true, imported: true, updated: true, staged: true, errors: true, message: true },
})

// In the JSX, as its own section:
<section className="rounded-2xl bg-white p-4 ring-1 ring-hairline">
  <h2 className="text-sm font-semibold tracking-wide text-slate-900">RELEASES READ FROM THE SUPPLIER PORTAL</h2>
  {lastPortalRead ? (
    <div className="mt-2 space-y-1 text-sm text-slate-700">
      <p>Last read {fmtDateTime(lastPortalRead.startedAt)}: {lastPortalRead.imported} released here, {lastPortalRead.updated} already released, {lastPortalRead.errors} error(s).</p>
      <p className={lastPortalRead.staged > 0 ? 'font-semibold text-warning-ink' : 'text-slate-500'}>
        {lastPortalRead.staged > 0 ? `NEEDING A LOOK (${lastPortalRead.staged}): ${lastPortalRead.message ?? ''}` : 'Nothing needing a look.'}
      </p>
      <p className="text-xs text-slate-500">DEAD_HERE: released on the portal but CANCELLED or VOIDED here. NOT_FOUND: no check here with that number and APV. AMBIGUOUS: more than one.</p>
    </div>
  ) : <p className="mt-2 text-sm text-slate-500">Not read yet.</p>}
</section>
```

Import `PORTAL_RELEASES_MODE` from `@/lib/sync/modes`, and use the page's existing date-time formatter (search the page or `lib/` for `fmtDateTime`; if the page has none, import the one `app/admin/sync/page.tsx` uses).

- [ ] **Step 2: Rewrite rules 5 and 12 in `CLAUDE.md`.** Replace the rule 5 line with:

```markdown
5. **A check is released where it is handed over** (rewritten 2026-10-19, spec
   `2026-10-19-portal-releases-read-back-design.md`): on the Supplier Portal, read back here by the
   PORTAL RELEASES read (`lib/sync/portal-releases.ts`); or, as a backup, by Finance in this app. The
   portal's release is the record. A portal release moves only a live check (GENERATED through
   SCHEDULED) to RELEASED; a CANCELLED or VOIDED check is listed on `/admin/portal`, never released.
```

Replace rule 12 with:

```markdown
12. **The portal client sends events; the PORTAL RELEASES read is the one thing read back**
   (rewritten 2026-10-19). `lib/integrations/portal/client.ts` keeps its one sending method; the
   reader is `lib/integrations/portal/releases.ts` (GET only). It only ever moves a live check to
   RELEASED — never cancels, voids, un-releases or edits anything else — and writes no outbox event
   (no echo); rows this app itself sent (`releasedByService`) are skipped.
```

Add one paragraph under "Things that will catch you out":

```markdown
**Releases are recorded on the Supplier Portal since 2026-10-19** (user decision). The PORTAL
RELEASES read (`SyncRun.mode = 'PORTAL_RELEASES'`, its own watermark, first read from 2026-10-19
Manila) runs in the 12:00 and 18:00 cron after BILL_REFS and on SYNC NOW. It matches on canonical
check number AND a shared APV (numbers are reused, 1791379613), writes `releasedAt` (the portal's
hand-over instant) or `statedReleaseDate` (its day), takes the portal's OR only when the check has
no receipt yet (rule 11), and queues nothing for the portal. The register file is no longer a source
of releases. Deploy order: the portal's `/api/integrations/check-monitoring/releases` first.
```

- [ ] **Step 3: `tsc` and `next build`**

Run: `node node_modules/typescript/bin/tsc --noEmit` then `node node_modules/next/dist/bin/next build`
Expected: clean; `/admin/portal` builds.

- [ ] **Step 4: Commit**

```bash
git add app/admin/portal/page.tsx CLAUDE.md
git commit -m "feat(admin): portal releases needing a look; rules 5 and 12 rewritten

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: verify end to end, hand over

- [ ] **Step 1: Run every touched test file in Check Monitoring**

```bash
node node_modules/prisma/build/index.js generate
node node_modules/vitest/vitest.mjs run tests/integrations/portal-releases.test.ts tests/sync/portal-releases.test.ts tests/sync/modes.test.ts tests/sync/cron-route.test.ts tests/sync/run.test.ts tests/admin/sync-overview.test.ts tests/admin/actions.test.ts tests/sync/portal-outbox.test.ts
```

Expected: all PASS. (`portal-outbox` is included to prove no outbox behaviour changed.)

- [ ] **Step 2: End-to-end on TEST with a stub portal.** Start a tiny local stub that answers `GET /api/integrations/check-monitoring/releases` with one row for a check seeded on the TEST database (SIGNED, number + APV), point `scripts/dev-test-db.mjs`'s environment at it (`PORTAL_BASE_URL=http://127.0.0.1:<port>`, `PORTAL_TOKEN=x` — the dev script blanks these, so set them for this check only by a one-off copy of the script in `.superpowers/`), press SYNC NOW on `/admin/sync`, and confirm: the check is RELEASED with the stub's date and OR, `/admin/portal` shows the read, and no PortalEvent was created. Never against production.

- [ ] **Step 3: Push the branch; hand over the release order to the user**

```bash
git push -u origin feature/portal-releases
```

Tell the user, in order:
1. Merge and deploy the **Supplier Portal** branch `feature/cm-releases-endpoint` first (its own deploy steps).
2. Then push `feature/portal-releases` to Check Monitoring's master and deploy from a clean master worktree (no migration: `SyncRun.mode` is a string).
3. After the first 12:00 or 18:00 run (or SYNC NOW), `/admin/portal` shows "RELEASES READ FROM THE SUPPLIER PORTAL".
