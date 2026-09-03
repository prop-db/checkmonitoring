import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import {
  runSync, lastSyncWatermark, SYNC_OVERLAP_MINUTES,
} from '@/lib/sync/run'
import {
  PAYMENTS_FEED, PAYMENT_FIELDS,
  type AcumaticaClient, type AcumaticaRow, type FetchAllOptions, type PageOptions,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-09-04T13:32:00+08:00')

beforeEach(resetDb)

// Plan 2 writes no PortalEvent anywhere, and the sync is the path most likely to
// grow one by accident: it runs unattended, on a schedule, over every payment in
// the ERP. Publishing to a supplier is a Finance action, never a consequence of a
// sync running, so this is asserted after EVERY test in the file rather than in
// one test a later author could forget to extend.
afterEach(async () => {
  expect(await testDb.portalEvent.count()).toBe(0)
})

// ---------------------------------------------------------------------------
// A feed that never touches the network.
// ---------------------------------------------------------------------------

type FeedCall = { feed: string; opts: FetchAllOptions | undefined }

/**
 * Honours `$filter` rather than ignoring it. That is the whole point: the
 * watermark tests below are only meaningful if narrowing the window actually
 * hides rows, so removing the 120-minute overlap makes a row genuinely
 * unreachable instead of merely changing a recorded number.
 *
 * Comparison is lexicographic on Acumatica's own naive `YYYY-MM-DDTHH:MM:SS`
 * strings, which sort chronologically — the same property `map.ts` relies on
 * when it round-trips the watermark back into a literal.
 */
function fakeFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: FeedCall[] = []

  function applyFilter(filter: string | undefined): AcumaticaRow[] {
    if (!filter) return [...rows]
    const m = /^LastModifiedOn ge datetime'(.+)'$/.exec(filter)
    if (!m) throw new Error(`the fake feed does not understand the filter ${filter}`)
    const since = m[1]
    return rows.filter((r) => String(r.LastModifiedOn ?? '') >= since)
  }

  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      return applyFilter(opts?.filter)
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('runSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/**
 * One raw row of the `AP-Checks and Payments` generic inquiry, in the shapes the
 * live instance actually returns (measured 2026-09-04 over 400 rows):
 * `PaymentAmount`, `PaymentDate` and `LastModifiedOn` are STRINGS, and `Branch`
 * is space-padded. The padding is load-bearing in this fixture — it is the only
 * thing proving company resolution still works through `orNull`'s trim.
 *
 * Overrides are keyed to `PAYMENT_FIELDS`, so a misspelt field name is a compile
 * error rather than a silently ignored key.
 */
type PaymentField = (typeof PAYMENT_FIELDS)[number]
function feedRow(overrides: Partial<Record<PaymentField, unknown>> = {}): AcumaticaRow {
  return {
    Type: 'Payment',
    ReferenceNbr: 'CV-ST-004112',
    Vendor: 'V0001',
    VendorName: 'HENKEL PHILIPPINES INC.',
    Status: 'Balanced',
    PaymentDate: '2026-01-19T00:00:00',
    Description: 'PAYMENT FOR JAN BILLING',
    PaymentRef: '6000319079',
    PaymentAmount: '197715.42',
    Balance: '0.00',
    Currency: 'PHP',
    CashAccount: 'BPI STK',
    PaymentMethod: 'CHECK',
    Branch: 'ST        ',
    LastModifiedOn: '2026-09-04T10:00:00',
    ...overrides,
  }
}

async function seedCompany(code: string, name: string) {
  return testDb.company.create({
    data: { code, name, legalNames: [name.toUpperCase()] },
  })
}

/** Go-Live `ST` is Starkson Packaging; MANUFACTURING `ST` is Starkson Paper and Plastic. */
async function seedBothTenantsST() {
  await seedCompany('STK', 'Starkson Packaging Inc.')
  await seedCompany('STPP', 'Starkson Paper and Plastic Inc.')
}

const sync = (
  rows: readonly AcumaticaRow[],
  opts: { tenant?: 'GOLIVE' | 'MANUFACTURING'; since?: Date | null; now?: Date } = {},
) => {
  const { client, calls } = fakeFeed(rows)
  return {
    calls,
    result: runSync(testDb, {
      client,
      tenant: opts.tenant ?? 'GOLIVE',
      since: opts.since ?? null,
      now: opts.now ?? NOW,
    }),
  }
}

// ---------------------------------------------------------------------------

describe('runSync — the run record', () => {
  it('records a SyncRun with imported, updated, errors and finishedAt', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()]).result

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.imported).toBe(1)
    expect(run.updated).toBe(0)
    expect(run.errors).toBe(0)
    expect(run.finishedAt).not.toBeNull()
    expect(run.startedAt).toEqual(NOW)
  })

  it('records which tenant it ran against, because branch codes mean different companies in each', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()], { tenant: 'MANUFACTURING' }).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.tenant).toBe('MANUFACTURING')
  })

  it('counts a re-read of the same payment as updated, not imported', async () => {
    await seedBothTenantsST()
    await sync([feedRow()]).result
    const second = await sync([feedRow({ PaymentAmount: '197715.43' })]).result

    expect(second.imported).toBe(0)
    expect(second.updated).toBe(1)
    // Duplicate prevention lives in upsertCheck and nowhere else; the sync adds
    // no second dedup path, so one cheque is still one row.
    expect(await testDb.check.count()).toBe(1)
  })

  it('calls the payments feed by name, asking only for the fields it publishes', async () => {
    await seedBothTenantsST()
    const run = sync([feedRow()])
    await run.result
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0].feed).toBe(PAYMENTS_FEED)
    expect(run.calls[0].opts?.select).toEqual(PAYMENT_FIELDS)
    // `fetchAll` pages with `$skip`, and `$skip` over an unordered result set can
    // shift a row between pages and lose it entirely. The order is the guarantee
    // that paging sees every row once.
    expect(run.calls[0].opts?.orderby).toBe('LastModifiedOn asc')
  })

  it('records the mode: FULL with no watermark to start from, INCREMENTAL with one', async () => {
    await seedBothTenantsST()
    const full = await sync([feedRow()], { since: null }).result
    expect(full.mode).toBe('FULL')

    const incremental = await sync([feedRow()], { since: new Date('2026-09-01T00:00:00Z') }).result
    expect(incremental.mode).toBe('INCREMENTAL')

    const modes = await testDb.syncRun.findMany({ orderBy: { id: 'asc' }, select: { mode: true } })
    expect(modes.map((m) => m.mode).sort()).toEqual(['FULL', 'INCREMENTAL'])
  })

  it('accounts for every row the feed returned', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow(),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-ST-004113' }),
      // Not a cheque document. Skipped, not an error.
      feedRow({ Type: 'Debit Adj.', PaymentRef: '6000319081' }),
      // No cheque number at all: unwritable and unstageable, because an
      // Acumatica row carries no sheet or row number to key a staged row on.
      feedRow({ PaymentRef: '' }),
    ]).result

    expect(result.fetched).toBe(4)
    expect(result.skipped).toBe(1)
    expect(result.imported).toBe(2)
    expect(result.updated).toBe(0)
    expect(result.errors).toBe(1)
    // The invariant that makes "nothing is silently dropped" checkable.
    expect(result.skipped + result.imported + result.updated + result.errors).toBe(result.fetched)
  })
})

