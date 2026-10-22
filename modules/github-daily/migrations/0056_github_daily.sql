CREATE TABLE IF NOT EXISTS github_daily_snapshots (
  snapshot_date date NOT NULL,
  rank integer NOT NULL,
  repository text NOT NULL,
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  language text,
  stars_total integer NOT NULL DEFAULT 0,
  stars_today integer NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, repository)
);
