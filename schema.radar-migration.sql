-- Additive: the AI radar's posts, author adjustments and runs. No existing table changes.
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
