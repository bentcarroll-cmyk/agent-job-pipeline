-- Add application identity and timing fields before importing selected records.
-- ALTER statements are not idempotent; use the setup migration receipt protocol.
ALTER TABLE known_applications ADD COLUMN posting_url TEXT;
ALTER TABLE known_applications ADD COLUMN requisition_id TEXT;
ALTER TABLE known_applications ADD COLUMN applied_at TEXT;

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
