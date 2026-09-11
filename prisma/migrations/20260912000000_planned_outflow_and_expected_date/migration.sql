-- The day Finance expects a cheque to leave the bank. Typed, never imported.
ALTER TABLE "Check" ADD COLUMN "expectedOutflowDate" TIMESTAMP(3);

-- Planned non-cheque outflows (2026-09-12). One-off lines; never deleted.
CREATE TYPE "PlannedOutflowStatus" AS ENUM ('PLANNED', 'PAID', 'CANCELLED');

CREATE TABLE "PlannedOutflow" (
    "id"            TEXT NOT NULL,
    "date"          TIMESTAMP(3) NOT NULL,
    "amount"        DECIMAL(18,2) NOT NULL,
    "currency"      TEXT NOT NULL DEFAULT 'PHP',
    "bankId"        TEXT NOT NULL,
    "companyId"     TEXT NOT NULL,
    "description"   TEXT NOT NULL,
    "category"      TEXT,
    "status"        "PlannedOutflowStatus" NOT NULL DEFAULT 'PLANNED',
    "createdById"   TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "paidById"      TEXT,
    "paidAt"        TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt"   TIMESTAMP(3),
    "cancelReason"  TEXT,

    CONSTRAINT "PlannedOutflow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlannedOutflow_status_date_idx" ON "PlannedOutflow"("status", "date");

ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_bankId_fkey"
  FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_paidById_fkey"
  FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The actor columns say the same thing the status does, structurally: a PAID
-- line always records who and when; a CANCELLED line always records who, when
-- and why; a PLANNED line records none of them. The same discipline `Check`
-- keeps for its own actor columns.
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "planned_outflow_status_columns" CHECK (
  (("status" = 'PAID') = ("paidAt" IS NOT NULL AND "paidById" IS NOT NULL))
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL))
);
