-- Copied from agentdock-cli packages/storage/src/db.ts at commit d8f5149: the initSchema tables,
-- plus the index the daemon builds at start (ensureEventsCreatedAtIndex). Change it there, then copy it again.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  project_path TEXT NOT NULL,
  git_branch TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  head_commit_sha TEXT,
  spec_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS specifications (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  overview TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence_num INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  tool_input_json TEXT,
  tool_output_json TEXT,
  is_blob_stored INTEGER NOT NULL DEFAULT 0,
  policy_verdict TEXT,
  policy_reason TEXT,
  execution_duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  rule_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence_num);

CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  unknown_model INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, model)
);

CREATE TABLE IF NOT EXISTS file_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id),
  file_path TEXT NOT NULL,
  is_test_file INTEGER NOT NULL DEFAULT 0,
  change_type TEXT NOT NULL,
  diff_unified TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  spec_hash TEXT NOT NULL,
  git_commit_sha TEXT NOT NULL,
  overall_status TEXT NOT NULL,
  deterministic_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evidence_json TEXT,
  associated_test_file TEXT,
  rationale TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_kind_time ON context_entries(kind, created_at);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, tags, content='memory', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, body, tags) VALUES (new.id, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, body, tags) VALUES ('delete', old.id, old.body, old.tags);
END;

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
