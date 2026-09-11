-- A fourth thing the outbox can tell the portal: a release was undone and the
-- cheque is available again. Not REVERT — the portal reads that as withdrawn.
--
-- Alone in its migration on purpose: Postgres refuses to USE a new enum value
-- inside the transaction that added it, so nothing else may share this file.
ALTER TYPE "PortalEventKind" ADD VALUE 'RELEASE_REVERSED';
