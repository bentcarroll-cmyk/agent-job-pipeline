-- Add lifecycle receipts, interview rounds and the shared application view.
-- Apply through the setup migration receipt protocol for the selected owned database.

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
