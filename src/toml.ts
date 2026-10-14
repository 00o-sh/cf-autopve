/**
 * Minimal TOML writer for Proxmox answer files.
 *
 * The upstream app ran tomlkit and then post-processed the output with a
 * string hack to turn `"zfs.raid" = "raid1"` into `zfs.raid = "raid1"` and
 * `["network.interface-name-pinning.mapping"]` into the unquoted form. We emit
 * dotted keys correctly in the first place: each dot-separated segment is left
 * bare when it is a valid TOML bare key and quoted otherwise (MAC addresses in
 * the NIC pinning table contain colons, so those stay quoted).
 */

import { SECTION_ORDER, PRUNE_WHEN_EMPTY, isSecretKey, keyDef, type KeyType } from "./schema";

export type TomlValue = string | number | boolean | Array<string | number | boolean>;
export type AnswerDoc = Record<string, any>;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function encodeKey(key: string): string {
  return key
    .split(".")
    .map((seg) => (BARE_KEY.test(seg) ? seg : quote(seg)))
    .join(".");
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

export function encodeValue(v: TomlValue): string {
  if (Array.isArray(v)) return `[${v.map((x) => encodeValue(x as TomlValue)).join(", ")}]`;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : quote(String(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  return quote(String(v));
}

export interface EmitOptions {
  /** Replace credential values with a placeholder instead of the real value. */
  redact?: boolean;
  redactionText?: string;
  /** Prepend a provenance/warning comment block. */
  header?: string;
}

/**
 * Serialise an answer document to a Proxmox `answer.toml`.
 * Non-section metadata (`must_contain`, `must_not_contain`, ...) is skipped.
 */
export function emitToml(doc: AnswerDoc, opts: EmitOptions = {}): string {
  const redactionText = opts.redactionText ?? "REDACTED-BY-AUTOPVE";
  const out: string[] = [];
  if (opts.header) {
    for (const line of opts.header.split("\n")) out.push(`# ${line}`);
    out.push("");
  }
  for (const section of SECTION_ORDER) {
    const table = doc[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const entries = Object.entries(table as Record<string, TomlValue>);
    if (entries.length === 0 && PRUNE_WHEN_EMPTY.includes(section)) continue;
    out.push(`[${encodeKey(section)}]`);
    const comments = (doc.comments?.[section] ?? {}) as Record<string, unknown>;
    for (const [key, value] of entries) {
      if (value === undefined || value === null || value === "") continue;
      const comment = typeof comments[key] === "string" ? cleanComment(comments[key] as string) : "";
      if (comment) out.push(`# ${comment}`);
      const redacted = opts.redact && isSecretKey(section, key);
      out.push(`${encodeKey(key)} = ${redacted ? quote(redactionText) : encodeValue(value)}`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

/**
 * The same answer as a JSON object, for installers that ask for JSON (the
 * installer advertises both and prefers JSON). Sections and dotted keys become
 * nested objects exactly as TOML would read them: `[disk-setup] zfs.raid` is
 * {"disk-setup": {"zfs": {"raid": ...}}}. Comments and filter metadata are
 * dropped, as in emitToml(). Always the real values: never call this on a
 * document that should be redacted.
 */
export function emitJson(doc: AnswerDoc): Record<string, unknown> {
  const out: Record<string, any> = {};
  const descend = (root: Record<string, any>, path: string[]) => {
    let cur = root;
    for (const seg of path) {
      if (!cur[seg] || typeof cur[seg] !== "object" || Array.isArray(cur[seg])) cur[seg] = {};
      cur = cur[seg];
    }
    return cur;
  };
  for (const section of SECTION_ORDER) {
    const table = doc[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const entries = Object.entries(table as Record<string, TomlValue>).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (entries.length === 0 && PRUNE_WHEN_EMPTY.includes(section)) continue;
    const target = descend(out, section.split("."));
    for (const [key, value] of entries) {
      const path = key.split(".");
      descend(target, path.slice(0, -1))[path[path.length - 1]] = value;
    }
  }
  return out;
}

/**
 * Whether to answer with JSON: only when the client asks for JSON at least as
 * strongly as for TOML. No Accept header, or one without JSON, gets TOML.
 */
export function prefersJson(accept: string | null): boolean {
  if (!accept) return false;
  const q: Record<string, number> = {};
  for (const part of accept.split(",")) {
    const [type, ...params] = part.trim().toLowerCase().split(";").map((x) => x.trim());
    if (!type) continue;
    const qp = params.find((p) => p.startsWith("q="));
    const weight = qp ? Number(qp.slice(2)) : 1;
    q[type] = Math.max(q[type] ?? 0, Number.isFinite(weight) ? weight : 0);
  }
  const json = q["application/json"] ?? 0;
  const toml = Math.max(q["application/toml"] ?? 0, q["text/toml"] ?? 0, q["text/plain"] ?? 0);
  return json > 0 && json >= toml;
}

/** One line, no control characters, bounded: safe to emit after a `#`. */
export function cleanComment(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Turn a UI string into a typed TOML value, using the catalogue's declared type
 * when there is one and otherwise guessing the way the upstream app did
 * (bracketed text becomes a list, digits become an integer).
 */
export function coerceValue(section: string, key: string, raw: unknown): TomlValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === "string" ? v.trim() : v)) as TomlValue;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  const value = String(raw);
  if (value.length === 0) return "";
  const declared: KeyType | undefined = keyDef(section, key)?.type;
  const looksList = value.trim().startsWith("[") && value.trim().endsWith("]");

  if (declared === "list" || (!declared && looksList)) {
    if (!looksList) return [value.trim()];
    const inner = value.trim().slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""))
      .filter((v) => v.length > 0);
  }
  if (declared === "int") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (declared === "bool") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
    return value;
  }
  if (declared === "str") return value;
  // Untyped free-form key: mirror upstream's guessing, plus booleans.
  if (/^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  if (/^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
}

/** Redact credential lines in an already-rendered TOML string. */
export function redactToml(toml: string, redactionText = "REDACTED-BY-AUTOPVE"): string {
  return toml
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*([A-Za-z0-9_."'-]+)\s*=/);
      if (!m) return line;
      const key = m[1].replace(/['"]/g, "");
      return isSecretKey("global", key) ? `${m[1]} = "${redactionText}"` : line;
    })
    .join("\n");
}
