# Revert to SIGNED from the list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A REVERT TO SIGNED button in the dashboard's tick-box bar, open to every Finance user, plus the single-cheque button opened to every Finance user.

**Architecture:** A new server action `bulkRevertToSignedAction` in `app/checks/bulk-actions.ts` runs the existing domain function `revertAvailability` once per ticked cheque through `runEach`. A pure helper `revertableIds` picks the READY_FOR_RELEASE/SCHEDULED rows for the button. `revertAction` loses its FINANCE_ADMIN guard and the cheque page stops gating the form on role.

**Tech Stack:** Next.js 15 server actions, Prisma 6, Vitest (database tests hit the TEST Neon DB), TypeScript strict.

## Global Constraints

- Every Finance user (FINANCE_USER and FINANCE_ADMIN) may revert. RELEASE, reverse release and delete-incomplete stay FINANCE_ADMIN.
- Reason is required; a blank one is refused once, before anything is written.
- Only READY_FOR_RELEASE and SCHEDULED cheques are sent.
- The selection cap is `settings.values['caps.bulkSelection']` via `parseSelection`.
- No new write path: status changes only through `revertAvailability` in `lib/domain/actions.ts`.
- Run database tests one file at a time (shared TEST DB); `node node_modules/vitest/vitest.mjs run <file>`.
- `node node_modules/typescript/bin/tsc --noEmit` before claiming done.

---

### Task 1: `bulkRevertToSignedAction`

**Files:**
- Modify: `app/checks/bulk-actions.ts` (import `revertAvailability`; add the action after `bulkReadyForReleaseAction`)
- Test: `tests/actions/bulk-actions.test.ts` (new `describe` block at the end)

**Interfaces:**
- Consumes: `revertAvailability(db, { checkId, userId, reason, now }): Promise<Check>`; `runEach`; `parseSelection`.
- Produces: `bulkRevertToSignedAction(formData: FormData): Promise<BulkActionResult>` reading `checkId` (repeated) and `reason`.

- [ ] **Step 1: Write the failing tests** — append to `tests/actions/bulk-actions.test.ts`:

```ts
describe('bulkRevertToSignedAction', () => {
  it('lets a Finance user revert ready and scheduled cheques, with the reason on each audit row', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE', availablePickupDate: new Date('2026-09-26') })
    const b = await makeCheck({ status: 'SCHEDULED' })

    const result = await bulkRevertToSignedAction(fd([a.id, b.id], { reason: 'Pulled from the list' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    for (const id of [a.id, b.id]) {
      const after = await testDb.check.findUniqueOrThrow({ where: { id } })
      expect(after.status).toBe('SIGNED')
      expect(after.availablePickupDate).toBeNull()
      const audit = await testDb.auditLog.findMany({ where: { checkId: id, action: 'reverted_availability' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ userId: currentUser.id, remarks: 'Pulled from the list' })
    }
  })

  it('refuses a blank reason and writes nothing', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkRevertToSignedAction(fd([a.id], { reason: '   ' }))

    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: 'reverted_availability' } })).toBe(0)
  })

  it('reports a cheque that has moved on and still reverts the rest', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const released = await makeCheck({ status: 'RELEASED' })

    const result = await bulkRevertToSignedAction(fd([ready.id, released.id], { reason: 'x' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(outcomeFor(result, ready.id).ok).toBe(true)
    expect(outcomeFor(result, released.id).ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: released.id } })).status).toBe('RELEASED')
  })

  it('holds the bulk cap', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const tooMany = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `id-${i}`)
    const result = await bulkRevertToSignedAction(fd(tooMany, { reason: 'x' }))
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts -t bulkRevertToSignedAction`
Expected: FAIL — `bulkRevertToSignedAction is not a function`.

- [ ] **Step 3: Implement** — in `app/checks/bulk-actions.ts`, change the domain import to
`import { markSigned, markReadyForRelease, markReleased, recordReceipt, revertAvailability } from '@/lib/domain/actions'`
and add after `bulkReadyForReleaseAction`:

```ts
/**
 * READY FOR RELEASE (or SCHEDULED) back to SIGNED, from the list. Open to every
 * Finance user (client ruling 2026-09-26), like the single-cheque button.
 * `revertAvailability` does the work per cheque: the transition check, the
 * cleared pickup, the portal REVERT event and the audit row carrying the reason.
 * The reason is one field for the batch, so a blank one is refused here once.
 */
export async function bulkRevertToSignedAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const reason = str(formData, 'reason')
  if (!reason) return { ok: false, message: 'Enter a reason before reverting cheques to SIGNED.' }

  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    revertAvailability(prisma, { checkId, userId: user.id, reason, now }))
}
```

