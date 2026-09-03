-- A SyncRun did not record WHICH Acumatica tenant it ran against. There are two
-- of them and they reuse the same branch codes for different companies, so a
-- "last sync" figure that pools both is a number about nothing: a Go-Live run
-- would report as the Manufacturing tenant's last attempt and vice versa.
ALTER TABLE "SyncRun" ADD COLUMN "tenant" TEXT;

-- The point the NEXT incremental run should read from: the maximum
-- LastModifiedOn this run saw, minus the 120-minute overlap. Stored on the run
-- that computed it rather than in a single mutable setting, so a run's own
-- record says where it left off and a bad run can be skipped over rather than
-- having to be undone.
ALTER TABLE "SyncRun" ADD COLUMN "watermark" TIMESTAMP(3);

-- Both columns are nullable rather than NOT NULL DEFAULT: nothing has ever
-- written a SyncRun row, so there is no back-fill to do, and a null is the
-- honest value for a run recorded before the column existed. `runSync` always
-- writes the tenant.
CREATE INDEX "SyncRun_tenant_startedAt_idx" ON "SyncRun"("tenant", "startedAt");
