-- The register does not always know what a cheque is for or who it is payable
-- to. Of the 12,161 rows parsed from the client's workbook, 397 carry no amount
-- and 153 no payee. Both columns become NULL-able so those rows can record the
-- absence rather than a fabricated 0.00 or ''.
--
-- Widening only: every existing row keeps its value and no NULL is introduced
-- here, so this is safe to apply to a populated database and needs no backfill.

-- AlterTable
ALTER TABLE "Check" ALTER COLUMN "amount" DROP NOT NULL,
ALTER COLUMN "payeeName" DROP NOT NULL;
