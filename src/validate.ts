/**
 * Value validation for catalogued answer keys.
 *
 * The rules live here once: the API refuses a save that breaks them, and the
 * same regex sources are shipped to the UI in the bootstrap schema so the
 * configurator can flag a bad value while it is being typed. Free-form keys the
 * operator invented are not checked.
 */

import { keyDef } from "./schema";

export type Format = "fqdn" | "domain" | "email" | "ip" | "cidr" | "url" | "fingerprint";

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const V4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4 = `(?:${V4_OCTET}\\.){3}${V4_OCTET}`;
const H = "[0-9A-Fa-f]{1,4}";
const V6 =
  `(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:|(?:${H}:){1,6}:${H}|(?:${H}:){1,5}(?::${H}){1,2}|` +
  `(?:${H}:){1,4}(?::${H}){1,3}|(?:${H}:){1,3}(?::${H}){1,4}|(?:${H}:){1,2}(?::${H}){1,5}|` +
  `${H}:(?::${H}){1,6}|:(?:(?::${H}){1,7}|:))`;

/** Anchored regex sources, so the UI can `new RegExp(source)` them verbatim. */
export const FORMATS: Record<Format, { pattern: string; hint: string }> = {
  fqdn: {
    pattern: `^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$`,
    hint: "a fully qualified host name, e.g. pve1.example.com",
  },
  domain: {
    pattern: `^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`,
    hint: "a domain name, e.g. example.com",
  },
  email: {
    pattern: "^[^\\s@]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*$",
    hint: "an email address, e.g. root@example.com",
  },
  ip: {
    pattern: `^(?:${V4}|${V6})$`,
    hint: "an IPv4 or IPv6 address, e.g. 192.168.1.1",
  },
  cidr: {
    pattern: `^(?:${V4}/(?:3[0-2]|[12]?\\d)|${V6}/(?:12[0-8]|1[01]\\d|[1-9]?\\d))$`,
    hint: "an address with prefix length, e.g. 192.168.1.10/24",
  },
  url: {
    pattern: "^https?://[^\\s/?#]+[^\\s]*$",
    hint: "an http(s) URL",
  },
  fingerprint: {
    pattern: "^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$",
    hint: "a SHA-256 fingerprint as 32 colon-separated hex pairs",
  },
};

const COMPILED = Object.fromEntries(
  Object.entries(FORMATS).map(([k, v]) => [k, new RegExp(v.pattern)]),
) as Record<Format, RegExp>;

/**
 * Why `value` is not acceptable for `section`.`key`, or null when it is (or the
 * key is not catalogued). `value` is the already-coerced value.
 */
export function checkValue(section: string, key: string, value: unknown): string | null {
  const def = keyDef(section, key);
  if (!def) return null;
  if (def.type === "list") return null;
  if (def.type === "bool") {
    return typeof value === "boolean" ? null : "must be true or false";
  }
  if (def.type === "int") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? null : "must be a non-negative number";
  }
  const text = String(value).trim();
  if (def.options && !def.options.includes(text)) {
    return def.options.length > 12 ? "is not a recognised value" : `must be one of ${def.options.join(", ")}`;
  }
  if (def.format && !COMPILED[def.format].test(text)) return `must be ${FORMATS[def.format].hint}`;
  return null;
}
