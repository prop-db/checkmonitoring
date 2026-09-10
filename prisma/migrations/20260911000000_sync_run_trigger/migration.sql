-- Who started a sync: a person pressing SYNC NOW, or the schedule.
--
-- Until 2026-09-11 every run was a click, so the default is not a guess about
-- history — it is history. From here the daily cron writes SCHEDULED and the
-- admin log can say which runs happened because somebody remembered and which
-- because nobody had to.
ALTER TABLE "SyncRun" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'MANUAL';