describe('runSync — the incremental window', () => {
  it("asks Acumatica for rows since the watermark, in the literal form it accepts", async () => {
    await seedBothTenantsST()
    const run = sync([feedRow()], { since: new Date('2026-09-03T20:00:00Z') })
    await run.result

    // Measured against the live instance, 2026-09-04: this OData v3 literal is
    // the ONLY accepted form. A bare `2026-09-03T20:00:00`, a trailing `Z` and
    // `datetimeoffset'...'` each returned HTTP 500.
    expect(run.calls[0].opts?.filter).toBe("LastModifiedOn ge datetime'2026-09-03T20:00:00'")
  })

  it('asks for no filter at all on a full run', async () => {
    await seedBothTenantsST()
    const run = sync([feedRow()], { since: null })
    await run.result
    expect(run.calls[0].opts?.filter).toBeUndefined()
  })

  it('the overlap is 120 minutes', () => {
    expect(SYNC_OVERLAP_MINUTES).toBe(120)
  })

  it('sets the watermark to the maximum LastModifiedOn seen MINUS the overlap', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow({ PaymentRef: '6000319079', LastModifiedOn: '2026-09-04T09:30:00' }),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-2', LastModifiedOn: '2026-09-04T10:00:00' }),
    ]).result

    expect(result.watermark).toEqual(new Date('2026-09-04T08:00:00Z'))
    // Stated separately and deliberately: the maximum itself is the wrong
    // answer, and a change that drops the overlap must fail here.
    expect(result.watermark).not.toEqual(new Date('2026-09-04T10:00:00Z'))

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.watermark).toEqual(new Date('2026-09-04T08:00:00Z'))
  })

  it('picks up a row committed DURING the previous run, which the overlap exists for', async () => {
    await seedBothTenantsST()

    // Run one observes a maximum of 10:00. A row was committed while it was
    // running and carries 09:00 — below that maximum, and never returned to
    // run one because it was not committed when the feed was read.
    const first = await sync([
      feedRow({ PaymentRef: '6000319079', LastModifiedOn: '2026-09-04T09:30:00' }),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-2', LastModifiedOn: '2026-09-04T10:00:00' }),
    ]).result

    const lateRow = feedRow({
      PaymentRef: '6000319081', ReferenceNbr: 'CV-3', LastModifiedOn: '2026-09-04T09:00:00',
    })

    // The fake feed honours the filter, so if the watermark were the bare
    // maximum the late row would simply not come back and this run would import
    // nothing. That row is a real payment; losing it is losing money.
    const second = await sync([lateRow], { since: first.watermark }).result
    expect(second.imported).toBe(1)
    expect(await testDb.check.findFirst({ where: { checkNumber: '6000319081' } })).not.toBeNull()
  })

  it('leaves the previous watermark standing when it took responsibility for no rows', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow({ Type: 'Debit Adj.' })]).result
    expect(result.watermark).toBeNull()

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.watermark).toBeNull()
  })

  it('reads back the last watermark for a tenant, and never the other tenant’s', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ LastModifiedOn: '2026-09-04T10:00:00' })], { tenant: 'GOLIVE' }).result
    await sync([feedRow({ LastModifiedOn: '2026-09-04T18:00:00' })], { tenant: 'MANUFACTURING' }).result

    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-04T08:00:00Z'))
    expect(await lastSyncWatermark(testDb, 'MANUFACTURING')).toEqual(new Date('2026-09-04T16:00:00Z'))
    // Nothing has ever run for a tenant with no runs.
    await testDb.syncRun.deleteMany({ where: { tenant: 'GOLIVE' } })
    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toBeNull()
  })
})

