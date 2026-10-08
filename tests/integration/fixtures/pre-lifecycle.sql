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
  discovery_source TEXT NOT NULL DEFAULT 'fixed_board'  -- 'fixed_board' | 'unbounded_search' | 'manual_add'
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

-- Every application and decision, wherever it lives. A known_applications
-- row owns its application. A jobs row owns one only when no
-- known_applications row mirrors it (is_known_application = 0); the
-- mirrored ones would otherwise be counted twice.
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
    LIMIT 1) AS job_id
FROM known_applications ka
UNION ALL
SELECT
  'jobs', j.id, j.company, j.title, j.application_status, j.application_status_updated_at,
  'pipeline', NULL, j.url, NULL, NULL, j.id
FROM jobs j
WHERE j.application_status <> 'not_applied' AND j.is_known_application = 0;
