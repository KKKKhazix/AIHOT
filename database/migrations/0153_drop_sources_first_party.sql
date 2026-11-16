-- A source is first party exactly when its tier is T1, computed where it is read; the column has been unread since
-- #2789 (2026-11-16); deletion approved (2026-11-16). publications.first_party is a different column and stays.
ALTER TABLE sources DROP COLUMN IF EXISTS first_party;
