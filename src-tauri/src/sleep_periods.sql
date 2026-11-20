-- D4 sleep periods. Installed only after a verified backup of existing data.
-- Times are UTC Unix milliseconds; intervals are half-open [start, end).
CREATE TABLE sleep_periods (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
    started_ms INTEGER NOT NULL CHECK (typeof(started_ms) = 'integer' AND started_ms BETWEEN 0 AND 8640000000000000),
    ended_ms INTEGER CHECK (ended_ms IS NULL OR (typeof(ended_ms) = 'integer' AND ended_ms > started_ms AND ended_ms <= 8640000000000000)),
    manual_resume INTEGER NOT NULL DEFAULT 0 CHECK (manual_resume IN (0,1) AND (ended_ms IS NOT NULL OR manual_resume=0)),
    decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'included', 'excluded')),
    decided_ms INTEGER,
    CHECK ((decision = 'pending' AND decided_ms IS NULL) OR
           (decision IN ('included', 'excluded') AND ended_ms IS NOT NULL AND typeof(decided_ms) = 'integer' AND decided_ms BETWEEN 0 AND 8640000000000000)),
    UNIQUE (entry_id, started_ms)
);
CREATE INDEX sleep_periods_pending ON sleep_periods(decision, id);
CREATE UNIQUE INDEX sleep_periods_one_open ON sleep_periods(entry_id) WHERE ended_ms IS NULL;

-- Every period must first be recorded as pending. Only a later explicit action
-- may set a decision after the end has been observed.
CREATE TRIGGER sleep_periods_initial_pending BEFORE INSERT ON sleep_periods
WHEN NEW.decision <> 'pending' OR NEW.decided_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'sleep period must start pending'); END;

-- Refuse overlapping intervals even if written by a future caller.
CREATE TRIGGER sleep_periods_no_overlap_insert BEFORE INSERT ON sleep_periods
WHEN EXISTS (
    SELECT 1 FROM sleep_periods p
    WHERE p.entry_id = NEW.entry_id
      AND (NEW.ended_ms IS NULL OR p.started_ms < NEW.ended_ms)
      AND (p.ended_ms IS NULL OR NEW.started_ms < p.ended_ms)
)
BEGIN SELECT RAISE(ABORT, 'overlapping sleep periods'); END;
CREATE TRIGGER sleep_periods_no_overlap_update BEFORE UPDATE OF entry_id, started_ms, ended_ms ON sleep_periods
WHEN EXISTS (
    SELECT 1 FROM sleep_periods p
    WHERE p.entry_id = NEW.entry_id AND p.id <> OLD.id
      AND (NEW.ended_ms IS NULL OR p.started_ms < NEW.ended_ms)
      AND (p.ended_ms IS NULL OR NEW.started_ms < p.ended_ms)
)
BEGIN SELECT RAISE(ABORT, 'overlapping sleep periods'); END;

-- An observed boundary is immutable; only an unfinished end may be filled in.
-- An explicit decision is final. Corrections need a separately designed audit.
CREATE TRIGGER sleep_periods_immutable BEFORE UPDATE ON sleep_periods
WHEN NEW.id IS NOT OLD.id OR NEW.entry_id IS NOT OLD.entry_id
  OR NEW.started_ms IS NOT OLD.started_ms
  OR (OLD.ended_ms IS NOT NULL AND (NEW.ended_ms IS NOT OLD.ended_ms OR NEW.manual_resume IS NOT OLD.manual_resume))
  OR (OLD.decision <> 'pending' AND
      (NEW.decision IS NOT OLD.decision OR NEW.decided_ms IS NOT OLD.decided_ms))
BEGIN SELECT RAISE(ABORT, 'immutable sleep period'); END;
CREATE TRIGGER sleep_periods_no_delete BEFORE DELETE ON sleep_periods
BEGIN SELECT RAISE(ABORT, 'sleep periods are retained for audit'); END;
