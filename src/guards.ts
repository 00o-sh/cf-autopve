/**
 * Guardrails for the public endpoints.
 *
 * The answer endpoint is by definition unauthenticated (the Proxmox installer
 * has no credential to present), so anything an answer holds is readable by
 * whoever can reach the URL while it is being served. These checks are what
 * keep that window small and deliberate:
 *
 *   - serve_mode: off / armed (time- and count-boxed) / always
 *   - per-answer IP or CIDR allowlist
 *   - optional deployment-wide SERVE_TOKEN in the path or a header
 *     (required for /hook: relays are refused while it is unset)
 *   - HTTPS required before any credential leaves the Worker
 *   - per-IP rate limit
 *
 * Every denial is written to history so a probe is visible rather than silent.
 */

import type { Env } from "./env";
import { bool, num } from "./env";
import { timingSafeEqual } from "./crypto";
import { docHasSecrets, type AnswerRecord } from "./answers";
import type { AnswerDoc } from "./toml";

export interface Decision {
  allowed: boolean;
  reason: string;
}

const ALLOW: Decision = { allowed: true, reason: "" };

function deny(reason: string): Decision {
  return { allowed: false, reason };
}

function ipv4ToBig(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(p)) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function ipv6ToBig(ip: string): bigint | null {
  let addr = ip.trim();
  if (addr.includes(".")) {
    // IPv4-mapped form, e.g. ::ffff:192.0.2.1
    const idx = addr.lastIndexOf(":");
    const v4 = ipv4ToBig(addr.slice(idx + 1));
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    addr = `${addr.slice(0, idx + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(fill).fill("0"), ...tail];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

export function ipMatchesCidr(ip: string, rule: string): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  const isV6 = ip.includes(":");
  const [net, bitsRaw] = trimmed.split("/");
  const ruleIsV6 = net.includes(":");
  if (isV6 !== ruleIsV6) return false;
  const width = isV6 ? 128 : 32;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const a = isV6 ? ipv6ToBig(ip) : ipv4ToBig(ip);
  const b = isV6 ? ipv6ToBig(net) : ipv4ToBig(net);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return (a & mask) === (b & mask);
}

/** Rate-limit identity of a client: IPv6 by its /64, since one host usually holds the whole prefix. */
export function rateLimitSubject(ip: string): string {
  if (!ip.includes(":")) return ip;
  const n = ipv6ToBig(ip);
  return n === null ? ip : `${(n >> 64n).toString(16)}::/64`;
}

export function ipAllowed(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;
  if (!ip) return false;
  return cidrs.some((c) => ipMatchesCidr(ip, c));
}

/**
 * When SERVE_TOKEN is set, the installer must present it in one of these:
 *
 *   - Authorization: Bearer <name>:<token>  what `prepare-iso --answer-auth-token
 *     <name>:<token>` makes the installer send (PVE 9.2+); `Bearer <token>` works too
 *   - X-AutoPVE-Token: <token>
 *   - a path segment, POST /answer/<token>, for installers that can only be
 *     given a URL. It ends up in URLs and logs, so prefer the header.
 */
export function tokenOk(env: Env, request: Request, pathToken: string | null): boolean {
  const expected = env.SERVE_TOKEN;
  if (!expected) return true;
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  if (bearer) {
    if (timingSafeEqual(bearer, expected)) return true;
    const colon = bearer.indexOf(":");
    if (colon > 0 && timingSafeEqual(bearer.slice(colon + 1), expected)) return true;
  }
  const header = request.headers.get("X-AutoPVE-Token");
  if (header && timingSafeEqual(header, expected)) return true;
  return !!pathToken && timingSafeEqual(pathToken, expected);
}

export interface ServeContext {
  request: Request;
  ip: string;
  pathToken: string | null;
}

/**
 * `served` is the document the installer would receive (Default merged with the
 * answer). Whether it carries credentials is judged from it with the current
 * classifier: the cached has_secrets column misses credentials inherited from
 * Default and keys that became secret-classified after the row was saved.
 */
export function canServe(env: Env, record: AnswerRecord, ctx: ServeContext, served: AnswerDoc = record.doc): Decision {
  const now = Date.now();
  const url = new URL(ctx.request.url);
  const secure = url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (!tokenOk(env, ctx.request, ctx.pathToken)) return deny("serve token missing or incorrect");
  if (record.serve_mode === "off") return deny(`answer "${record.name}" is not being served (serve mode: off)`);
  if (!ipAllowed(ctx.ip, record.allow_cidrs)) return deny(`client ${ctx.ip || "(unknown)"} is not in the allowlist for "${record.name}"`);

  if (record.has_secrets || docHasSecrets(served)) {
    if (!record.secrets_ack) return deny(`answer "${record.name}" holds credentials that have not been acknowledged for hosting`);
    if (bool(env.REQUIRE_HTTPS, true) && !secure) return deny("refusing to serve credentials over plain HTTP");
    if (record.serve_mode === "always" && !bool(env.ALLOW_ALWAYS_SECRETS)) {
      return deny(`answer "${record.name}" holds credentials and may not be served in "always" mode`);
    }
  }

  if (record.serve_mode === "armed") {
    // Checked before the window so an exhausted budget reports the real reason.
    if (record.serves_remaining !== null && record.serves_remaining <= 0) {
      return deny(`answer "${record.name}" has used up its allowed number of serves — re-arm it to serve again`);
    }
    if (!record.armed_until || record.armed_until < now) {
      return deny(`answer "${record.name}" is disarmed — arm it in the configurator for the length of the install`);
    }
  }
  return ALLOW;
}

/**
 * Claim one serve of an armed answer, atomically, before anything is
 * decrypted. canServe() works from a snapshot read at the start of the
 * request, so on its own it lets N concurrent requests all see "1 serve left"
 * and all be served. The conditional UPDATE re-checks the arm window and the
 * budget in the same statement that spends it: exactly as many requests win as
 * there were serves, and the last one disarms the answer. SET expressions see
 * the pre-update row, hence `serves_remaining = 1` for "this was the last one".
 */
export async function claimServe(env: Env, record: AnswerRecord, now = Date.now()): Promise<boolean> {
  if (record.serve_mode !== "armed") return true;
  const row = await env.DB.prepare(
    `UPDATE answers
        SET serves_remaining = CASE WHEN serves_remaining IS NULL THEN NULL ELSE serves_remaining - 1 END,
            armed_until      = CASE WHEN serves_remaining = 1 THEN NULL ELSE armed_until END
      WHERE name = ? AND serve_mode = 'armed' AND armed_until > ?
        AND (serves_remaining IS NULL OR serves_remaining > 0)
      RETURNING name`,
  )
    .bind(record.name, now)
    .first();
  return row !== null;
}

/**
 * Relays trigger real automation, and /hook has no arm window or allowlist,
 * so without a SERVE_TOKEN anyone who can guess a relay name could fire it
 * with a payload of their choosing, signed with your HMAC secret. Relays are
 * therefore refused outright until a token is configured.
 */
export function hookAllowed(env: Env, request: Request, pathToken: string | null, bodyToken: unknown = null): Decision {
  if (!env.SERVE_TOKEN) return deny("relays are disabled until a SERVE_TOKEN is configured on this deployment");
  if (bodyTokenOk(env, bodyToken)) return ALLOW;
  if (!tokenOk(env, request, pathToken)) return deny("serve token missing or incorrect");
  return ALLOW;
}

/**
 * The webhook's `auth-token` (PVE 9.2+) arrives as a top-level `token` field
 * in the JSON body. Set it to the SERVE_TOKEN and /hook needs no token in the
 * URL. The field is stripped before the payload is relayed or stored.
 */
export function bodyTokenOk(env: Env, bodyToken: unknown): boolean {
  return !!env.SERVE_TOKEN && typeof bodyToken === "string" && timingSafeEqual(bodyToken, env.SERVE_TOKEN);
}

export async function armAnswer(env: Env, name: string, minutes: number, serves: number | null): Promise<void> {
  const until = Date.now() + Math.max(1, minutes) * 60_000;
  await env.DB.prepare("UPDATE answers SET armed_until = ?, serves_remaining = ? WHERE name = ?").bind(until, serves, name).run();
}

export async function disarmAnswer(env: Env, name: string): Promise<void> {
  await env.DB.prepare("UPDATE answers SET armed_until = NULL, serves_remaining = NULL WHERE name = ?").bind(name).run();
}

export function defaultArmMinutes(env: Env): number {
  return num(env.ARM_DEFAULT_MINUTES, 30);
}

const WRITE_TYPES = ["application/json", "application/octet-stream"];

/**
 * Cross-site request forgery guard for the configurator API.
 *
 * The API is authenticated by the Cloudflare Access cookie, which a browser
 * may attach to a request another site triggers. Reads are safe (another
 * origin cannot see the response); writes are not. A write is accepted only
 * when:
 *   - the browser says it came from this origin (Sec-Fetch-Site, or Origin
 *     when that is all it sends), and
 *   - a POST carries a JSON or octet-stream body. Those types cannot be sent
 *     cross-site without a CORS preflight, which this API never grants, so
 *     this also covers browsers that send neither header. PUT, PATCH and
 *     DELETE always need a preflight.
 * Non-browser clients (curl with an Access service token) send no
 * Sec-Fetch-Site or Origin and pass on the content type alone.
 * Returns why the request is refused, or null.
 */
export function crossSiteWriteRefusal(request: Request): string | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return `cross-site ${method} refused (Sec-Fetch-Site: ${site})`;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return `cross-site ${method} refused (Origin: ${origin})`;

  if (method === "POST") {
    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!WRITE_TYPES.includes(type)) return `POST needs a Content-Type of ${WRITE_TYPES.join(" or ")}`;
  }
  return null;
}
