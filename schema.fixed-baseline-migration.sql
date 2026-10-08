-- Fixed-board baseline completion is scoped independently of shared jobs.
CREATE TABLE IF NOT EXISTS fixed_baselines (
  instance_id TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, sources_json)
);
