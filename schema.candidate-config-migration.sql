-- Upgrade only, once: fresh installs already contain this column and these tables.
-- Unknown historical provenance stays NULL; no application or receipt is rewritten.
ALTER TABLE jobs ADD COLUMN criteria_version TEXT;

CREATE TABLE IF NOT EXISTS candidate_run_configs (
  run_id TEXT PRIMARY KEY,
  criteria_version TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'
    AND json_extract(config_json, '$.criteriaVersion') IS criteria_version),
  admitted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_active_configs (
  instance_id TEXT PRIMARY KEY,
  criteria_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  activated_at TEXT NOT NULL
);

-- Complete stable screening schema for older supported upgrades. Existing evidence is untouched.
CREATE TABLE IF NOT EXISTS posting_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  normalized_json TEXT NOT NULL CHECK (length(CAST(normalized_json AS BLOB)) <= 32768),
  company_category TEXT,
  fetched_at TEXT,
  normalizer_version TEXT NOT NULL,
  UNIQUE (job_id, content_hash),
  UNIQUE (id, job_id),
  CHECK (json_valid(normalized_json) AND json_type(normalized_json) = 'object' AND json_extract(normalized_json, '$.id') IS job_id)
);
CREATE TABLE IF NOT EXISTS job_evaluations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('match','no_match','needs_review','retry')),
  decision_json TEXT NOT NULL,
  criteria_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  UNIQUE (id, job_id),
  FOREIGN KEY (snapshot_id, job_id) REFERENCES posting_snapshots(id, job_id),
  CHECK (snapshot_id IS NOT NULL OR state = 'retry'),
  CHECK (json_valid(decision_json) AND json_type(decision_json) = 'object'
    AND json_extract(decision_json, '$.state') IS state
    AND json_extract(decision_json, '$.criteriaVersion') IS criteria_version
    AND json_extract(decision_json, '$.promptVersion') IS prompt_version
    AND json_extract(decision_json, '$.model') IS model)
);
CREATE INDEX IF NOT EXISTS idx_job_evaluations_job ON job_evaluations(job_id, evaluated_at);
CREATE TABLE IF NOT EXISTS job_screening_current (
  job_id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  FOREIGN KEY (evaluation_id, job_id) REFERENCES job_evaluations(id, job_id)
);
CREATE TABLE IF NOT EXISTS screening_deliveries (
  evaluation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','suppressed')),
  delivered_at TEXT,
  FOREIGN KEY (evaluation_id, job_id) REFERENCES job_evaluations(id, job_id),
  CHECK ((status = 'delivered' AND delivered_at IS NOT NULL) OR (status <> 'delivered' AND delivered_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_screening_deliveries_status ON screening_deliveries(status);
