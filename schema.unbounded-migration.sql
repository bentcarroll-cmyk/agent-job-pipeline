-- Upgrade an owned database to shared fixed-board and open-discovery state.
-- Fresh databases already include these objects in schema.sql.
-- Both Workers require these columns before their code is activated.
-- ALTER statements are not idempotent. Use the setup migration receipts and
-- transactional batches; do not bypass an uncertain or mismatched receipt.

CREATE TABLE IF NOT EXISTS search_rotation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_phrase_index INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE jobs ADD COLUMN discovery_source TEXT NOT NULL DEFAULT 'fixed_board';
ALTER TABLE pipeline_runs ADD COLUMN worker TEXT NOT NULL DEFAULT 'fixed_boards';
