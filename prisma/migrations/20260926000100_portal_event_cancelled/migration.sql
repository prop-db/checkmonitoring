-- A fifth thing the outbox can tell the portal: the cheque is cancelled or
-- voided. Alone in its migration on purpose: Postgres refuses to USE a new
-- enum value inside the transaction that added it.
ALTER TYPE "PortalEventKind" ADD VALUE 'CANCELLED';
