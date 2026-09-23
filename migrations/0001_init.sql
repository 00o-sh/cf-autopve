-- cf-autopve initial schema

CREATE TABLE IF NOT EXISTS answers (
  name             TEXT PRIMARY KEY,
  doc              TEXT NOT NULL DEFAULT '{}',   -- JSON document (secret values stored as enc:v1:...)
  priority         INTEGER NOT NULL DEFAULT 100, -- lower wins when several answers match
  serve_mode       TEXT NOT NULL DEFAULT 'armed',-- off | armed | always
  armed_until      INTEGER,                      -- epoch ms; NULL when not armed
  serves_remaining INTEGER,                      -- NULL = unlimited
  allow_cidrs      TEXT NOT NULL DEFAULT '[]',   -- JSON array of CIDRs / IPs
  secrets_ack      INTEGER NOT NULL DEFAULT 0,   -- operator acknowledged plaintext secret hosting
  has_secrets      INTEGER NOT NULL DEFAULT 0,   -- cached: doc contains secret-classified keys
  notes            TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,              -- answer | hook
  answer       TEXT,                       -- answer name that served the request
  system_name  TEXT NOT NULL DEFAULT '',   -- dmi.system.name
  ip           TEXT NOT NULL DEFAULT '',
  outcome      TEXT NOT NULL,              -- served | denied | relayed | error
  detail       TEXT NOT NULL DEFAULT '',
  response     TEXT NOT NULL DEFAULT '',   -- ALWAYS redacted TOML, never plaintext secrets
  system_info  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS history_ts_idx ON history (ts DESC);
CREATE INDEX IF NOT EXISTS history_answer_idx ON history (answer, ts DESC);

CREATE TABLE IF NOT EXISTS sysinfo_keys (
  k         TEXT PRIMARY KEY,   -- e.g. "dmi.system.name":"PowerEdge R620"
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relays (
  name          TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'POST',
  headers       TEXT NOT NULL DEFAULT '{}',   -- JSON object; values may be enc:v1:...
  hmac_secret   TEXT NOT NULL DEFAULT '',     -- enc:v1:... ; signs the relayed body
  body_template TEXT NOT NULL DEFAULT '',     -- empty = pass the installer payload through verbatim
  enabled       INTEGER NOT NULL DEFAULT 1,
  timeout_ms    INTEGER NOT NULL DEFAULT 10000,
  retries       INTEGER NOT NULL DEFAULT 2,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS relay_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  relay       TEXT NOT NULL,
  history_id  INTEGER,
  attempt     INTEGER NOT NULL DEFAULT 1,
  status      INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT '',
  response    TEXT NOT NULL DEFAULT ''   -- first 2 KiB of the target's response
);
CREATE INDEX IF NOT EXISTS relay_log_ts_idx ON relay_log (ts DESC);

CREATE TABLE IF NOT EXISTS files (
  name         TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  sha256       TEXT NOT NULL DEFAULT '',
  storage      TEXT NOT NULL DEFAULT 'd1',  -- d1 | r2
  blob         BLOB,
  uploaded_at  INTEGER NOT NULL,
  uploaded_by  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit (ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
