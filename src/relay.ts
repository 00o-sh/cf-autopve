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

/** Everything a delivery needs, small enough to travel as a Queue message. */
export interface RelayJob {
  relay: string;
  history_id: number | null;
  payload: unknown;
  raw_body: string;
}

/** Queue messages are capped at 128 KB; leave room for the envelope. */
export const MAX_QUEUED_JOB_BYTES = 100 * 1024;

/** Backoff before queued attempt n+1, after attempt n failed. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 10 * 2 ** Math.max(0, attempt - 1));
}

async function buildRequest(env: Env, relay: RelayRecord, payload: unknown, rawBody: string): Promise<{ headers: Headers; body: string }> {
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
  return { headers, body };
}

/**
 * What a failed fetch is shown as (relay log, test button). A fixed sentence
 * per kind of failure, never the error itself: the full error goes to the logs.
 */
export function fetchFailure(err: unknown, timeoutMs: number): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `no response within ${timeoutMs} ms`;
  if (name === "TypeError") return "could not connect (DNS, TLS or connection refused)";
  return "request failed; the details are in the Worker logs";
}

/** One attempt, logged. The signature is recomputed per attempt so its timestamp stays fresh. */
export async function deliverOnce(
  env: Env, relay: RelayRecord, payload: unknown, rawBody: string, historyId: number | null, attempt: number,
): Promise<DeliveryResult> {
  const { headers, body } = await buildRequest(env, relay, payload, rawBody);
  let result: DeliveryResult;
  try {
    const res = await fetch(relay.url, { method: relay.method, headers, body, signal: AbortSignal.timeout(relay.timeout_ms) });
    const text = (await res.text()).slice(0, 2048);
    result = { ok: res.ok, status: res.status, error: res.ok ? "" : `HTTP ${res.status}`, response: text, attempts: attempt };
  } catch (err) {
    console.error(`relay ${relay.name} delivery failed:`, err);
    result = { ok: false, status: null, error: fetchFailure(err, relay.timeout_ms), response: "", attempts: attempt };
  }
  await logDelivery(env, relay.name, historyId, result);
  return result;
}

/**
 * Background work after a response gets about 30 seconds (ctx.waitUntil),
 * after which it is cancelled without a trace. Inline delivery therefore
 * only starts an attempt that can finish inside this budget, and says so
 * when it runs out instead of vanishing. Bind RELAY_QUEUE for retries that
 * survive past it.
 */
export const INLINE_BUDGET_MS = 25_000;

/**
 * Deliver with retries inside the current invocation: the "Send test"
 * button, and /hook when no RELAY_QUEUE is bound.
 */
export async function deliver(
  env: Env, relay: RelayRecord, payload: unknown, rawBody: string, historyId: number | null,
  budgetMs = INLINE_BUDGET_MS,
): Promise<DeliveryResult> {
  const deadline = Date.now() + budgetMs;
  let last: DeliveryResult = { ok: false, status: null, error: "not attempted", response: "", attempts: 0 };
  for (let attempt = 1; attempt <= relay.retries + 1; attempt++) {
    const pause = attempt > 1 ? 500 * (attempt - 1) : 0;
    if (Date.now() + pause + relay.timeout_ms > deadline) {
      last = {
        ...last,
        error: `${last.error ? last.error + "; " : ""}stopped after ${attempt - 1} attempt(s): no time left for another ` +
          `${relay.timeout_ms / 1000}s attempt. Bind RELAY_QUEUE for durable retries.`,
      };
      await logDelivery(env, relay.name, historyId, { ...last, attempts: attempt - 1 });
      break;
    }
    if (pause) await new Promise((r) => setTimeout(r, pause));
    last = await deliverOnce(env, relay, payload, rawBody, historyId, attempt);
    if (last.ok) break;
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

/* ------------------------------------------------------------------ *
 * Queue consumer
 * ------------------------------------------------------------------ */

async function setHistoryOutcome(env: Env, id: number | null, outcome: string, detail: string): Promise<void> {
  if (id === null) return;
  await env.DB.prepare("UPDATE history SET outcome = ?, detail = ? WHERE id = ?").bind(outcome, detail, id).run();
}

/**
 * One attempt per message per invocation. A failure is retried by the queue
 * after retryDelaySeconds(), up to the relay's own `retries`; the queue's
 * max_retries only has to be at least the largest allowed value (5). The
 * relay is looked up again on every attempt, so disabling or fixing it takes
 * effect for deliveries already in flight.
 */
export async function handleRelayBatch(batch: MessageBatch<RelayJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      const relay = await getRelay(env, job.relay);
      if (!relay || !relay.enabled) {
        await setHistoryOutcome(env, job.history_id, "error", `-> ${job.relay} dropped: the relay was deleted or disabled`);
        msg.ack();
        continue;
      }
      const result = await deliverOnce(env, relay, job.payload, job.raw_body, job.history_id, msg.attempts);
      if (result.ok) {
        await setHistoryOutcome(env, job.history_id, "relayed", `-> ${relay.name} (HTTP ${result.status}, attempt ${msg.attempts})`);
        msg.ack();
      } else if (msg.attempts <= relay.retries) {
        const delay = retryDelaySeconds(msg.attempts);
        await setHistoryOutcome(
          env, job.history_id, "retrying",
          `-> ${relay.name}: ${result.error}; retry ${msg.attempts} of ${relay.retries} in ${delay}s`,
        );
        msg.retry({ delaySeconds: delay });
      } else {
        await setHistoryOutcome(env, job.history_id, "error", `-> ${relay.name} failed after ${msg.attempts} attempt(s): ${result.error}`);
        msg.ack();
      }
    } catch (err) {
      // Our own failure (D1 hiccup and the like), not the target's: try again shortly.
      console.error("relay consumer:", err);
      msg.retry({ delaySeconds: 30 });
    }
  }
}
