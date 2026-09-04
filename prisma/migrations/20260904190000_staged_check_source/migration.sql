-- A staged row can now come from either ingestion path.
--
-- 80 live Acumatica payments are PaymentMethod CHK -- genuinely cheques -- whose
-- PaymentRef is free text ("Oct interest", "pay 12 25 2nd") rather than a cheque
-- number. They cannot be keyed on (companyId, checkNumber), and Finance ruled on
-- 2026-09-04 that they are staged exactly as the register's 66 numberless rows
-- are. `StagedCheck` could only be keyed on (sourceSheet, sourceRow), which an
-- Acumatica row has neither of, so those payments were being thrown away as sync
-- errors. This adds a real source discriminator and a second unique key rather
-- than faking a sheet name to squeeze them into the register's.

-- CreateEnum
CREATE TYPE "IngestSource" AS ENUM ('WORKBOOK', 'ACUMATICA');

-- Every row that exists today came from the register: the Acumatica path could
-- not stage anything until this migration. The default back-fills them and is
-- then dropped, so a future insert has to say where it came from.
ALTER TABLE "StagedCheck" ADD COLUMN "source" "IngestSource" NOT NULL DEFAULT 'WORKBOOK';
ALTER TABLE "StagedCheck" ALTER COLUMN "source" DROP DEFAULT;

ALTER TABLE "StagedCheck" ALTER COLUMN "sourceSheet" DROP NOT NULL;
ALTER TABLE "StagedCheck" ALTER COLUMN "sourceRow" DROP NOT NULL;

ALTER TABLE "StagedCheck" ADD COLUMN "acumaticaRef" TEXT;
ALTER TABLE "StagedCheck" ADD COLUMN "acumaticaTenant" "AcumaticaTenant";
ALTER TABLE "StagedCheck" ADD COLUMN "statedCheckRef" TEXT;

-- The Acumatica identity. The tenant is part of the key because both tenants
-- number their vouchers CV-ST... while `ST` means a different company in each,
-- so the reference alone would collapse two different payments into one row.
CREATE UNIQUE INDEX "StagedCheck_acumaticaTenant_acumaticaRef_key"
  ON "StagedCheck"("acumaticaTenant", "acumaticaRef");

CREATE INDEX "StagedCheck_source_idx" ON "StagedCheck"("source");

-- Postgres treats NULLs in a unique index as distinct, so neither key on its own
-- stops a row that fills neither from being inserted over and over. The
-- discriminator has to mean something for the keys to work, and it is enforced
-- here rather than trusted to the application: a row that fills both identities,
-- or neither, is not a staged row anybody can key.
ALTER TABLE "StagedCheck" ADD CONSTRAINT "staged_check_one_source_identity" CHECK (
  (
    "source" = 'WORKBOOK'
    AND "sourceSheet" IS NOT NULL AND "sourceRow" IS NOT NULL
    AND "acumaticaRef" IS NULL AND "acumaticaTenant" IS NULL
  ) OR (
    "source" = 'ACUMATICA'
    AND "acumaticaRef" IS NOT NULL AND "acumaticaTenant" IS NOT NULL
    AND "sourceSheet" IS NULL AND "sourceRow" IS NULL
  )
);

-- An Acumatica row can now be staged, so a sync's staged payments are no longer
-- counted as errors. They still need a human, so the count is recorded rather
-- than disappearing from the run record entirely.
ALTER TABLE "SyncRun" ADD COLUMN "staged" INTEGER NOT NULL DEFAULT 0;
