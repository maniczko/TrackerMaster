-- D4 schema v13 -> v14: allow 'auto_included' for short observed sleep.
-- Runs in one transaction after a verified backup. SQLite cannot change a CHECK in
-- place, so the table is rebuilt: the v12 triggers and indexes are dropped, the old
-- table is renamed, the v14 schema (sleep_periods_v14.sql) is created at the marker
-- below, and every row is copied with its id, boundaries, flag and decision.
-- Rows are copied as pending first and decisions are then applied, so the v14
-- triggers stay in force during the copy. Existing pending periods stay pending:
-- the threshold applies only to sleep observed after the migration.
DROP TRIGGER sleep_periods_initial_pending;
DROP TRIGGER sleep_periods_no_overlap_insert;
DROP TRIGGER sleep_periods_no_overlap_update;
DROP TRIGGER sleep_periods_immutable;
DROP TRIGGER sleep_periods_no_delete;
DROP INDEX sleep_periods_pending;
DROP INDEX sleep_periods_one_open;
ALTER TABLE sleep_periods RENAME TO sleep_periods_v13;
-- @schema
INSERT INTO sleep_periods(id, entry_id, started_ms, ended_ms, manual_resume)
    SELECT id, entry_id, started_ms, ended_ms, manual_resume FROM sleep_periods_v13 ORDER BY started_ms, id;
UPDATE sleep_periods
SET decision = (SELECT o.decision FROM sleep_periods_v13 o WHERE o.id = sleep_periods.id),
    decided_ms = (SELECT o.decided_ms FROM sleep_periods_v13 o WHERE o.id = sleep_periods.id)
WHERE id IN (SELECT id FROM sleep_periods_v13 WHERE decision <> 'pending');
