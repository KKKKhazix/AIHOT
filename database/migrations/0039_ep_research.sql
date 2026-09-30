-- PR 1: additive EP research storage. No model, queue, HTTP route or existing-table changes.
-- Baseline: c3ba0ca3c19a7823f431871869083e075fd34caf; last migration 0038.
-- Applied by the existing migration runner inside a transaction. PostgreSQL 17 target.

CREATE TABLE ep_products (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('platform','catheter','generator','mapping_system','imaging','other')),
  parent_id text REFERENCES ep_products(id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Optional study family; cohort/endpoint denominators NEVER inherit these reported counts.
CREATE TABLE ep_studies (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 400),
  registry_id text UNIQUE,
  reported_counts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reported_counts) = 'array')
);

CREATE TABLE ep_research_records (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  source_key text NOT NULL UNIQUE,
  doi text UNIQUE CHECK (doi IS NULL OR (doi = lower(doi) AND doi ~ '^10\.[0-9]{4,9}/[^[:space:]]+$')),
  article_id text UNIQUE REFERENCES articles(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 2000),
  source_url text NOT NULL CHECK (source_url ~ '^https?://'),
  published_on date,
  study_design text NOT NULL CHECK (study_design IN ('randomized','prospective','retrospective','case_report','case_series','technical','preclinical','review','unknown')),
  material_scope text NOT NULL CHECK (material_scope IN ('metadata','abstract','partial_fulltext','fulltext')),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  publication_state text NOT NULL DEFAULT 'draft' CHECK (publication_state IN ('draft','published','withdrawn')),
  metadata_public_allowed boolean NOT NULL DEFAULT false,
  rights_basis text,
  rights_expires_at timestamptz,
  -- Audit only. No trigger and no queue insertion depend on this value.
  processing_meta jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(processing_meta) = 'object'),
  private_data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(private_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT metadata_public_allowed OR nullif(btrim(rights_basis), '') IS NOT NULL)
);

-- Many-to-many: a record can be independent, one report of a study, or a pooled analysis.
CREATE TABLE ep_record_studies (
  record_id uuid NOT NULL REFERENCES ep_research_records(id) ON DELETE CASCADE,
  study_id text NOT NULL REFERENCES ep_studies(id),
  relation text NOT NULL CHECK (relation IN ('primary_report','secondary_report','pooled_analysis','other')),
  source_locator text NOT NULL CHECK (length(btrim(source_locator)) > 0),
  PRIMARY KEY (record_id, study_id)
);
CREATE INDEX ep_record_studies_study_idx ON ep_record_studies(study_id, record_id);

CREATE TABLE ep_research_arms (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES ep_research_records(id) ON DELETE CASCADE,
  arm_key text NOT NULL CHECK (length(arm_key) BETWEEN 1 AND 80),
  label text NOT NULL,
  population text NOT NULL CHECK (population IN ('human','animal','bench','simulation','mixed','unknown')),
  reported_n integer CHECK (reported_n >= 0),
  n_unit text CHECK (n_unit IN ('patients','animals','lesions','veins','samples','other')),
  n_scope text,
  evidence_private jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence_private) = 'object'),
  UNIQUE (record_id, arm_key),
  UNIQUE (id, record_id),
  CHECK ((reported_n IS NULL AND n_unit IS NULL AND n_scope IS NULL)
      OR (reported_n IS NOT NULL AND n_unit IS NOT NULL AND nullif(btrim(n_scope), '') IS NOT NULL))
);

-- A context is an explicitly reported joint use, not an article-wide bag of tags.
-- Split contexts when product / imaging / disease apply to different patients or procedures.
CREATE TABLE ep_research_contexts (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL,
  arm_id uuid NOT NULL,
  context_key text NOT NULL CHECK (length(context_key) BETWEEN 1 AND 80),
  label text NOT NULL,
  disease text CHECK (disease ~ '^[A-Z][A-Z0-9_]{0,49}$'),
  imaging text[] NOT NULL DEFAULT '{}' CHECK (imaging <@ ARRAY['ICE','TEE','TTE','OTHER']::text[]),
  imaging_purpose text,
  radiation_strategy text NOT NULL DEFAULT 'unspecified' CHECK (radiation_strategy IN ('zero_fluoro','low_fluoro','unspecified')),
  source_locator text NOT NULL CHECK (length(btrim(source_locator)) > 0),
  verified boolean NOT NULL DEFAULT false,
  public_allowed boolean NOT NULL DEFAULT false,
  evidence_private jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence_private) = 'object'),
  FOREIGN KEY (arm_id, record_id) REFERENCES ep_research_arms(id, record_id) ON DELETE CASCADE,
  UNIQUE (arm_id, context_key),
  CHECK (NOT public_allowed OR verified)
);
CREATE INDEX ep_context_record_idx ON ep_research_contexts(record_id);
CREATE INDEX ep_context_arm_idx ON ep_research_contexts(arm_id);
CREATE INDEX ep_context_disease_radiation_idx ON ep_research_contexts(disease, radiation_strategy, id) WHERE verified AND public_allowed;
CREATE INDEX ep_context_imaging_idx ON ep_research_contexts USING gin(imaging) WHERE verified AND public_allowed;

