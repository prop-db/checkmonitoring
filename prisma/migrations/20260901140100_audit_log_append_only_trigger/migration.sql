-- Makes the append-only audit trail true for the role the application actually
-- connects as, rather than only for a check_monitoring_app role that does not
-- exist yet. A table owner cannot bypass a trigger without dropping it, and
-- dropping it is a schema change visible in migration history.
--
-- The escape hatch exists solely so the test suite can truncate between tests.
-- Application code has no reason to set this, and its appearance in app code
-- should be treated as a defect in review.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_audit_purge', true), 'off') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP
    USING HINT = 'Audit history is evidence. Write a new row; never alter an existing one.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_log_no_update_or_delete" ON "AuditLog";
CREATE TRIGGER "audit_log_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
