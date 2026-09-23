import type { Env } from "./env";
import { num } from "./env";

export async function audit(env: Env, actor: string, action: string, target = "", detail = ""): Promise<void> {
  await env.DB.prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), actor, action, target, detail)
    .run();
}

export interface HistoryRow {
  id?: number;
  ts: number;
  kind: "answer" | "hook";
  answer: string | null;
  system_name: string;
  ip: string;
  outcome: string;
  detail: string;
  response: string;
  system_info: string;
}

export async function addHistory(env: Env, row: HistoryRow): Promise<number> {
  const maxInfo = num(env.HISTORY_MAX_BYTES, 131072);
  const info = row.system_info.length > maxInfo ? row.system_info.slice(0, maxInfo) : row.system_info;
  const res = await env.DB.prepare(
    "INSERT INTO history (ts, kind, answer, system_name, ip, outcome, detail, response, system_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.ts, row.kind, row.answer, row.system_name, row.ip, row.outcome, row.detail, row.response, info)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

/** Keep the history table bounded, the way the upstream in-memory list was. */
export async function trimHistory(env: Env): Promise<void> {
  const limit = num(env.HISTORY_LIMIT, 1000);
  await env.DB.prepare(
    "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY ts DESC LIMIT ?)",
  )
    .bind(limit)
    .run();
}

/**
 * Remember the distinct "key":"value" pairs seen in installer payloads so the
 * filter editor can offer them as match candidates (upstream's
 * `unique_system_information`).
 */
export async function recordSysinfoKeys(env: Env, systemInfoRaw: string): Promise<void> {
  const matches = systemInfoRaw.match(/"[^"]+"\s*:\s*("[^"]*"|\d+|true|false)/g) || [];
  const uniq = [...new Set(matches)].slice(0, 200);
  if (uniq.length === 0) return;
  const now = Date.now();
  const stmt = env.DB.prepare("INSERT INTO sysinfo_keys (k, last_seen) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET last_seen = excluded.last_seen");
  await env.DB.batch(uniq.map((k) => stmt.bind(k, now)));
}

/** Fixed-window per-IP rate limit, stored in D1 so it needs no extra binding. */
export async function rateLimited(env: Env, ip: string, bucketName: string): Promise<boolean> {
  const limit = num(env.RATE_LIMIT_PER_MIN, 30);
  if (limit === 0 || !ip) return false;
  const window = Math.floor(Date.now() / 60000);
  const key = `rl:${bucketName}:${ip}:${window}`;
  const res = await env.DB.prepare(
    "INSERT INTO settings (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) RETURNING v",
  )
    .bind(key)
    .first<{ v: string }>();
  const count = Number(res?.v ?? 1);
  if (count === 1) {
    // Opportunistic cleanup of previous windows; cheap and keeps the table small.
    await env.DB.prepare("DELETE FROM settings WHERE k LIKE 'rl:%' AND k NOT LIKE ?").bind(`rl:%:${window}`).run();
  }
  return count > limit;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = ?").bind(key).first<{ v: string }>();
  return row?.v ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(key, value).run();
}