CREATE TABLE ep_context_products (
  context_id uuid NOT NULL REFERENCES ep_research_contexts(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES ep_products(id),
  role text NOT NULL CHECK (role IN ('evaluated','used_as_tool','incidental_use')),
  source_locator text NOT NULL CHECK (length(btrim(source_locator)) > 0),
  PRIMARY KEY (context_id, product_id)
);
CREATE INDEX ep_context_product_lookup_idx ON ep_context_products(product_id, context_id);

-- Time and numeric observations are attached to the SAME finding/context.
-- No cross-family duration conversion: 1 year = 12 calendar months; 1 week = 7 days.
-- Days are not silently converted to calendar months. Exact search is conservative.
CREATE TABLE ep_research_findings (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL REFERENCES ep_research_contexts(id) ON DELETE CASCADE,
  finding_key text NOT NULL,
  endpoint text NOT NULL CHECK (endpoint ~ '^[a-z][a-z0-9_]{0,79}$'),
  label text NOT NULL,
  numerator integer CHECK (numerator >= 0),
  denominator integer CHECK (denominator > 0),
  denominator_unit text CHECK (denominator_unit IN ('patients','animals','lesions','veins','samples','other')),
  denominator_scope text,
  time_role text NOT NULL DEFAULT 'unspecified' CHECK (time_role IN ('follow_up','enrollment_period','procedure','unspecified')),
  time_value numeric CHECK (time_value >= 0),
  time_unit text CHECK (time_unit IN ('day','week','month','year')),
  time_basis text NOT NULL DEFAULT 'unknown' CHECK (time_basis IN ('observed','planned','median','minimum','maximum','unknown')),
  duration_family text GENERATED ALWAYS AS
    (CASE WHEN time_unit IN ('day','week') THEN 'day' WHEN time_unit IN ('month','year') THEN 'calendar_month' END) STORED,
  duration_value numeric GENERATED ALWAYS AS
    (CASE time_unit WHEN 'day' THEN time_value WHEN 'week' THEN time_value*7 WHEN 'month' THEN time_value WHEN 'year' THEN time_value*12 END) STORED,
  source_locator text NOT NULL CHECK (length(btrim(source_locator)) > 0),
  verified boolean NOT NULL DEFAULT false,
  public_allowed boolean NOT NULL DEFAULT false,
  evidence_private jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence_private) = 'object'),
  UNIQUE (context_id, finding_key),
  CHECK (numerator IS NULL OR (denominator IS NOT NULL AND numerator <= denominator)),
  CHECK ((denominator IS NULL AND denominator_unit IS NULL AND denominator_scope IS NULL)
      OR (denominator IS NOT NULL AND denominator_unit IS NOT NULL AND nullif(btrim(denominator_scope), '') IS NOT NULL)),
  CHECK ((time_value IS NULL AND time_unit IS NULL) OR (time_value IS NOT NULL AND time_unit IS NOT NULL)),
  CHECK (NOT public_allowed OR verified)
);
CREATE INDEX ep_finding_context_idx ON ep_research_findings(context_id);
CREATE INDEX ep_finding_public_lookup_idx ON ep_research_findings(context_id, endpoint, time_role, time_basis, duration_family, duration_value)
  WHERE verified AND public_allowed;
CREATE INDEX ep_record_public_date_idx ON ep_research_records(published_on DESC NULLS LAST, id)
  WHERE publication_state = 'published' AND metadata_public_allowed;

-- Public allow-list projections. Full text, private quotations, audit metadata and parent Ns
-- are deliberately absent. The API is NOT wired in PR1. Application readers use these views only.
CREATE VIEW ep_public_records WITH (security_barrier = true) AS
SELECT id, doi, title, source_url, published_on, study_design, material_scope
FROM ep_research_records
WHERE publication_state = 'published' AND metadata_public_allowed
  AND (rights_expires_at IS NULL OR rights_expires_at > now());

CREATE VIEW ep_public_contexts WITH (security_barrier = true) AS
SELECT c.id, c.record_id, c.arm_id, c.label, a.label AS arm_label, a.population,
       c.disease, c.imaging, c.imaging_purpose, c.radiation_strategy, c.source_locator
FROM ep_research_contexts c
JOIN ep_public_records r ON r.id = c.record_id
JOIN ep_research_arms a ON a.id = c.arm_id AND a.record_id = c.record_id
WHERE c.verified AND c.public_allowed;

CREATE VIEW ep_public_context_products WITH (security_barrier = true) AS
SELECT p.context_id, p.product_id, d.name AS product_name, d.kind AS product_kind, p.role, p.source_locator
FROM ep_context_products p
JOIN ep_public_contexts c ON c.id = p.context_id
JOIN ep_products d ON d.id = p.product_id;

CREATE VIEW ep_public_findings WITH (security_barrier = true) AS
SELECT f.id, f.context_id, f.endpoint, f.label, f.numerator, f.denominator,
       f.denominator_unit, f.denominator_scope, f.time_role, f.time_value, f.time_unit,
       f.time_basis, f.duration_family, f.duration_value, f.source_locator
FROM ep_research_findings f
JOIN ep_public_contexts c ON c.id = f.context_id
WHERE f.verified AND f.public_allowed;
