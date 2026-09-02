-- The system's core guarantee, made structural. An INTERNAL check - payroll,
-- tax, an inter-company transfer - must never carry portal routing state. The
-- application enforces this through portalRoute(), but a future caller, a bad
-- migration, or a manual UPDATE could otherwise put a check into a state that
-- says "internal" and "queued for the supplier portal" at the same time.
ALTER TABLE "Check"
  ADD CONSTRAINT "check_internal_never_routes_to_portal"
  CHECK (
    "eligibility" <> 'INTERNAL'
    OR ("portalDomain" IS NULL AND "portalSyncStatus" = 'NOT_APPLICABLE')
  );
