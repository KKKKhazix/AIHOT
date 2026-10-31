-- The uses a source serves besides the news pipeline (participation_mode), each one declared by an installed
-- module (ServerModule.sourceUses), which reads the source's articles itself. Empty: the news pipeline alone.
ALTER TABLE sources ADD COLUMN uses text[] NOT NULL DEFAULT '{}';
