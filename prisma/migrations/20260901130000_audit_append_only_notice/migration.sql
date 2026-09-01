-- Supersedes 20260901120000_audit_append_only, which claimed in its comments to
-- be an active control. It is not, unless a role named check_monitoring_app
-- exists AND the application actually connects as that role. On a default Neon
-- project the app connects as neondb_owner, which owns the table and therefore
-- keeps UPDATE and DELETE regardless of any REVOKE.
--
-- This migration is idempotent and re-runnable. It reports which branch it took
-- so `prisma migrate deploy` output records, every time, whether the control is
-- live in the environment being deployed to.
--
-- To make it live: create the role, grant it only SELECT/INSERT on "AuditLog",
-- and point the application's connection string at it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'check_monitoring_app') THEN
    REVOKE UPDATE, DELETE ON TABLE "AuditLog" FROM check_monitoring_app;
    GRANT SELECT, INSERT ON TABLE "AuditLog" TO check_monitoring_app;
    RAISE NOTICE 'audit_append_only: ACTIVE - UPDATE/DELETE revoked for check_monitoring_app';
  ELSE
    RAISE NOTICE 'audit_append_only: NOT ACTIVE - role check_monitoring_app does not exist; append-only is enforced by application code only';
  END IF;
END
$$;
