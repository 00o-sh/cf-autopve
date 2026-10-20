/**
 * Cloudflare Access enforcement.
 *
 * Access is configured in front of this Worker (Zero Trust > Access >
 * Applications), but the Worker verifies the assertion itself as well: an
 * origin that trusts the proxy blindly is one misrouted hostname away from
 * being wide open. Every /api and UI request must carry a valid, unexpired
 * Access JWT whose `aud` matches this deployment's application.
 */

import type { Env } from "./env";
import { trimTrailing } from "./env";
import { PublicError } from "./errors";

export interface Identity {
  email: string;
  sub: string;
  /** True when Access is bypassed for local development. */
  dev: boolean;
}

export class AccessError extends PublicError {
  constructor(message: string, status = 403) {
    super(message, status);
  }
}

interface Jwk { kid: string; kty: string; alg?: string; n: string; e: string; use?: string }

let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function teamDomain(env: Env): string {
  const raw = trimTrailing((env.ACCESS_TEAM_DOMAIN || "").trim(), "/");
  if (!raw) return "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

async function getJwks(env: Env): Promise<Jwk[]> {
  const url = `${teamDomain(env)}/cdn-cgi/access/certs`;
  const now = Date.now();
  if (jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new AccessError(`could not fetch Access signing keys (${res.status})`, 502);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  if (keys.length === 0) throw new AccessError("Access signing key set was empty", 502);
  jwksCache = { url, keys, fetchedAt: now };
  return keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header.trim();
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Verify the Access assertion on a request. Throws AccessError when the
 * request must not be served.
 */
export async function requireIdentity(request: Request, env: Env): Promise<Identity> {
  if (env.DEV_ALLOW_INSECURE_UI === "true") {
    return { email: "dev@localhost", sub: "dev", dev: true };
  }
  if (!teamDomain(env) || !env.ACCESS_AUD || env.ACCESS_AUD.startsWith("REPLACE_")) {
    throw new AccessError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml, " +
        "or set DEV_ALLOW_INSECURE_UI=true for local development only.",
      503,
    );
  }
  const token = tokenFrom(request);
  if (!token) throw new AccessError("no Cloudflare Access assertion on this request", 401);

  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed Access token", 401);
  let header: any, payload: any;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    throw new AccessError("undecodable Access token", 401);
  }
  if (header.alg !== "RS256") throw new AccessError(`unexpected Access token algorithm ${header.alg}`, 401);

  const keys = await getJwks(env);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessError("Access token signed by an unknown key", 401);

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]) as BufferSource, signed);
  if (!valid) throw new AccessError("Access token signature did not verify", 401);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number") throw new AccessError("Access token has no expiry", 401);
  if (payload.exp < now - 30) throw new AccessError("Access token expired", 401);
  if (payload.nbf !== undefined && typeof payload.nbf !== "number") throw new AccessError("Access token has a malformed nbf", 401);
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new AccessError("Access token not yet valid", 401);
  if (payload.iss !== teamDomain(env)) throw new AccessError("Access token issued by a different team", 403);

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new AccessError("Access token is for a different application", 403);

  return { email: String(payload.email || payload.common_name || payload.sub || "unknown"), sub: String(payload.sub || ""), dev: false };
}
