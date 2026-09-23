/**
 * Outbound webhook relay — the replacement for upstream's ansible-playbook
 * execution. A Worker has no shell and no long-lived process, so instead of
 * running a playbook here, the installer's post-installation payload is
 * forwarded (optionally reshaped and signed) to whatever does have a shell:
 * AWX/Tower, a GitHub/GitLab pipeline, n8n, a self-hosted runner behind a
 * Cloudflare Tunnel.
 */

import type { Env } from "./env";
import { decryptString, encryptString, hmacSha256Hex, isEncrypted } from "./crypto";

export interface RelayRecord {
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  hmac_secret: string;
  body_template: string;
  enabled: boolean;
  timeout_ms: number;
  retries: number;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

interface RelayRow {
  name: string; url: string; method: string; headers: string; hmac_secret: string;
  body_template: string; enabled: number; timeout_ms: number; retries: number;
  created_at: number; updated_at: number; updated_by: string;
}

export class RelayError extends Error {
  status = 400;
}

function rowToRecord(row: RelayRow): RelayRecord {
  let headers: Record<string, string> = {};
  try { headers = JSON.parse(row.headers); } catch { headers = {}; }
  return { ...row, headers, enabled: !!row.enabled };
}

export async function listRelays(env: Env): Promise<RelayRecord[]> {
  const res = await env.DB.prepare("SELECT * FROM relays ORDER BY name ASC").all<RelayRow>();
  return (res.results || []).map(rowToRecord);
}

export async function getRelay(env: Env, name: string): Promise<RelayRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM relays WHERE name = ?").bind(name).first<RelayRow>();
  return row ? rowToRecord(row) : null;
}

const BLOCKED_HOSTS = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[?::1\]?)$/i;

export function validateRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayError("Relay URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RelayError("Relay URL must use http or https.");
  if (BLOCKED_HOSTS.test(url.hostname)) {
    throw new RelayError(
      `A Worker cannot reach ${url.hostname} — it runs on Cloudflare's edge, not on your LAN. ` +
        "Expose the target publicly or put it behind a Cloudflare Tunnel.",
    );
  }
  return url.toString();
}

export interface RelayInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  hmac_secret?: string;
  body_template?: string;
  enabled?: boolean;
  timeout_ms?: number;
  retries?: number;
}

/** Header values and the HMAC secret are credentials: encrypted at rest. */
async function encryptRelaySecrets(env: Env, headers: Record<string, string>, hmacSecret: string) {
  const needsKey = Object.values(headers).some((v) => v && !isEncrypted(v)) || (hmacSecret && !isEncrypted(hmacSecret));
  if (needsKey && !env.ANSWER_ENC_KEY) {
    throw new RelayError("Set the ANSWER_ENC_KEY secret before storing relay headers or signing secrets.");
  }
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    outHeaders[k] = isEncrypted(v) ? v : await encryptString(v, env.ANSWER_ENC_KEY!);
  }
  const outSecret = !hmacSecret ? "" : isEncrypted(hmacSecret) ? hmacSecret : await encryptString(hmacSecret, env.ANSWER_ENC_KEY!);
  return { headers: outHeaders, hmac_secret: outSecret };
}

