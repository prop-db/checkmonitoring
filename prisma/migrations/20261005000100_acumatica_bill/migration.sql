-- The purchase orders Acumatica's AP bills name, keyed by APV.
-- See docs/superpowers/specs/2026-10-05-po-from-acumatica-design.md.
--
-- Reference data mirrored from AP-Bills and Adjustments by lib/sync/bill-refs.ts:
-- one row per Bill whose VendorRef yields at least one real PO; deleted when it
-- no longer does. No foreign key to "Check": the APV is resolved against a
-- cheque's displayed vouchers when the PO NUMBER column is drawn.
CREATE TABLE "AcumaticaBill" (
    "apvNumber" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "vendorRef" TEXT NOT NULL,
    "poNumbers" TEXT[],
    "lastModifiedOn" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcumaticaBill_pkey" PRIMARY KEY ("apvNumber")
);