describe('runSync — one bad row must not cost a 37,000-row sync', () => {
  it('counts a row it cannot write as an error and carries on', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow({ PaymentRef: '6000319079' }),
      // Unstageable: no cheque number, and no sheet or row to stage it under.
      feedRow({ PaymentRef: '   ' }),
      // An unrecognised branch resolves no company, and is equally unstageable.
      feedRow({ PaymentRef: '6000319081', ReferenceNbr: 'CV-3', Branch: 'NOT-A-BRANCH' }),
      feedRow({ PaymentRef: '6000319082', ReferenceNbr: 'CV-4' }),
    ]).result

    expect(result.errors).toBe(2)
    expect(result.imported).toBe(2)
    // The rows AFTER the bad ones are what matters: an abort would lose them.
    expect(await testDb.check.findFirst({ where: { checkNumber: '6000319082' } })).not.toBeNull()
  })

  it('records a run with errors as finished, and says what went wrong without naming a payee', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow({ PaymentRef: '' })]).result

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.errors).toBe(1)
    expect(run.finishedAt).not.toBeNull()
    expect(run.message).toBeTruthy()
    // An error message ends up in a SyncRun row and in logs, so it must be safe
    // to paste into a ticket. Vendor names and amounts are not.
    expect(run.message).not.toContain('HENKEL')
    expect(run.message).not.toContain('197715.42')
  })

  it('does not treat a document type it declines to import as an error', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow({ Type: 'Debit Adj.' }),
      feedRow({ Type: 'Prepayment', PaymentRef: '6000319080' }),
      feedRow({ Type: 'Refund', PaymentRef: '6000319081' }),
    ]).result

    expect(result.skipped).toBe(3)
    expect(result.errors).toBe(0)
    expect(result.imported).toBe(0)
    expect(await testDb.check.count()).toBe(0)
  })

  it('raises a company code that no Company row carries, rather than burying it', async () => {
    // STK is deliberately not seeded: a branch that maps to a code with no
    // Company row is a seeding fault, not a fact about the cheque.
    const result = await sync([feedRow()]).result
    expect(result.errors).toBe(1)
    expect(result.imported).toBe(0)
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('STK')
  })
})

