export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Optional: only needed for first-boot files larger than FILE_MAX_BYTES. */
  FILES?: R2Bucket;
  /** Optional: durable, retried relay delivery (see relay.ts). Without it, delivery runs inline. */
  RELAY_QUEUE?: Queue<import("./relay").RelayJob>;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  ARM_DEFAULT_MINUTES?: string;
  REQUIRE_HTTPS?: string;
  ALLOW_ALWAYS_SECRETS?: string;
  RATE_LIMIT_PER_MIN?: string;
  FILE_MAX_BYTES?: string;
  HISTORY_MAX_BYTES?: string;
  HISTORY_LIMIT?: string;
  /** Saved versions kept per answer (default 50). */
  ANSWER_VERSIONS_KEEP?: string;
  /** Minutes after an answer is served before a silent machine shows as "no report" (default 120). */
  INSTALL_TIMEOUT_MINUTES?: string;
  /** Machines kept on the Installs dashboard (default 2000). */
  INSTALLS_LIMIT?: string;
  /** "auto" (default): JSON when the installer prefers it, else TOML. "toml": always TOML. */
  ANSWER_FORMAT?: string;

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

/** `s` without trailing `ch`s. A loop, not /x+$/: that regex is quadratic on long runs of `ch`. */
export function trimTrailing(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

export function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return /^(true|1|yes)$/i.test(v.trim());
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "";
}
