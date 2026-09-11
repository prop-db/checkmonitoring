-- The register's "CR 1234" is the supplier's Collection Receipt, not the bank's
-- clearing reference (client ruling 2026-09-11). The column is renamed to say
-- what it holds; no value changes.
ALTER TABLE "StagedCheck" RENAME COLUMN "clearingRef" TO "receiptRef";
