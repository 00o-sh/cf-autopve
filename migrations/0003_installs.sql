-- One row per machine: where its latest install got to.

CREATE TABLE IF NOT EXISTS installs (
  machine_id   TEXT PRIMARY KEY,            -- uuid:<dmi uuid> | serial:<serial> | mac:<lowest mac>
  system_name  TEXT NOT NULL DEFAULT '',
  answer       TEXT,                         -- answer served (or refused) to it
  status       TEXT NOT NULL,                -- served | refused | installed
  detail       TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  fqdn         TEXT NOT NULL DEFAULT '',     -- from the post-installation webhook
  macs         TEXT NOT NULL DEFAULT '[]',   -- JSON array, lower case
  first_seen   INTEGER NOT NULL,
  served_at    INTEGER,
  installed_at INTEGER,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS installs_updated ON installs (updated_at);
