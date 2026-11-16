-- A story's early decomposition; only the 2026-09-28 replay import filled it and no code reads it; deletion approved (2026-11-17).
ALTER TABLE stories DROP COLUMN IF EXISTS action;
