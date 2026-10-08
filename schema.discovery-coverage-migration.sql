-- Additive D0 accounting only. Apply after inspecting the actual remote schema
-- and taking a fresh validated export during an authorized release.
CREATE TABLE IF NOT EXISTS discovery_runs (
  run_id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL CHECK (pipeline IN ('fixed_boards','unbounded_discovery')),
  code_version TEXT NOT NULL,
  query_version TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  last_checked_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','complete','partial','failed','interrupted')),
  lease_fence INTEGER NOT NULL CHECK (lease_fence > 0)
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_status ON discovery_runs(status, started_at);
CREATE TABLE IF NOT EXISTS discovery_query_pages (
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page > 0),
  attempt_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete','failed','uncertain')),
  raw_hits INTEGER NOT NULL CHECK (raw_hits >= 0),
  query_hash TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  stopped_by TEXT CHECK (stopped_by IN ('empty','budget','page_limit','failure')),
  PRIMARY KEY (run_id, query_id, page),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE TABLE IF NOT EXISTS discovery_page_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete','failed','uncertain')),
  http_status INTEGER,
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE TABLE IF NOT EXISTS discovery_url_observations (
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  raw_url TEXT,
  normalized_url TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('malformed','excluded','unsupported','resolved','held')),
  job_id TEXT,
  reason_code TEXT,
  PRIMARY KEY (run_id, query_id, page, ordinal),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_discovery_urls_run_url ON discovery_url_observations(run_id, normalized_url);
CREATE TABLE IF NOT EXISTS discovery_run_items (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('url','resolve','select','fetch','screen','deliver')),
  outcome TEXT NOT NULL,
  at TEXT NOT NULL,
  error_code TEXT,
  detail TEXT,
  PRIMARY KEY (run_id, item_id, stage),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_discovery_run_items_stage ON discovery_run_items(run_id, stage, outcome);
CREATE TABLE IF NOT EXISTS discovery_run_inputs (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opening_delivery','created_delivery','closing_delivery','snapshot_marker')),
  input_id TEXT NOT NULL,
  first_seen_at TEXT,
  PRIMARY KEY (run_id,kind,input_id),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE TABLE IF NOT EXISTS discovery_run_delivery_resolutions (
  run_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('suppressed','delivered')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('user_disposition','delivery_receipt')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id,intent_id),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE TABLE IF NOT EXISTS discovery_delivery_attempts (
  run_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (run_id,intent_id),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);
CREATE TABLE IF NOT EXISTS discovery_health_incidents (
  pipeline TEXT NOT NULL CHECK (pipeline IN ('fixed_boards','unbounded_discovery')),
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','recovered')),
  first_run_id TEXT NOT NULL,
  last_run_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  report_needed INTEGER NOT NULL CHECK (report_needed IN (0,1)),
  PRIMARY KEY (pipeline,fingerprint)
);
