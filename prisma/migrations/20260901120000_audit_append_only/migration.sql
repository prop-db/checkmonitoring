-- Second line of defence: even a bug in application code cannot rewrite
-- history. The migration role keeps full rights; the runtime role does not.
-- Replace check_monitoring_app with the role your app connects as.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'check_monitoring_app') THEN
    REVOKE UPDATE, DELETE ON TABLE "AuditLog" FROM check_monitoring_app;
    GRANT SELECT, INSERT ON TABLE "AuditLog" TO check_monitoring_app;
  END IF;
END
$$;
