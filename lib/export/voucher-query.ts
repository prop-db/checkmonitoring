import type { CheckStatus, Prisma, PrismaClient } from '@prisma/client'
import type { CheckCandidate, StagedCandidate, VoucherIndexInput } from './voucher-index'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The two reads behind the voucher index. READ ONLY, and it resolves nothing —
 * every decision about which cheque answers a voucher lives in
 * `voucher-index.ts`, where it can be tested without a database.
 *
 * Raw SQL rather than Prisma's query API because the grain is one row per
 * ELEMENT of `Check.apvNumbers`, and `unnest` is the only way to say that.
 */

/** `status` arrives as text from the cast; widened back on the way out. */
type RawCheckCandidate = Omit<CheckCandidate, 'status'> & { status: string }

export async function listVoucherCandidates(db: Db): Promise<VoucherIndexInput> {
  const [checks, staged] = await Promise.all([
    /**
     * `isIncomplete = false` — the 129 cheques with no recorded amount are out,
     * consistent with the dashboard, the export and the printed sheet (client
     * ruling 2026-09-06). This sheet carries no amount, so the usual argument
     * for the exclusion does not apply here; one rule across every output does,
     * and the measured cost is 17 vouchers.
     *
     * The bank falls back from the checkbook to the cash account because 9,072
     * cheques carry a checkbook and only 1,342 carry a cash account. Null when
     * neither is known — an empty cell, never a guessed bank.
     */
    db.$queryRaw<RawCheckCandidate[]>`
      select v.voucher                                  as "voucher",
             c."checkNumber"                            as "checkNumber",
             c.status::text                             as "status",
             b.code                                     as "bank",
             co.code                                     as "company",
             c."checkDate"                              as "checkDate",
             coalesce(c."payeeName", ve."canonicalName") as "payee",
             c."releasedAt"                              as "releasedAt"
        from "Check" c
        cross join lateral unnest(c."apvNumbers") as v(voucher)
        join "Company" co on co.id = c."companyId"
        left join "CheckBook" cb on cb.id = c."checkBookId"
        left join "CashAccount" ca on ca.id = c."cashAccountId"
        left join "Bank" b on b.id = coalesce(cb."bankId", ca."bankId")
        left join "Vendor" ve on ve.id = c."vendorId"
       where c."isIncomplete" = false`,
    /**
     * `distinct` because one voucher can appear on several staged rows of the
     * same import, and the resolver groups them anyway.
     */
    db.$queryRaw<StagedCandidate[]>`
      select distinct
             v.voucher          as "voucher",
             s."sourceSheet"    as "sourceSheet",
             s."sourceRow"      as "sourceRow",
             s."statedCheckRef" as "statedCheckRef",
             s."checkNumber"    as "checkNumber",
             s."acumaticaRef"   as "acumaticaRef"
        from "StagedCheck" s
        cross join lateral unnest(s."apvNumbers") as v(voucher)`,
  ])

  return {
    checks: checks.map((c) => ({ ...c, status: c.status as CheckStatus })),
    staged,
  }
}
