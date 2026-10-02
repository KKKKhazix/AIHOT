-- Source material stays unchanged; readings and publications name the evidence they used.
ALTER TABLE articles ADD COLUMN body_snapshot_html text;
ALTER TABLE articles ADD COLUMN body_snapshot_selector text;
ALTER TABLE articles ADD COLUMN reading_generation integer NOT NULL DEFAULT 0;

CREATE TABLE article_readings (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  generation integer NOT NULL,
  input_hash text NOT NULL,
  policy_hash text NOT NULL,
  asset_set_hash text,
  model text NOT NULL,
  prompt_version text NOT NULL,
  request_key text,
  mode text NOT NULL CHECK (mode IN ('shadow', 'active')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  quality text NOT NULL DEFAULT 'needs_review' CHECK (quality IN ('complete', 'partial', 'needs_review')),
  source_blocks jsonb NOT NULL,
  kept_block_ids text[],
  body_markdown text,
  body_html text,
  body_text text,
  coverage jsonb NOT NULL DEFAULT '{}',
  receipt_ids bigint[] NOT NULL DEFAULT '{}',
  error text,
  manual boolean NOT NULL DEFAULT false,
  silent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  published_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  UNIQUE(article_id, input_revision, generation, input_hash, policy_hash, mode)
);
CREATE INDEX article_readings_article_idx ON article_readings(article_id, id DESC);

CREATE TABLE article_image_readings (
  reading_id bigint NOT NULL REFERENCES article_readings(id) ON DELETE CASCADE,
  image_id text NOT NULL,
  url text NOT NULL,
  context_hash text NOT NULL,
  asset_hash text,
  tile_count integer NOT NULL DEFAULT 0,
  etag text,
  last_modified text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'ignored', 'unreadable')),
  retryable boolean NOT NULL DEFAULT false,
  role text,
  markdown text NOT NULL DEFAULT '',
  reason text,
  uncertainties jsonb NOT NULL DEFAULT '[]',
  regions jsonb NOT NULL DEFAULT '[]',
  receipt_ids bigint[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(reading_id, image_id)
);
CREATE INDEX article_image_readings_asset_idx ON article_image_readings(asset_hash) WHERE asset_hash IS NOT NULL;

ALTER TABLE articles ADD COLUMN accepted_reading_id bigint REFERENCES article_readings(id);
ALTER TABLE analyses ADD COLUMN input_reading_id bigint REFERENCES article_readings(id);
ALTER TABLE publications ADD COLUMN reading_id bigint REFERENCES article_readings(id);
-- Legacy articles also get a publication snapshot, so re-extraction cannot mix old copy and new body.
ALTER TABLE publications ADD COLUMN body_html text;
ALTER TABLE publications ADD COLUMN body_text text;
ALTER TABLE publications ADD COLUMN input_revision integer;
ALTER TABLE publications ADD COLUMN x_post jsonb;
UPDATE publications p SET body_html = a.body_html, body_text = a.body_text, input_revision = a.revision, x_post = a.x_post
FROM articles a WHERE a.id = p.article_id;
ALTER TABLE translations ADD COLUMN reading_id bigint REFERENCES article_readings(id);
ALTER TABLE translation_attempts ADD COLUMN reading_id bigint REFERENCES article_readings(id);
