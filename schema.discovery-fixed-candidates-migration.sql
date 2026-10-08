-- Apply once after schema.discovery-candidates-migration.sql when upgrading an
-- existing D3 candidate table. Check PRAGMA table_info(discovery_candidates)
-- first; schema.sql already includes this column for fresh databases.
ALTER TABLE discovery_candidates ADD COLUMN fixed_context_json TEXT;
-- Older fixed rows cannot be replayed without a listing snapshot. Keep them
-- inspectable until a fresh board observation supplies that context.
UPDATE discovery_candidates
SET status='held', failure_category='missing_fixed_context',
    next_attempt_at=0, claim_run_id=NULL, claim_fence=NULL
WHERE pipeline='fixed_boards' AND fixed_context_json IS NULL
  AND status IN ('pending','claimed','retry_wait');
