-- The sixth thing the outbox tells the portal: the supplier's receipt
-- (user request 2026-10-01). Alone on purpose: Postgres refuses to USE a new
-- enum value inside the transaction that added it.
ALTER TYPE "PortalEventKind" ADD VALUE 'RECEIPT';
