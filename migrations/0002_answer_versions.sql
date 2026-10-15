-- Every saved state of an answer, for diff and restore.

CREATE TABLE IF NOT EXISTS answer_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,              -- answer name (follows renames)
  snapshot    TEXT NOT NULL,              -- JSON {doc, priority, serve_mode, allow_cidrs, notes}; credentials stay enc:v1:...
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT ''    -- save | create | copy from X | restore of #N | ...
);

CREATE INDEX IF NOT EXISTS answer_versions_name ON answer_versions (name, id);
