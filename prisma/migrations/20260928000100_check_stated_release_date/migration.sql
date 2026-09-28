-- The register's stated release day, kept apart from releasedAt (the app's own
-- record of a release). See docs/superpowers/specs/2026-09-28-stated-release-date-design.md.
ALTER TABLE "Check" ADD COLUMN "statedReleaseDate" TIMESTAMP(3);
CREATE INDEX "Check_statedReleaseDate_idx" ON "Check"("statedReleaseDate");
