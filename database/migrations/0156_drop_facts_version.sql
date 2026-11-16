-- Nothing bumps or reads a fact's version; a story's version is what pages and the sitemap use; deletion approved (2026-11-17).
ALTER TABLE facts DROP COLUMN IF EXISTS version;
