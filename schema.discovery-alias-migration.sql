-- Additive D2 alias ownership. Apply only after an authorized export and schema review.
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
