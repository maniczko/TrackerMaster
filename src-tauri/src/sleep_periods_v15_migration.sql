-- Schema v14 -> v15: add `source` ('sleep' | 'idle') to sleep_periods (TECH-12, DEV-39).
-- Runs in one IMMEDIATE transaction after a verified backup and after the exact v14
-- schema and rows were validated (sleep_periods.rs, migrate_source). SQLite cannot
-- change a table CHECK in place, so the table is rebuilt as in v14: the v14 triggers
-- and indexes are dropped, the old table is renamed, the v15 schema
-- (sleep_periods_v15.sql) is created at the marker below, and every row is copied with
-- its id, boundaries, flag and decision. Every existing row was recorded by the sleep
-- path, so it gets source='sleep' (the column default). Rows are copied as pending
-- first and decisions are then applied, so the v15 triggers stay in force during the
-- copy. Decisions, including 'auto_included' from #62, are kept exactly.
DROP TRIGGER sleep_periods_initial_pending;
DROP TRIGGER sleep_periods_no_overlap_insert;
DROP TRIGGER sleep_periods_no_overlap_update;
DROP TRIGGER sleep_periods_immutable;
DROP TRIGGER sleep_periods_no_delete;
DROP INDEX sleep_periods_pending;
DROP INDEX sleep_periods_one_open;
ALTER TABLE sleep_periods RENAME TO sleep_periods_v14;
-- @schema
INSERT INTO sleep_periods(id, entry_id, started_ms, ended_ms, manual_resume)
    SELECT id, entry_id, started_ms, ended_ms, manual_resume FROM sleep_periods_v14 ORDER BY started_ms, id;
UPDATE sleep_periods
SET decision = (SELECT o.decision FROM sleep_periods_v14 o WHERE o.id = sleep_periods.id),
    decided_ms = (SELECT o.decided_ms FROM sleep_periods_v14 o WHERE o.id = sleep_periods.id)
WHERE id IN (SELECT id FROM sleep_periods_v14 WHERE decision <> 'pending');
