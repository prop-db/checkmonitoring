-- "The amount is not recorded", stored so the dashboard can count and filter on
-- it over 9,247 rows without a sequential scan on every page load.
--
-- Measured, and the reason this column exists: 129 of the 9,247
-- register-derived cheques already in production carry no amount (21,817 rows
-- in the table altogether, the rest from Acumatica), because the register's
-- amount cell was blank or held the word "CANCELLED" where a figure belongs.
-- Acumatica was reconciled against all 129 and has no record of any of them.
-- Until now nothing on any screen said so.
--
-- NOT a synonym for `isStale`, which is reserved for the design's R3 queue (88
-- 2025 cheques still sitting AVAILABLE). Stale is "has sat too long";
-- incomplete is "is missing a fact". A cheque can be either, both or neither.
ALTER TABLE "Check" ADD COLUMN IF NOT EXISTS "isIncomplete" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Check_isIncomplete_idx" ON "Check"("isIncomplete");

-- The backfill for the 129, run here so a deployed database is correct the
-- moment the code that reads the column ships. Idempotent, and deliberately the
-- same statement `backfillIncompleteFlags` runs: `amount IS NULL`, never a
-- falsy test. A cheque recorded as 0.00 is a cheque drawn for nothing, which is
-- a different fact from one whose amount nobody wrote down, and flagging it
-- would offer a real zero-value cheque for deletion.
UPDATE "Check" SET "isIncomplete" = true WHERE "amount" IS NULL AND "isIncomplete" = false;