describe('runSync — a run that fails outright', () => {
  it('still writes a SyncRun with finishedAt set, so a hung sync is distinguishable', async () => {
    await seedBothTenantsST()
    const { client } = fakeFeed([], new Error('OData AP-Checks and Payments returned 500'))

    await expect(
      runSync(testDb, { client, tenant: 'GOLIVE', since: null, now: NOW }),
    ).rejects.toThrow('returned 500')

    const run = await testDb.syncRun.findFirstOrThrow()
    expect(run.finishedAt).not.toBeNull()
    expect(run.tenant).toBe('GOLIVE')
    expect(run.errors).toBe(1)
    expect(run.message).toContain('returned 500')
    // A failed run must not move the watermark forward over rows it never read.
    expect(run.watermark).toBeNull()
  })
})

describe('runSync — two tenants, never inferred', () => {
  it('files the same branch code under a different company in each tenant', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ PaymentRef: '6000319079' })], { tenant: 'GOLIVE' }).result
    await sync([feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-2' })], { tenant: 'MANUFACTURING' }).result

    const golive = await testDb.check.findFirstOrThrow({
      where: { checkNumber: '6000319079' }, include: { company: true },
    })
    const mfg = await testDb.check.findFirstOrThrow({
      where: { checkNumber: '6000319080' }, include: { company: true },
    })
    expect(golive.company.code).toBe('STK')
    expect(mfg.company.code).toBe('STPP')
    expect(golive.acumaticaTenant).toBe('GOLIVE')
    expect(mfg.acumaticaTenant).toBe('MANUFACTURING')
  })
})

