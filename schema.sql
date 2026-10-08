CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,                          -- stable ATS posting identity
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT,
  department TEXT,
  is_remote INTEGER,                            -- 0/1/NULL
  employment_type TEXT,
  posted_at TEXT,
  compensation TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,                   -- bumped every run the posting still appears; a stale last_seen_at means it's likely been taken down
  is_known_application INTEGER NOT NULL DEFAULT 0,
  known_application_source TEXT,                -- traces the selected source record
  match INTEGER,                                -- NULL = never evaluated (baseline/duplicate), 0/1 = GLM verdict
  match_lane TEXT,                              -- 'A' | 'B' | NULL
  match_hard_exclude TEXT,
  match_reason TEXT,
  notified_at TEXT,
  application_status TEXT NOT NULL DEFAULT 'not_applied',
  -- 'not_applied' | 'needs_materials' | 'materials_ready' | 'applied'
  -- | 'interviewing' | 'offer' | 'closed' | 'passed' | 'posting_closed'
  -- and, on rows mirroring an imported application, 'new' | 'packet_ready'
  -- | 'not_pursuing'
  --
  -- posting_closed: wanted, but the posting was gone by the time materials
  -- were generated. Distinct from 'passed' (judged and declined) and from a
  -- tombstone (died before anyone wanted it). It is the only status that
  -- measures the process rather than the job: a rising count means
  -- time-to-apply is too slow.

  -- 'pipeline' | 'import' | 'manual' | 'lifecycle_email' | 'materials'
  application_status_source TEXT NOT NULL DEFAULT 'pipeline',
  application_status_updated_at TEXT,
  discovery_source TEXT NOT NULL DEFAULT 'fixed_board', -- 'fixed_board' | 'unbounded_search' | 'manual_add'
  criteria_version TEXT                         -- NULL = unknown historical policy, stale for delivery
);

CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_match ON jobs(match);
CREATE INDEX IF NOT EXISTS idx_jobs_application_status ON jobs(application_status);

-- Application ledger independent of the currently configured discovery boards.
-- A nullable canonical ATS ID supports matching when explicit URL evidence exists.
-- Mirrored jobs rows refer to this owner without duplicating application state.
CREATE TABLE IF NOT EXISTS known_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_id TEXT,
  employer TEXT,
  title TEXT,
  status TEXT,
  source TEXT,                                  -- 'codex_pipeline' | 'linear_legacy' | 'aiapply' | 'lifecycle_email'
  source_job_id TEXT,                           -- selected source record identifier, when applicable
  status_updated_at TEXT,                       -- when the status took effect, from its evidence
  status_source TEXT NOT NULL DEFAULT 'initial_import',  -- 'initial_import' | 'ledger_import' | 'lifecycle_email'
  posting_url TEXT,
  requisition_id TEXT,
  applied_at TEXT                               -- explicit application date, when known
);
CREATE INDEX IF NOT EXISTS idx_known_applications_canonical_id ON known_applications(canonical_id);
CREATE INDEX IF NOT EXISTS idx_known_applications_employer ON known_applications(employer);

-- Single-row table tracking how far back the lifecycle tracker has already
-- searched Gmail, so each run only scans new mail.
CREATE TABLE IF NOT EXISTS lifecycle_checkpoints (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_checked_at TEXT NOT NULL
);

-- One row per pipeline run, preserving aggregate counts for operational review.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  sources_ok INTEGER NOT NULL,
  sources_failed INTEGER NOT NULL,
  new_postings INTEGER NOT NULL,
  already_applied_skipped INTEGER NOT NULL,
  matches INTEGER NOT NULL,
  errors TEXT,                                  -- JSON array of error strings, '[]' if none
  worker TEXT NOT NULL DEFAULT 'fixed_boards'    -- 'fixed_boards' | 'unbounded_discovery'
);

-- Single-row cursor into discovery.ts's PHRASE_BANK, so each run's search
-- surface rotates instead of re-querying the same phrases forever.
CREATE TABLE IF NOT EXISTS search_rotation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_phrase_index INTEGER NOT NULL DEFAULT 0
);

