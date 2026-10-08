-- Additive release provenance. Do not backfill historic migrations from guesses.
-- Record an exact migration hash and reviewed source commit only after readback.
CREATE TABLE IF NOT EXISTS schema_release_receipts (
  migration_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  source_commit TEXT NOT NULL CHECK (length(source_commit) = 40),
  applied_at TEXT NOT NULL
);