describe('runSync — promoting staged rows', () => {
  async function stage(overrides: {
    reason: 'NO_COMPANY' | 'AMBIGUOUS_COMPANY' | 'NO_CHECK_NUMBER'
    checkNumber: string | null
    sourceRow: number
    companyCode?: string | null
    conflictingCompanies?: string[]
  }) {
    return testDb.stagedCheck.create({
      data: {
        sourceSheet: 'BPI RELEASED',
        sourceRow: overrides.sourceRow,
        reason: overrides.reason,
        checkNumber: overrides.checkNumber,
        companyCode: overrides.companyCode ?? null,
        conflictingCompanies: overrides.conflictingCompanies ?? [],
        impliedStatus: 'RELEASED',
        amount: '197715.42',
        payeeName: 'HENKEL PHILIPPINES INC.',
      },
    })
  }

  it('promotes a NO_COMPANY row once the sync supplies a company for its cheque number', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })

    const result = await sync([feedRow({ PaymentRef: '6000319079' })]).result
    expect(result.promoted).toBe(1)

    const check = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000319079' } })
    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).toBe(check.id)
    // The staging record is the evidence of WHY the cheque was held. Promoting
    // it links it; it never deletes it.
    expect(await testDb.stagedCheck.count()).toBe(1)
    expect(after.reason).toBe('NO_COMPANY')
  })

  it('links to the cheque of the company the sync supplied, never a sibling company’s same number', async () => {
    await seedBothTenantsST()
    const stpp = await testDb.company.findUniqueOrThrow({ where: { code: 'STPP' } })
    // A cheque number is unique only PER COMPANY. Starkson Paper and Plastic
    // already holds 6000319079; matching the staged row on the number alone
    // would file the register's evidence against the wrong legal entity.
    const sibling = await testDb.check.create({
      data: { companyId: stpp.id, checkNumber: '6000319079', status: 'RELEASED', eligibility: 'SUPPLIER' },
    })
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })

    await sync([feedRow({ PaymentRef: '6000319079' })], { tenant: 'GOLIVE' }).result

    const stk = await testDb.company.findUniqueOrThrow({ where: { code: 'STK' } })
    const goliveCheck = await testDb.check.findUniqueOrThrow({
      where: { companyId_checkNumber: { companyId: stk.id, checkNumber: '6000319079' } },
    })
    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).toBe(goliveCheck.id)
    expect(after.promotedCheckId).not.toBe(sibling.id)
  })

  it('leaves AMBIGUOUS_COMPANY rows untouched — Finance ruled a human settles those', async () => {
    await seedBothTenantsST()
    // 61 rows across 27 cheque numbers, of which 25 are one physical cheque
    // entered twice. Acumatica supplying a company does not say which of the
    // duplicated register rows was right, so promoting one would resolve by
    // accident a question Finance asked to decide (ruling of 2026-09-03).
    const ambiguous = await stage({
      reason: 'AMBIGUOUS_COMPANY', checkNumber: '6000319079', sourceRow: 412,
      companyCode: 'STPP', conflictingCompanies: ['STK', 'STPP'],
    })
    const sibling = await stage({
      reason: 'AMBIGUOUS_COMPANY', checkNumber: '6000319079', sourceRow: 998,
      companyCode: 'STK', conflictingCompanies: ['STK', 'STPP'],
    })

    const result = await sync([feedRow({ PaymentRef: '6000319079' })]).result
    expect(result.promoted).toBe(0)

    for (const id of [ambiguous.id, sibling.id]) {
      const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id } })
      expect(after.promotedCheckId).toBeNull()
    }
  })

  it('leaves a NO_CHECK_NUMBER row untouched, having nothing to match it on', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_CHECK_NUMBER', checkNumber: null, sourceRow: 412 })
    const result = await sync([feedRow()]).result

    expect(result.promoted).toBe(0)
    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).toBeNull()
  })

  it('promotes once — a second sync over the same cheque re-promotes nothing', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })

    const first = await sync([feedRow()]).result
    const second = await sync([feedRow()]).result

    expect(first.promoted).toBe(1)
    expect(second.promoted).toBe(0)

    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).not.toBeNull()
    const audits = await testDb.auditLog.count({ where: { action: 'staged_row_promoted' } })
    expect(audits).toBe(1)
  })

  it('records the promotion against the cheque, so the link is traceable', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })
    await sync([feedRow()]).result

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'staged_row_promoted' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
    expect(audit.details).toMatchObject({
      stagedCheckId: staged.id, sourceSheet: 'BPI RELEASED', sourceRow: 412, reason: 'NO_COMPANY',
    })
  })
})
