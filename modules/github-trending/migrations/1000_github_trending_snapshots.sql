CREATE TABLE IF NOT EXISTS github_trending_snapshots (
  id bigserial PRIMARY KEY,
  period text NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  rank integer NOT NULL,
  repo text NOT NULL,
  description text,
  language text,
  stars integer,
  stars_period integer,
  url text NOT NULL
);
