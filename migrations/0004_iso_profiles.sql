-- Saved build-iso.sh settings, one per network, so the configurator can hand out a ready one-liner.

CREATE TABLE IF NOT EXISTS iso_profiles (
  name           TEXT PRIMARY KEY,
  version        TEXT NOT NULL DEFAULT '',   -- PVE release, e.g. 9.2-1; empty means the newest
  boot_range     TEXT NOT NULL DEFAULT '',   -- START-END/PREFIX; empty means the network has DHCP
  boot_gateway   TEXT NOT NULL DEFAULT '',
  boot_dns       TEXT NOT NULL DEFAULT '',   -- comma-separated; empty means the gateway
  notes          TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT NOT NULL DEFAULT ''
);
