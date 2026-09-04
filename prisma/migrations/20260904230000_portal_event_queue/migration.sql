-- PortalEvent becomes a queue a worker can claim from.
--
-- It was a log: a free-string status, no schedule, and nothing stopping two
-- workers from picking up the same row. The two properties this migration adds
-- protect the same thing — a supplier being messaged twice about one cheque.
-- The unique key stops the outbox QUEUEING the instruction twice; the claim
-- columns stop two workers DELIVERING one queued instruction twice.

-- CreateEnum
CREATE TYPE "PortalEventStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'PARKED');
CREATE TYPE "PortalEventKind" AS ENUM ('MARK_AVAILABLE', 'REVERT', 'RELEASED');

-- `kind` is back-filled from the payload's own `action`, which is the only place
-- the three call sites in lib/domain/actions.ts have ever recorded what an event
-- instructs. All three values they write are in the enum.
--
-- A row whose action is none of the three leaves `kind` NULL and the SET NOT NULL
-- below aborts the whole migration. That is intended. There is no safe default:
-- guessing MARK_AVAILABLE for an instruction nobody can identify would queue a
-- supplier notification, and guessing REVERT would retract a real one. A
-- migration that stops and asks is the cheap failure here.
ALTER TABLE "PortalEvent" ADD COLUMN "kind" "PortalEventKind";
UPDATE "PortalEvent"
   SET "kind" = ("payload"->>'action')::"PortalEventKind"
 WHERE "payload"->>'action' IN ('MARK_AVAILABLE', 'REVERT', 'RELEASED');
ALTER TABLE "PortalEvent" ALTER COLUMN "kind" SET NOT NULL;

-- The idempotency key. New rows carry the acting timestamp as their third
-- segment (see `portalEventKey` in lib/domain/actions.ts), which is what makes a
-- revert-then-re-ready a genuinely new instruction rather than a duplicate.
--
-- A pre-queue row has no such timestamp to reconstruct. `createdAt` is when the
-- row was written, not the `now` the action was performed with, and back-filling
-- from it would invent a generation that never existed and could collide with a
-- real one. Each is keyed on its own id instead: unique by definition, honest
-- about being legacy, and containing ':legacy:' so it can never collide with a
-- key minted by the application.
ALTER TABLE "PortalEvent" ADD COLUMN "idempotencyKey" TEXT;
UPDATE "PortalEvent"
   SET "idempotencyKey" = "checkId" || ':' || "kind"::text || ':legacy:' || "id";
ALTER TABLE "PortalEvent" ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- The status column stops being a free string. Every value the application has
-- ever written is 'PENDING'; anything else aborts here rather than being coerced,
-- for the same reason as `kind` above.
ALTER TABLE "PortalEvent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PortalEvent"
  ALTER COLUMN "status" TYPE "PortalEventStatus" USING "status"::"PortalEventStatus";
ALTER TABLE "PortalEvent" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Scheduling and claiming. `nextAttemptAt` defaults to now so an existing PENDING
-- row is immediately eligible, which is the state it was already in.
ALTER TABLE "PortalEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PortalEvent" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "PortalEvent" ADD COLUMN "claimedBy" TEXT;

CREATE UNIQUE INDEX "PortalEvent_idempotencyKey_key" ON "PortalEvent"("idempotencyKey");

-- The worker claims on (status, nextAttemptAt), so the old (status, createdAt)
-- index no longer serves any query this table has.
DROP INDEX "PortalEvent_status_createdAt_idx";
CREATE INDEX "PortalEvent_status_nextAttemptAt_idx" ON "PortalEvent"("status", "nextAttemptAt");
CREATE INDEX "PortalEvent_checkId_idx" ON "PortalEvent"("checkId");
