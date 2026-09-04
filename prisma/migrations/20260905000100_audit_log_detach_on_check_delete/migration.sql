-- One exemption, and one only, to the append-only audit trigger.
--
-- `AuditLog.checkId` has been ON DELETE SET NULL since the initial migration,
-- so that deleting a cheque detaches its audit rows instead of destroying them.
-- Postgres implements SET NULL as an UPDATE on "AuditLog", which fires the
-- BEFORE UPDATE trigger added in 20260901140100 — so the referential action
-- raised, and no cheque with any audit history could ever be deleted at all.
-- That was invisible until `deleteIncompleteCheck` (Finance's request to remove
-- the incomplete records) tried it.
--
-- The two ways out that are NOT taken here:
--   * `app.allow_audit_purge` from application code. That switch disables the
--     trigger wholesale for the transaction and exists solely so the test suite
--     can truncate; it appears in tests/helpers/db.ts and in the trigger
--     migration, and anywhere else it is a defect. See CLAUDE.md rule 7.
--   * `onDelete: Cascade` on the relation. That deletes the record of who
--     touched money, which is the thing this trigger exists to protect.
--
-- What IS permitted is exactly the detach: `checkId` goes from a value to NULL
-- while every column that is evidence — id, actorType, userId, action, details,
-- remarks, createdAt — stays identical, AND the cheque it pointed at no longer
-- exists. That last condition is what keeps this narrow: it can only be
-- satisfied inside the transaction that deleted the cheque, so a hand-run
-- `UPDATE "AuditLog" SET "checkId" = NULL` against a live cheque still raises.
-- An audit row's content remains unwritable by anything.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_audit_purge', true), 'off') = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."checkId" IS NOT NULL
     AND NEW."checkId" IS NULL
     AND NEW."id"        =                  OLD."id"
     AND NEW."actorType" =                  OLD."actorType"
     AND NEW."userId"    IS NOT DISTINCT FROM OLD."userId"
     AND NEW."action"    =                  OLD."action"
     AND NEW."details"   IS NOT DISTINCT FROM OLD."details"
     AND NEW."remarks"   IS NOT DISTINCT FROM OLD."remarks"
     AND NEW."createdAt" =                  OLD."createdAt"
     AND NOT EXISTS (SELECT 1 FROM "Check" WHERE "id" = OLD."checkId")
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP
    USING HINT = 'Audit history is evidence. Write a new row; never alter an existing one.';
END;
$$ LANGUAGE plpgsql;

-- Recreated so a database that somehow lacks the trigger gets it, and so this
-- migration is safe to re-run.
DROP TRIGGER IF EXISTS "audit_log_no_update_or_delete" ON "AuditLog";
CREATE TRIGGER "audit_log_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
