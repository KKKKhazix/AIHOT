-- Unwritten since #2796: a story's latest progress is taken from its newest report when read; deletion approved (2026-11-17).
ALTER TABLE stories DROP COLUMN IF EXISTS latest;
