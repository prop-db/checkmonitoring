-- The constraint in 20260912000000 compared each status against the
-- CONJUNCTION of its actor columns, so a PLANNED row carrying a stray paidAt
-- with paidById still null satisfied it (FALSE = FALSE). Found in review the
-- same day. Each column now answers to the status on its own: a PAID row has
-- both paid columns and no cancel columns; a CANCELLED row the three cancel
-- columns and no paid columns; a PLANNED row none of the five.
ALTER TABLE "PlannedOutflow" DROP CONSTRAINT "planned_outflow_status_columns";
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "planned_outflow_status_columns" CHECK (
  (("status" = 'PAID') = ("paidAt" IS NOT NULL))
  AND (("status" = 'PAID') = ("paidById" IS NOT NULL))
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
  AND (("status" = 'CANCELLED') = ("cancelledById" IS NOT NULL))
  AND (("status" = 'CANCELLED') = ("cancelReason" IS NOT NULL))
);
