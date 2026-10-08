-- Additive D3 queue. It does not change jobs or application state.
CREATE TABLE IF NOT EXISTS discovery_candidates (
  pipeline TEXT NOT NULL CHECK (pipeline IN ('fixed_boards','unbounded_discovery')),
  candidate_key TEXT NOT NULL,
  original_url TEXT NOT NULL,
  current_url TEXT NOT NULL,
  canonical_job_id TEXT,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_run_id TEXT NOT NULL,
  last_seen_run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  resolution_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','retry_wait','held','complete')),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  failure_category TEXT,
  merged_owner_key TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_run_id TEXT,
  claim_fence INTEGER,
  PRIMARY KEY (pipeline,candidate_key)
);
CREATE INDEX IF NOT EXISTS idx_discovery_candidates_due ON discovery_candidates(pipeline,status,next_attempt_at,discovered_at);
CREATE INDEX IF NOT EXISTS idx_discovery_candidates_job ON discovery_candidates(pipeline,canonical_job_id);
CREATE TABLE IF NOT EXISTS discovery_candidate_url_owners (
  pipeline TEXT NOT NULL,
  url_key TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  PRIMARY KEY (pipeline,url_key)
);
CREATE TABLE IF NOT EXISTS discovery_candidate_claim_budgets (
  pipeline TEXT NOT NULL,
  run_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  total_limit INTEGER NOT NULL,
  due_retry_limit INTEGER NOT NULL,
  PRIMARY KEY (pipeline,run_id,fence)
);
CREATE TABLE IF NOT EXISTS discovery_run_candidate_inputs (
  run_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  original_url TEXT NOT NULL,
  canonical_job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('current','carryover','due_retry')),
  observed_this_run INTEGER NOT NULL CHECK (observed_this_run IN (0,1)),
  observed_at TEXT NOT NULL,
  status_at_claim TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at_at_claim INTEGER NOT NULL DEFAULT 0,
  failure_category_at_claim TEXT,
  claim_selected INTEGER NOT NULL DEFAULT 1 CHECK (claim_selected IN (0,1)),
  PRIMARY KEY (run_id,candidate_key)
);