- [ ] **Step 4: Run to verify pass** — same command. Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add app/checks/bulk-actions.ts tests/actions/bulk-actions.test.ts
git commit -m "feat: bulk revert to SIGNED, open to every Finance user"
```

### Task 2: Open the single-cheque revert to every Finance user

**Files:**
- Modify: `app/checks/actions.ts:61-71` (`revertAction`)
- Modify: `app/checks/[id]/page.tsx:302-315` (comment and condition)
- Test: `tests/actions/server-actions.test.ts` (`describe('revertAction')`)

**Interfaces:** Consumes/produces nothing new; `revertAction(formData): Promise<ActionResult>` keeps its signature.

- [ ] **Step 1: Write the failing test** — add inside `describe('revertAction', …)`:

```ts
  it('lets a Finance user revert a ready cheque', async () => {
    const { readyForReleaseAction, revertAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await revertAction(fd({ checkId: check.id, reason: 'Pulled from the list' }))
    expect(result).toEqual({ ok: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('SIGNED')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/server-actions.test.ts -t revertAction`
Expected: FAIL — `ok: false, message: 'Only a Finance Admin can revert…'`.

- [ ] **Step 3: Implement** — replace `revertAction` with:

```ts
export async function revertAction(formData: FormData): Promise<ActionResult> {
  // Every Finance user since 2026-09-26 (client ruling), matching the list's
  // REVERT TO SIGNED. The reason stays mandatory — the domain refuses a blank one.
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => revertAvailability(prisma, {
    checkId, userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}
```

In `app/checks/[id]/page.tsx`, change the condition
`{(check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') &&\n          user.role === 'FINANCE_ADMIN' && (`
to `{(check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') && (`, and replace the comment's
"FINANCE_ADMIN only, matching `revertAction`'s own guard: …hidden for everyone else rather than shown and refused, but the server check is what actually enforces it." sentence with
"Every Finance user since 2026-09-26 (client ruling), the same as the list's bulk REVERT TO SIGNED."

- [ ] **Step 4: Run to verify pass** — same command. Expected: both `revertAction` tests pass. Then `node node_modules/typescript/bin/tsc --noEmit` — clean (a now-unused `user` in the page is still used elsewhere; if tsc reports it unused, keep it only where referenced).

- [ ] **Step 5: Commit**

```bash
git add app/checks/actions.ts "app/checks/[id]/page.tsx" tests/actions/server-actions.test.ts
git commit -m "feat: single-cheque revert to SIGNED open to every Finance user"
```

### Task 3: The button in the tick-box bar

**Files:**
- Modify: `lib/row-receipts.ts` (add `revertableIds` after `releasedIds`)
- Modify: `components/BulkActionBar.tsx` (import, state, button)
- Test: `tests/row-receipts.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `bulkRevertToSignedAction` (Task 1), `RowFacts`.
- Produces: `revertableIds(rows: readonly RowFacts[]): string[]`.

- [ ] **Step 1: Write the failing test** — append to `tests/row-receipts.test.ts`:

```ts
describe('revertableIds', () => {
  it('keeps only READY_FOR_RELEASE and SCHEDULED rows', () => {
    const row = (id: string, status: RowFacts['status']): RowFacts => ({ id, isCheque: true, status, hasReceipt: false })
    expect(revertableIds([
      row('a', 'READY_FOR_RELEASE'), row('b', 'SCHEDULED'), row('c', 'SIGNED'), row('d', 'RELEASED'),
    ])).toEqual(['a', 'b'])
  })
})
```

(add `revertableIds` and `type RowFacts` to that file's import from `@/lib/row-receipts` if not already imported).

- [ ] **Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/row-receipts.test.ts`
Expected: FAIL — `revertableIds is not a function`.

- [ ] **Step 3: Implement** — in `lib/row-receipts.ts` after `releasedIds`:

```ts
/** The ticked rows REVERT TO SIGNED acts on: on the release list, not yet handed over. */
export function revertableIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => r.status === 'READY_FOR_RELEASE' || r.status === 'SCHEDULED').map((r) => r.id)
}
```

In `components/BulkActionBar.tsx`: add `bulkRevertToSignedAction` to the `@/app/checks/bulk-actions` import and `revertableIds` to the `@/lib/row-receipts` import; add `const [revertReason, setRevertReason] = useState('')` beside `pickupDate`; add `const revertable = revertableIds(selectedRows)` beside `released`; and insert before the `{canRelease && (` RELEASE button:

```tsx
        {revertable.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 ring-1 ring-slate-300">
            <label htmlFor="bulk-revert-reason" className="text-xs font-medium tracking-wide text-slate-600">
              REASON
            </label>
            <input
              id="bulk-revert-reason" type="text" value={revertReason}
              onChange={(e) => setRevertReason(e.target.value)}
              placeholder="Pulled from the release list"
              className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              type="button" disabled={disabled || revertReason.trim() === ''}
              onClick={() => {
                if (!confirm(`Revert ${revertable.length} cheque(s) to SIGNED? They come off the release list.`)) return
                submit(bulkRevertToSignedAction, revertable, [['reason', revertReason.trim()]])
                setRevertReason('')
              }}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              REVERT TO SIGNED ({revertable.length})
            </button>
          </div>
        )}
```

- [ ] **Step 4: Verify** — `node node_modules/vitest/vitest.mjs run tests/row-receipts.test.ts` passes; `node node_modules/typescript/bin/tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add lib/row-receipts.ts components/BulkActionBar.tsx tests/row-receipts.test.ts
git commit -m "feat: REVERT TO SIGNED button on the list"
```
