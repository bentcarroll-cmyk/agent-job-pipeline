-- D1 query page replay. Public result titles and scrubbed URLs are bounded;
-- this is separate from the provider response and never stores credentials.
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
