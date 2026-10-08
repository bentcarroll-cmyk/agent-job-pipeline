-- Additive M1 inbox and manual delivery receipts. No existing job or application rows are rewritten.
CREATE TABLE IF NOT EXISTS manual_intake_requests (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  input_url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','resolving','fetching','saved','screening','ready','delivering','delivered','already_tracked','retry_wait','held','delivery_unknown')),
  stage TEXT NOT NULL CHECK (stage IN ('resolve','fetch','save','screen','deliver')),
  job_id TEXT,
  owner_request_id TEXT,
  workflow_generation INTEGER NOT NULL DEFAULT 0 CHECK (workflow_generation >= 0),
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  resolution_json TEXT,
  posting_json TEXT,
  advisory_json TEXT,
  failure_code TEXT,
  failure_detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_manual_intake_due ON manual_intake_requests(state,next_attempt_at,id);
CREATE TABLE IF NOT EXISTS manual_intake_jobs (
  job_id TEXT PRIMARY KEY,
  owner_request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_intake_deliveries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','delivered','retry_wait','unknown','cancelled','held')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  attempted_at TEXT,
  updated_at TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  message_ts TEXT,
  failure_code TEXT,
  attempts_json TEXT NOT NULL DEFAULT '[]'
);
