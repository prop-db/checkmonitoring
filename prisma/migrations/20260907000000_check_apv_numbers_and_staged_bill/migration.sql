-- The AP vouchers the register has been carrying all along, and a place to put
-- the rows the approval-for-release workbook refuses.
--
-- WHY `Check` GAINS A COLUMN RATHER THAN `CheckBill` GAINING ROWS.
-- The register's grain is one row per CHEQUE and the amount on that row is the
-- CHEQUE's amount. `CheckBill.amount` is NOT NULL and means one BILL's amount,
-- and a cheque settling several bills has one register row -- so there is no
-- honest way to split it. Inventing a per-bill figure to satisfy a NOT NULL
-- column is inventing a financial fact. `Check.apvNumbers` is a reference list;
-- `CheckBill` stays sourced from the approval workbook, which publishes real
-- per-bill amounts.
--
-- Measured 2026-09-07 over the 12,227 register rows: the column headed VOUCHER
-- NUMBER holds 11,944 AP references and no CV whatsoever, and the column headed
-- CHECKS APV holds 11,584 CV references and one AP. The headers are swapped
-- with respect to their contents. The parser discriminates on the AP-/CV-
-- prefix and never on the position, so the CV numbers have always landed in
-- `cvNumber` correctly; the vouchers were parsed all along and had nowhere to
-- be written. 84 vouchers reached the database, all of them from the approval
-- workbook's 85-row snapshot.
--
-- The array is NOT NULL with an implicit empty default, which is Postgres's own
-- behaviour for a TEXT[] added to an existing table: every one of the 21,817
-- existing rows reads as `{}` -- "no voucher recorded here" -- rather than as
-- NULL. `scripts/backfill-apv-numbers.ts` fills them from the register.
ALTER TABLE "Check" ADD COLUMN     "apvNumbers" TEXT[];

-- GIN, not B-tree. The lookup is `apvNumbers @> ARRAY['AP-ST042652']`: the
-- approval workbook's fallback when its `check No.` cell holds something that
-- is not a cheque number. A B-tree cannot answer array containment, so without
-- this each such bill is a sequential scan of the whole table.
CREATE INDEX "Check_apvNumbers_idx" ON "Check" USING GIN ("apvNumbers");

-- A row of the approval-for-release workbook that produced no CheckBill, kept
-- where somebody sees it.
--
-- It exists because of one cheque: voucher AP-ST042652 never reached the
-- supplier portal, because row 81 of the LIST sheet holds a date where the
-- cheque number belongs. The importer refused the row correctly and reported it
-- correctly -- to a terminal, once, during a run nobody was watching.
--
-- Deliberately not a StagedCheck. That table holds rows that could not become a
-- CHEQUE and every row of it carries an impliedStatus; a bill implies no status
-- at all, so squeezing one in would mean inventing one. Both are shown on
-- /admin/staged, which is what "one place to look" actually requires.
CREATE TYPE "StagedBillReason" AS ENUM ('NO_CHECK_NUMBER', 'NO_MATCHING_CHECK', 'AMBIGUOUS_CHECK', 'NO_APV', 'NO_AMOUNT');

CREATE TABLE "StagedBill" (
    "id" TEXT NOT NULL,
    "sourceSheet" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "reason" "StagedBillReason" NOT NULL,
    -- Verbatim, never normalised: this is what a human replaces with the real
    -- cheque number, and it is never promoted into one.
    "statedCheckRef" TEXT,
    "checkNumber" TEXT,
    "apvNumber" TEXT,
    "poNumber" TEXT,
    "companies" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagedBill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StagedBill_reason_idx" ON "StagedBill"("reason");

-- The idempotency key AND the cell a human is pointed at. Re-running the import
-- updates a staged row rather than adding a second one, and the same pass
-- deletes the rows that have since resolved -- so the count on /admin/staged
-- can go down as well as up.
CREATE UNIQUE INDEX "StagedBill_sourceSheet_sourceRow_key" ON "StagedBill"("sourceSheet", "sourceRow");
