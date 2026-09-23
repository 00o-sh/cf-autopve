export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Optional: only needed for first-boot files larger than FILE_MAX_BYTES. */
  FILES?: R2Bucket;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  ARM_DEFAULT_MINUTES?: string;
  REQUIRE_HTTPS?: string;
  ALLOW_ALWAYS_SECRETS?: string;
  RATE_LIMIT_PER_MIN?: string;
  FILE_MAX_BYTES?: string;
  HISTORY_MAX_BYTES?: string;
  HISTORY_LIMIT?: string;

  /** Local development escape hatch. Never set this in production. */
  DEV_ALLOW_INSECURE_UI?: string;

  /** Secrets */
  ANSWER_ENC_KEY?: string;
  SERVE_TOKEN?: string;
}

export function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return /^(true|1|yes)$/i.test(v.trim());
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "";
}