-- One row per Gmail message the tracker has handled. Never holds a body:
-- `evidence` is "YYYY-MM-DD · sender · subject".
CREATE TABLE IF NOT EXISTS lifecycle_receipts (
  gmail_message_id TEXT PRIMARY KEY,
  gmail_thread_id TEXT,
  received_at TEXT NOT NULL,
  evidence TEXT NOT NULL,
  event TEXT,
  employer TEXT,
  title TEXT,
  requisition_id TEXT,
  round_stage TEXT,
  scheduled_for TEXT,
  -- 'applied' | 'unchanged' | 'scheduled' | 'question' | 'answered' | 'ignored'
  -- (includes undone) | 'not_job' | 'fyi' | 'failed' | 'retry'
  decision TEXT NOT NULL,
  owner_table TEXT,
  owner_id TEXT,
  question_id TEXT,
  question_json TEXT,
  answer TEXT,
  change_json TEXT,       -- what changed, for the Slack line
  before_json TEXT,       -- the row before the change, so Undo is exact
  attempts INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  announced_at TEXT,
  slack_ts TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_receipts_announced ON lifecycle_receipts(announced_at);

-- One row per interview invitation. The status stays 'interviewing'; this
-- records how far along it is.
CREATE TABLE IF NOT EXISTS interview_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  stage TEXT,             -- 'recruiter_screen' | 'hiring_manager' | 'panel' | 'final' | 'assessment' | 'other'
  invited_at TEXT NOT NULL,
  scheduled_for TEXT,
  gmail_thread_id TEXT,
  gmail_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_rounds_owner ON interview_rounds(owner_table, owner_id);

-- Every application and decision, wherever it lives. A known_applications
-- row owns its application. A jobs row owns one only when no
-- known_applications row mirrors it (is_known_application = 0); the
-- mirrored ones would otherwise be counted twice. interview_round is the
-- application's highest round, or null.
DROP VIEW IF EXISTS applications;
CREATE VIEW applications AS
SELECT
  'known_applications' AS owner_table,
  CAST(ka.id AS TEXT) AS owner_id,
  ka.employer AS employer,
  ka.title AS title,
  ka.status AS status,
  ka.status_updated_at AS status_updated_at,
  ka.source AS source,
  ka.source_job_id AS source_job_id,
  ka.posting_url AS posting_url,
  ka.requisition_id AS requisition_id,
  ka.applied_at AS applied_at,
  (SELECT j.id FROM jobs j
    WHERE ka.source_job_id IS NOT NULL AND j.known_application_source = ka.source_job_id
    LIMIT 1) AS job_id,
  (SELECT MAX(r.round) FROM interview_rounds r
    WHERE r.owner_table = 'known_applications' AND r.owner_id = CAST(ka.id AS TEXT)) AS interview_round
FROM known_applications ka
UNION ALL
SELECT
  'jobs', j.id, j.company, j.title, j.application_status, j.application_status_updated_at,
  'pipeline', NULL, j.url, NULL, NULL, j.id,
  (SELECT MAX(r.round) FROM interview_rounds r WHERE r.owner_table = 'jobs' AND r.owner_id = j.id)
FROM jobs j
WHERE j.application_status <> 'not_applied' AND j.is_known_application = 0;

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

-- Additive screening state only. Historical job rows remain unknown evidence.
-- Application status, Gmail records and the existing delivery backlog are untouched.
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

-- D0 search accounting. These records supplement legacy pipeline_runs without
-- changing its historical, pipeline-specific column meanings.
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

-- D1 query page replay rows preserve scrubbed provider hits for a completed
-- page whose Workflow output checkpoint is unavailable.
CREATE TABLE IF NOT EXISTS discovery_query_page_results (
  run_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  observed_url TEXT,
  title TEXT NOT NULL CHECK (length(title) <= 500),
  PRIMARY KEY (run_id,query_id,page,ordinal),
  FOREIGN KEY (run_id) REFERENCES discovery_runs(run_id)
);

CREATE TABLE IF NOT EXISTS discovery_job_owners (
  employer_key TEXT NOT NULL,
  requisition_key TEXT NOT NULL,
  requisition_id TEXT NOT NULL,
  owner_job_id TEXT NOT NULL,
  PRIMARY KEY (employer_key,requisition_key)
);
CREATE TABLE IF NOT EXISTS discovery_job_aliases (
  alias TEXT PRIMARY KEY,
  owner_job_id TEXT NOT NULL,
  employer_key TEXT NOT NULL,
  requisition_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_alias_owner ON discovery_job_aliases(owner_job_id);

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
  fixed_context_json TEXT,
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

-- Exact release receipts only; absence says historical application is unknown.
CREATE TABLE IF NOT EXISTS schema_release_receipts (
  migration_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  source_commit TEXT NOT NULL CHECK (length(source_commit) = 40),
  applied_at TEXT NOT NULL
);

-- AI radar (src/radar/). Migration: schema.radar-migration.sql.
CREATE TABLE IF NOT EXISTS radar_posts (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_name TEXT,
  author_bio TEXT,
  author_followers INTEGER,
  author_created_at TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  quoted_id TEXT,
  quoted_text TEXT,
  conversation_id TEXT,
  metrics_json TEXT NOT NULL,
  found_by TEXT NOT NULL,
  first_seen_run TEXT NOT NULL,
  triage_state TEXT NOT NULL DEFAULT 'pending' CHECK (triage_state IN ('pending','done','failed')),
  kind TEXT CHECK (kind IN ('development','debate','practice','hiring','noise')),
  topic TEXT,
  score INTEGER CHECK (score BETWEEN 0 AND 3),
  reason TEXT,
  digest_date TEXT,
  feedback TEXT CHECK (feedback IN ('useful','not_useful','mute')),
  feedback_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_posts_run ON radar_posts(first_seen_run);
CREATE INDEX IF NOT EXISTS idx_radar_posts_author ON radar_posts(author_handle);
CREATE INDEX IF NOT EXISTS idx_radar_posts_digest ON radar_posts(digest_date);
CREATE INDEX IF NOT EXISTS idx_radar_posts_feedback ON radar_posts(feedback_at);
CREATE TABLE IF NOT EXISTS radar_authors (
  handle TEXT PRIMARY KEY,
  boost REAL NOT NULL DEFAULT 0 CHECK (boost BETWEEN -1 AND 1),
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS radar_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  since_time TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','posted','notice','failed')),
  collect_ok INTEGER NOT NULL DEFAULT 0 CHECK (collect_ok IN (0,1)),
  posts_read INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  cut_short TEXT,
  triage_batches INTEGER NOT NULL DEFAULT 0,
  triage_failed INTEGER NOT NULL DEFAULT 0,
  editor_input_tokens INTEGER,
  editor_output_tokens INTEGER,
  editor_fallback INTEGER NOT NULL DEFAULT 0 CHECK (editor_fallback IN (0,1)),
  errors TEXT,
  digest_json TEXT,
  slack_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_runs_started ON radar_runs(started_at);

-- Immutable per-run policy and independently activated per-instance policy.
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

-- Fixed-board baseline completion is scoped independently of shared jobs.
CREATE TABLE IF NOT EXISTS fixed_baselines (
  instance_id TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, sources_json)
);
