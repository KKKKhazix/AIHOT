CREATE TABLE IF NOT EXISTS external_rankings (
  id text PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL,
  url text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_updated text,
  fetched_at timestamptz,
  attempted_at timestamptz,
  failed boolean NOT NULL DEFAULT false
);
