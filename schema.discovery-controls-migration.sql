-- Additive operational state only. Existing job/application/lifecycle rows are untouched.
CREATE TABLE IF NOT EXISTS discovery_run_leases (
  pipeline TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_retries (
  pipeline TEXT NOT NULL,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  last_run_id TEXT NOT NULL,
  last_error TEXT NOT NULL,
  failed_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (pipeline, job_id)
);
CREATE INDEX IF NOT EXISTS idx_discovery_retries_due ON discovery_retries(pipeline, next_attempt_at);