export async function saveRelay(env: Env, name: string, input: RelayInput, actor: string): Promise<RelayRecord> {
  const existing = await getRelay(env, name);
  const url = validateRelayUrl(input.url);
  const method = (input.method || "POST").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) throw new RelayError("Relay method must be POST, PUT or PATCH.");

  const mergedHeaders: Record<string, string> = { ...(existing?.headers ?? {}) };
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (v === "") delete mergedHeaders[k];
    else if (v === RELAY_MASK) continue; // unchanged secret header
    else mergedHeaders[k] = v;
  }
  for (const k of Object.keys(mergedHeaders)) {
    if (input.headers && !(k in input.headers)) delete mergedHeaders[k];
  }
  const hmac = input.hmac_secret === RELAY_MASK ? (existing?.hmac_secret ?? "") : (input.hmac_secret ?? "");
  const enc = await encryptRelaySecrets(env, mergedHeaders, hmac);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO relays (name, url, method, headers, hmac_secret, body_template, enabled, timeout_ms, retries, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET url = excluded.url, method = excluded.method, headers = excluded.headers,
       hmac_secret = excluded.hmac_secret, body_template = excluded.body_template, enabled = excluded.enabled,
       timeout_ms = excluded.timeout_ms, retries = excluded.retries, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(
      name, url, method, JSON.stringify(enc.headers), enc.hmac_secret,
      input.body_template ?? existing?.body_template ?? "",
      (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      Math.min(30000, Math.max(1000, input.timeout_ms ?? existing?.timeout_ms ?? 10000)),
      Math.min(5, Math.max(0, input.retries ?? existing?.retries ?? 2)),
      existing?.created_at ?? now, now, actor,
    )
    .run();
  return (await getRelay(env, name))!;
}

export const RELAY_MASK = "__autopve_secret_set__";

/** Relay as the UI should see it: secrets replaced by a marker. */
export function maskRelay(relay: RelayRecord): RelayRecord {
  const headers: Record<string, string> = {};
  for (const k of Object.keys(relay.headers)) headers[k] = RELAY_MASK;
  return { ...relay, headers, hmac_secret: relay.hmac_secret ? RELAY_MASK : "" };
}

export async function deleteRelay(env: Env, name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM relays WHERE name = ?").bind(name).run();
}

/* ------------------------------------------------------------------ *
 * Templating
 * ------------------------------------------------------------------ */

function lookup(context: any, path: string): unknown {
  let cur = context;
  for (const rawSeg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    const seg = rawSeg.trim();
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else cur = cur[seg];
  }
  return cur;
}

/**
 * `{{ system_info.product.version }}` style substitution. Objects and arrays
 * are inserted as JSON, strings are JSON-escaped so the result stays valid JSON
 * when the template is a JSON body.
 */
export function renderTemplate(template: string, context: any): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.\-\[\]]+)\s*\}\}/g, (_m, path: string) => {
    const value = lookup(context, path.replace(/\[(\d+)\]/g, ".$1"));
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return JSON.stringify(value).slice(1, -1);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  });
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string;
  response: string;
  attempts: number;
}

/**
 * Deliver one payload to one relay target, with retries. Called from
 * ctx.waitUntil so the installer is not kept waiting on the target.
 */
export async function deliver(env: Env, relay: RelayRecord, payload: any, rawBody: string, historyId: number | null): Promise<DeliveryResult> {
  const context = { system_info: payload, relay: relay.name, now: new Date().toISOString() };
  const body = relay.body_template.trim() ? renderTemplate(relay.body_template, context) : rawBody;

  const headers = new Headers({ "Content-Type": "application/json", "User-Agent": "cf-autopve-relay/1.0" });
  for (const [k, v] of Object.entries(relay.headers)) {
    try {
      headers.set(k, isEncrypted(v) && env.ANSWER_ENC_KEY ? await decryptString(v, env.ANSWER_ENC_KEY) : v);
    } catch {
      // A header we cannot decrypt is dropped rather than sent as ciphertext.
    }
  }
  if (relay.hmac_secret && env.ANSWER_ENC_KEY) {
    const secret = await decryptString(relay.hmac_secret, env.ANSWER_ENC_KEY);
    const ts = Math.floor(Date.now() / 1000).toString();
    headers.set("X-AutoPVE-Timestamp", ts);
    headers.set("X-AutoPVE-Signature", `sha256=${await hmacSha256Hex(secret, `${ts}.${body}`)}`);
  }

  let last: DeliveryResult = { ok: false, status: null, error: "not attempted", response: "", attempts: 0 };
  for (let attempt = 1; attempt <= relay.retries + 1; attempt++) {
    last.attempts = attempt;
    try {
      const res = await fetch(relay.url, {
        method: relay.method,
        headers,
        body,
        signal: AbortSignal.timeout(relay.timeout_ms),
      });
      const text = (await res.text()).slice(0, 2048);
      last = { ok: res.ok, status: res.status, error: res.ok ? "" : `HTTP ${res.status}`, response: text, attempts: attempt };
    } catch (err) {
      last = { ok: false, status: null, error: String((err as Error)?.message || err), response: "", attempts: attempt };
    }
    await logDelivery(env, relay.name, historyId, last);
    if (last.ok) break;
    if (attempt <= relay.retries) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return last;
}

async function logDelivery(env: Env, relay: string, historyId: number | null, result: DeliveryResult): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO relay_log (ts, relay, history_id, attempt, status, ok, error, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(Date.now(), relay, historyId, result.attempts, result.status, result.ok ? 1 : 0, result.error, result.response)
    .run();
  await env.DB.prepare("DELETE FROM relay_log WHERE id NOT IN (SELECT id FROM relay_log ORDER BY ts DESC LIMIT 500)").run();
}
