/**
 * Answer storage, inheritance and matching.
 *
 * The matching and merge rules are a direct port of `post_answer()` in the
 * upstream main.py: every answer inherits from "Default", the first answer
 * whose filters match the installer's system information wins, and its
 * sections are shallow-merged over Default's.
 */

import type { Env } from "./env";
import { bool } from "./env";
import { encryptString, decryptString, isEncrypted } from "./crypto";
import { isSecretKey, SECTION_ORDER, DEFAULT_ANSWER_DOC } from "./schema";
import { cleanComment, coerceValue, type AnswerDoc } from "./toml";
import { checkValue } from "./validate";

export const DEFAULT_NAME = "Default";

export type ServeMode = "off" | "armed" | "always";

export interface AnswerRecord {
  name: string;
  doc: AnswerDoc;
  priority: number;
  serve_mode: ServeMode;
  armed_until: number | null;
  serves_remaining: number | null;
  allow_cidrs: string[];
  secrets_ack: boolean;
  has_secrets: boolean;
  notes: string;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

export class ValidationError extends Error {
  status = 400;
}

interface AnswerRow {
  name: string;
  doc: string;
  priority: number;
  serve_mode: string;
  armed_until: number | null;
  serves_remaining: number | null;
  allow_cidrs: string;
  secrets_ack: number;
  has_secrets: number;
  notes: string;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

function rowToRecord(row: AnswerRow): AnswerRecord {
  return {
    name: row.name,
    doc: safeJson(row.doc, {}),
    priority: row.priority,
    serve_mode: (["off", "armed", "always"].includes(row.serve_mode) ? row.serve_mode : "armed") as ServeMode,
    armed_until: row.armed_until,
    serves_remaining: row.serves_remaining,
    allow_cidrs: safeJson(row.allow_cidrs, []),
    secrets_ack: !!row.secrets_ack,
    has_secrets: !!row.has_secrets,
    notes: row.notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by || "",
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * Secret handling
 * ------------------------------------------------------------------ */

export function secretKeysIn(doc: AnswerDoc): string[] {
  const found: string[] = [];
  for (const section of SECTION_ORDER) {
    const table = doc[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const key of Object.keys(table)) {
      const v = (table as Record<string, unknown>)[key];
      if (isSecretKey(section, key) && v !== "" && v !== undefined && v !== null) found.push(`${section}.${key}`);
    }
  }
  return found;
}

export function docHasSecrets(doc: AnswerDoc): boolean {
  return secretKeysIn(doc).length > 0;
}

/** Encrypt every credential value in place (returns a new document). */
export async function encryptDoc(doc: AnswerDoc, env: Env): Promise<AnswerDoc> {
  const out: AnswerDoc = JSON.parse(JSON.stringify(doc));
  for (const section of SECTION_ORDER) {
    const table = out[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (!isSecretKey(section, key)) continue;
      if (value === "" || value === undefined || value === null) continue;
      if (isEncrypted(value)) continue;
      if (!env.ANSWER_ENC_KEY) {
        throw new ValidationError(
          `Refusing to store the credential "${section}.${key}" in plaintext. ` +
            "Set the ANSWER_ENC_KEY secret (wrangler secret put ANSWER_ENC_KEY) and try again.",
        );
      }
      (table as Record<string, unknown>)[key] = await encryptString(String(value), env.ANSWER_ENC_KEY);
    }
  }
  return out;
}

/** Decrypt every credential value (returns a new document). */
export async function decryptDoc(doc: AnswerDoc, env: Env): Promise<AnswerDoc> {
  const out: AnswerDoc = JSON.parse(JSON.stringify(doc));
  for (const section of SECTION_ORDER) {
    const table = out[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (!isEncrypted(value)) continue;
      if (!env.ANSWER_ENC_KEY) throw new ValidationError("ANSWER_ENC_KEY is not configured but this answer holds encrypted values.");
      (table as Record<string, unknown>)[key] = await decryptString(value, env.ANSWER_ENC_KEY);
    }
  }
  return out;
}

/** Replace credential values with a marker so a document can be sent to the UI. */
export function maskDoc(doc: AnswerDoc): AnswerDoc {
  const out: AnswerDoc = JSON.parse(JSON.stringify(doc));
  for (const section of SECTION_ORDER) {
    const table = out[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (isSecretKey(section, key) && value !== "" && value !== undefined && value !== null) {
        (table as Record<string, unknown>)[key] = "__autopve_secret_set__";
      }
    }
  }
  return out;
}

export const MASK_MARKER = "__autopve_secret_set__";

/**
 * Merge an incoming (masked) document from the UI with what is stored, so an
 * unchanged credential field keeps its existing ciphertext instead of being
 * overwritten with the mask marker.
 */
export function unmaskDoc(incoming: AnswerDoc, stored: AnswerDoc): AnswerDoc {
  const out: AnswerDoc = JSON.parse(JSON.stringify(incoming));
  for (const section of SECTION_ORDER) {
    const table = out[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (value === MASK_MARKER) {
        const prior = stored?.[section]?.[key];
        if (prior === undefined) delete (table as Record<string, unknown>)[key];
        else (table as Record<string, unknown>)[key] = prior;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

export function validateName(name: string): string {
  const trimmed = (name || "").trim();
  if (!NAME_RE.test(trimmed)) {
    throw new ValidationError("Names must be 1-40 characters of letters, digits, space, dot, dash or underscore.");
  }
  return trimmed;
}

/** Normalise a document coming from the UI: coerce types, drop empties. */
export function normaliseDoc(input: AnswerDoc): AnswerDoc {
  const out: AnswerDoc = {};
  const invalid: string[] = [];
  for (const section of SECTION_ORDER) {
    const table = input[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const clean: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(table as Record<string, unknown>)) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "string" && isEncrypted(raw)) {
        clean[key] = raw; // already-encrypted value passing back through
        continue;
      }
      const v = coerceValue(section, key, raw);
      if (v === undefined || v === "") continue;
      if (raw !== MASK_MARKER) {
        const problem = checkValue(section, key, v);
        if (problem) invalid.push(`${section}.${key} ${problem} (got "${String(raw)}")`);
      }
      clean[key] = v;
    }
    out[section] = clean;
  }
  if (invalid.length) throw new ValidationError(`Not saved: ${invalid.join("; ")}.`);
  // Filters are answer metadata, not part of the TOML.
  out.must_contain = Array.isArray(input.must_contain) ? input.must_contain.filter((s: unknown) => typeof s === "string" && s.trim() !== "") : [];
  const rules: MatchRule[] = [];
  for (const r of Array.isArray(input.match) ? input.match : []) {
    const field = typeof r?.field === "string" ? r.field.trim() : "";
    const pattern = typeof r?.pattern === "string" ? r.pattern.trim() : "";
    if (!field && !pattern) continue;
    if (!MATCH_FIELD_RE.test(field)) throw new ValidationError(`Match rule field "${field}" is not a field path like dmi.system.serial or network_interfaces[].mac.`);
    if (!pattern || pattern.length > 200) throw new ValidationError(`Match rule on ${field} needs a pattern (up to 200 characters).`);
    rules.push({ field, pattern });
  }
  out.match = rules;
  out.match_mode = input.match_mode === "any" ? "any" : "all";
  out.must_not_contain = Array.isArray(input.must_not_contain)
    ? input.must_not_contain.filter((s: unknown) => typeof s === "string" && s.trim() !== "")
    : [];

  // NIC pinning: a mapping implies enabled; enabled on its own is also valid
  // (the installer then names every NIC nic0, nic1, ...).
  const mapping = out["network.interface-name-pinning.mapping"] as Record<string, unknown> | undefined;
  const hasMapping = !!mapping && Object.keys(mapping).length > 0;
  const pinning = out["network.interface-name-pinning"] as Record<string, unknown> | undefined;
  if (hasMapping || pinning?.enabled === true) out["network.interface-name-pinning"] = { enabled: true };
  else delete out["network.interface-name-pinning"];
  if (!hasMapping) delete out["network.interface-name-pinning.mapping"];

  for (const [section, groups] of Object.entries(EXCLUSIVE)) {
    const table = out[section] as Record<string, unknown> | undefined;
    if (!table) continue;
    for (const group of groups) {
      const used = group.filter((alt) => Object.keys(table).some(alt.has));
      if (used.length > 1) throw new ValidationError(`${section} cannot use ${used.map((a) => a.label).join(" and ")} at the same time.`);
    }
  }
  const net = out.network as Record<string, unknown> | undefined;
  if (net?.source === "from-dhcp") {
    const statics = Object.keys(net).filter(isStaticNetKey);
    if (statics.length) {
      throw new ValidationError(`network: with source = "from-dhcp" the installer rejects ${statics.join(", ")}. Use source = "from-answer" or remove them.`);
    }
  }

  const comments = normaliseComments(input.comments, out);
  if (Object.keys(comments).length) out.comments = comments;
  return out;
}

interface Alternative {
  label: string;
  has: (key: string) => boolean;
}

const only = (k: string): Alternative => ({ label: k, has: (key) => key === k });
const family = (prefix: string, label: string): Alternative => ({ label, has: (key) => key.startsWith(prefix) });

/**
 * Keys the installer refuses to see together. Within a document that is a
 * validation error; across inheritance, whichever alternative the answer sets
 * replaces the other one in Default.
 */
const EXCLUSIVE: Record<string, Alternative[][]> = {
  global: [
    [only("root-password"), only("root-password-hashed")],
    [only("fqdn"), family("fqdn.", "fqdn.source/fqdn.domain")],
  ],
  "disk-setup": [[only("disk-list"), family("filter", "a filter")]],
};

function isStaticNetKey(key: string): boolean {
  return key === "cidr" || key === "dns" || key === "gateway" || key.startsWith("filter");
}

/** Scopes that can carry comments: every TOML section, plus the two filter lists. */
const FILTER_SCOPES = ["must_contain", "must_not_contain"] as const;

/**
 * Keep only comments that still belong to something in `doc`: a key present in
 * its section, or a string present in its filter list. Each is one cleaned line.
 */
function normaliseComments(raw: unknown, doc: AnswerDoc): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [scope, table] of Object.entries(raw as Record<string, unknown>)) {
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const isFilter = (FILTER_SCOPES as readonly string[]).includes(scope);
    if (!isFilter && !(SECTION_ORDER as readonly string[]).includes(scope)) continue;
    const owner = doc[scope];
    const kept: Record<string, string> = {};
    for (const [key, text] of Object.entries(table as Record<string, unknown>)) {
      if (typeof text !== "string") continue;
      const exists = isFilter ? Array.isArray(owner) && owner.includes(key) : !!owner && key in owner;
      const clean = cleanComment(text);
      if (exists && clean) kept[key] = clean;
    }
    if (Object.keys(kept).length) out[scope] = kept;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

const COLUMNS =
  "name, doc, priority, serve_mode, armed_until, serves_remaining, allow_cidrs, secrets_ack, has_secrets, notes, created_at, updated_at, updated_by";

export async function listAnswers(env: Env): Promise<AnswerRecord[]> {
  const res = await env.DB.prepare(`SELECT ${COLUMNS} FROM answers ORDER BY priority ASC, name ASC`).all<AnswerRow>();
  return (res.results || []).map(rowToRecord);
}

export async function getAnswer(env: Env, name: string): Promise<AnswerRecord | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM answers WHERE name = ?`).bind(name).first<AnswerRow>();
  return row ? rowToRecord(row) : null;
}

export interface AnswerSettingsInput {
  priority?: number;
  serve_mode?: ServeMode;
  allow_cidrs?: string[];
  secrets_ack?: boolean;
  notes?: string;
}

export async function saveAnswer(
  env: Env,
  name: string,
  doc: AnswerDoc,
  settings: AnswerSettingsInput,
  actor: string,
): Promise<AnswerRecord> {
  const existing = await getAnswer(env, name);
  const normalised = normaliseDoc(unmaskDoc(doc, existing?.doc ?? {}));
  const hasSecrets = docHasSecrets(normalised);
  const secretsAck = settings.secrets_ack ?? existing?.secrets_ack ?? false;

  if (hasSecrets && !secretsAck) {
    throw new ValidationError(
      `This answer contains credentials (${secretKeysIn(normalised).join(", ")}). ` +
        "Hosting them means anything that can reach the answer endpoint can read them. " +
        "Acknowledge the risk on the Serving tab (or remove the credential) before saving.",
    );
  }
  let serveMode: ServeMode = settings.serve_mode ?? existing?.serve_mode ?? (hasSecrets ? "armed" : "always");
  if (hasSecrets && serveMode === "always" && !bool(env.ALLOW_ALWAYS_SECRETS)) {
    throw new ValidationError(
      'An answer holding credentials cannot be set to serve_mode "always" on this deployment. ' +
        'Use "armed" and arm it for the length of an install, or set ALLOW_ALWAYS_SECRETS=true if you really mean it.',
    );
  }
  const encrypted = await encryptDoc(normalised, env);
  const now = Date.now();
  const allowCidrs = JSON.stringify((settings.allow_cidrs ?? existing?.allow_cidrs ?? []).filter((c) => c.trim() !== ""));

  await env.DB.prepare(
    `INSERT INTO answers (name, doc, priority, serve_mode, armed_until, serves_remaining, allow_cidrs, secrets_ack, has_secrets, notes, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       doc = excluded.doc, priority = excluded.priority, serve_mode = excluded.serve_mode,
       allow_cidrs = excluded.allow_cidrs, secrets_ack = excluded.secrets_ack, has_secrets = excluded.has_secrets,
       notes = excluded.notes, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(
      name,
      JSON.stringify(encrypted),
      settings.priority ?? existing?.priority ?? 100,
      serveMode,
      existing?.armed_until ?? null,
      existing?.serves_remaining ?? null,
      allowCidrs,
      secretsAck ? 1 : 0,
      hasSecrets ? 1 : 0,
      settings.notes ?? existing?.notes ?? "",
      existing?.created_at ?? now,
      now,
      actor,
    )
    .run();

  const saved = await getAnswer(env, name);
  return saved!;
}

export async function deleteAnswer(env: Env, name: string): Promise<void> {
  if (name === DEFAULT_NAME) throw new ValidationError("The Default answer cannot be removed.");
  await env.DB.prepare("DELETE FROM answers WHERE name = ?").bind(name).run();
}

export async function ensureDefaultAnswer(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT name FROM answers WHERE name = ?").bind(DEFAULT_NAME).first();
  if (row) return;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO answers (name, doc, priority, serve_mode, allow_cidrs, secrets_ack, has_secrets, notes, created_at, updated_at, updated_by)
     VALUES (?, ?, 1000, 'always', '[]', 0, 0, '', ?, ?, 'system')`,
  )
    .bind(DEFAULT_NAME, JSON.stringify(DEFAULT_ANSWER_DOC), now, now)
    .run();
}

/* ------------------------------------------------------------------ *
 * Matching and inheritance
 * ------------------------------------------------------------------ */

/* ------------------------- structured match rules ------------------------ */

/**
 * A rule tests one field of the installer's system information against a
 * glob: `dmi.system.serial` ~ `9000*`, `network_interfaces[].mac` ~
 * `24:8a:07:*`. `[]` after a segment means "any element of this list".
 * Globs follow the installer's own filter syntax (* ? [abc] [!a]) and ignore
 * case, so MAC addresses match however they are written.
 */
export interface MatchRule {
  field: string;
  pattern: string;
}

export type MatchMode = "all" | "any";

export const MATCH_FIELD_RE = /^[A-Za-z0-9_$-]+(?:\[\])?(?:\.[A-Za-z0-9_$-]+(?:\[\])?)*$/;

/** Fields worth offering in the editor; any other path works too. */
export const MATCH_FIELD_SUGGESTIONS = [
  "network_interfaces[].mac", "network_interfaces[].link",
  "dmi.system.serial", "dmi.system.uuid", "dmi.system.name", "dmi.system.sku",
  "dmi.baseboard.serial", "dmi.baseboard.name", "dmi.chassis.serial", "dmi.chassis.asset_tag",
  "product.product", "product.fullname", "iso.release",
];

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) { re += "\\["; continue; }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("!");
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else re += c.replace(/[.+^${}()|\\\]\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Every value at `field` in `info` (several when the path crosses a list). */
export function fieldValues(info: unknown, field: string): string[] {
  let current: unknown[] = [info];
  for (const raw of field.split(".")) {
    const each = raw.endsWith("[]");
    const key = each ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const node of current) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const v = (node as Record<string, unknown>)[key];
      if (v === undefined || v === null) continue;
      if (each) { if (Array.isArray(v)) next.push(...v); }
      else next.push(v);
    }
    current = next;
  }
  return current.filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean").map(String);
}

export interface RuleResult extends MatchRule {
  values: string[];
  hit: boolean;
}

export function evaluateRules(info: unknown, rules: MatchRule[]): RuleResult[] {
  return rules.map((r) => {
    const values = fieldValues(info, r.field);
    const re = globToRegExp(r.pattern);
    return { ...r, values: values.slice(0, 8), hit: values.some((v) => re.test(v)) };
  });
}

/**
 * Does this answer claim this machine? Text filters keep their upstream
 * meaning (some must_contain hits, no must_not_contain hits). Match rules,
 * when present, must also hold (all, or any, per match_mode). An answer with
 * only match rules needs no must_contain; must_not_contain still vetoes.
 */
export function matches(doc: AnswerDoc, systemInfoRaw: string, info?: unknown): boolean {
  const mustContain: string[] = Array.isArray(doc.must_contain) ? doc.must_contain : [];
  const mustNotContain: string[] = Array.isArray(doc.must_not_contain) ? doc.must_not_contain : [];
  const rules: MatchRule[] = Array.isArray(doc.match) ? doc.match : [];
  if (mustNotContain.some((e) => e.length > 0 && systemInfoRaw.includes(e))) return false;
  const textOk = mustContain.some((e) => e.length > 0 && systemInfoRaw.includes(e));
  if (rules.length === 0) return textOk;
  if (mustContain.length > 0 && !textOk) return false;
  let parsed = info;
  if (parsed === undefined) {
    try { parsed = JSON.parse(systemInfoRaw); } catch { parsed = {}; }
  }
  const results = evaluateRules(parsed, rules);
  return doc.match_mode === "any" ? results.some((r) => r.hit) : results.every((r) => r.hit);
}

/**
 * Shallow-merge an answer's sections over the Default answer's sections.
 * disk-setup gets the upstream's extra rule: disk-list and filters are mutually
 * exclusive, so whichever one the child specifies wipes the other from Default.
 */
export function mergeDocs(defaultDoc: AnswerDoc, answerDoc: AnswerDoc): AnswerDoc {
  const out: AnswerDoc = JSON.parse(JSON.stringify(defaultDoc));
  for (const section of SECTION_ORDER) {
    const child = answerDoc[section];
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const base = (out[section] ?? {}) as Record<string, unknown>;
    const childKeys = Object.keys(child as Record<string, unknown>);
    for (const group of EXCLUSIVE[section] ?? []) {
      for (const alt of group) {
        if (!childKeys.some(alt.has)) continue;
        for (const other of group) {
          if (other === alt) continue;
          for (const k of Object.keys(base)) if (other.has(k)) delete base[k];
        }
      }
    }
    // An answer switching to DHCP drops Default's static addressing and NIC filter.
    if (section === "network" && (child as Record<string, unknown>).source === "from-dhcp") {
      for (const k of Object.keys(base)) if (isStaticNetKey(k)) delete base[k];
    }
    out[section] = { ...base, ...(child as Record<string, unknown>) };
  }
  // A key the answer sets carries the answer's comment (or none), never Default's.
  const comments: Record<string, Record<string, string>> = JSON.parse(JSON.stringify(defaultDoc.comments ?? {}));
  for (const section of SECTION_ORDER) {
    const child = answerDoc[section];
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const own = (answerDoc.comments?.[section] ?? {}) as Record<string, string>;
    const merged = { ...(comments[section] ?? {}) };
    for (const key of Object.keys(child as Record<string, unknown>)) {
      delete merged[key];
      if (own[key]) merged[key] = own[key];
    }
    comments[section] = merged;
  }
  out.comments = comments;
  return out;
}

/* ------------------------------------------------------------------ *
 * Checking what the installer will actually receive
 * ------------------------------------------------------------------ */

const present = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * Problems in a merged answer (Default layered under the answer) that the
 * installer would reject. Each document can be valid on its own and still
 * combine into something broken, e.g. an answer that adds a static `cidr`
 * while Default says `from-dhcp`. Returned as messages, not thrown: the
 * answer still saves, and the operator sees why the install would fail.
 */
export function lintMerged(doc: AnswerDoc): string[] {
  const out: string[] = [];
  const g = (doc.global ?? {}) as Record<string, unknown>;
  const net = (doc.network ?? {}) as Record<string, unknown>;
  const disk = (doc["disk-setup"] ?? {}) as Record<string, unknown>;
  const has = (t: Record<string, unknown>, k: string) => present(t[k]);
  const hasPrefix = (t: Record<string, unknown>, p: string) => Object.keys(t).some((k) => k.startsWith(p) && present(t[k]));

  for (const k of ["keyboard", "country", "mailto", "timezone"]) if (!has(g, k)) out.push(`global.${k} is required.`);
  if (!has(g, "fqdn") && !has(g, "fqdn.source")) out.push("global.fqdn (or fqdn.source = \"from-dhcp\") is required.");
  const pw = ["root-password", "root-password-hashed"].filter((k) => has(g, k));
  if (pw.length === 0) out.push("Set one of global.root-password or global.root-password-hashed.");
  if (pw.length === 2) out.push("Set only one of global.root-password and global.root-password-hashed.");

  if (!has(net, "source")) out.push("network.source is required.");
  if (net.source === "from-dhcp") {
    const statics = Object.keys(net).filter((k) => isStaticNetKey(k) && present(net[k]));
    if (statics.length) out.push(`network.source is "from-dhcp", so ${statics.map((k) => `network.${k}`).join(", ")} must not be set.`);
  }
  if (net.source === "from-answer") {
    for (const k of ["cidr", "dns", "gateway"]) if (!has(net, k)) out.push(`network.${k} is required with source = "from-answer".`);
  }

  const fs = disk.filesystem;
  if (!present(fs)) out.push("disk-setup.filesystem is required.");
  const usesList = has(disk, "disk-list");
  const usesFilter = hasPrefix(disk, "filter.");
  if (!usesList && !usesFilter) out.push("disk-setup needs disk-list or at least one filter.<udev property>.");
  if (usesList && usesFilter) out.push("disk-setup uses disk-list and a filter; the installer allows only one.");
  if (fs === "zfs" && !has(disk, "zfs.raid")) out.push('disk-setup.zfs.raid is required with filesystem = "zfs".');
  if (fs === "btrfs" && !has(disk, "btrfs.raid")) out.push('disk-setup.btrfs.raid is required with filesystem = "btrfs".');
  const family: Record<string, string[]> = { "zfs.": ["zfs"], "lvm.": ["ext4", "xfs"], "btrfs.": ["btrfs"] };
  for (const [prefix, fits] of Object.entries(family)) {
    if (present(fs) && hasPrefix(disk, prefix) && !fits.includes(String(fs))) {
      out.push(`disk-setup has ${prefix}* options but filesystem = "${fs}"; they only apply to ${fits.join("/")}.`);
    }
  }

  const fb = doc["first-boot"] as Record<string, unknown> | undefined;
  if (fb && Object.keys(fb).length) {
    if (!has(fb, "source")) out.push("first-boot.source is required when the first-boot section is used.");
    if (fb.source === "from-url" && !has(fb, "url")) out.push('first-boot.url is required with source = "from-url".');
  }
  const hook = doc["post-installation-webhook"] as Record<string, unknown> | undefined;
  if (hook && Object.keys(hook).length && !has(hook, "url")) out.push("post-installation-webhook.url is required when the section is used.");
  return out;
}

export interface Selection {
  record: AnswerRecord;
  /** Merged document, still encrypted. */
  merged: AnswerDoc;
  defaultRecord: AnswerRecord | null;
}

/**
 * Pick the answer that should serve this installer, mirroring upstream: the
 * Default answer is the base and the fallback, and the first non-Default answer
 * whose filters match wins. Ordering is by priority then name so the outcome
 * does not depend on insertion order.
 */
export async function selectAnswer(env: Env, systemInfoRaw: string): Promise<Selection | null> {
  const all = await listAnswers(env);
  const def = all.find((a) => a.name === DEFAULT_NAME) ?? null;
  const defaultDoc = def?.doc ?? {};
  let info: unknown;
  try { info = JSON.parse(systemInfoRaw); } catch { info = {}; }
  for (const record of all) {
    if (record.name === DEFAULT_NAME) continue;
    if (!matches(record.doc, systemInfoRaw, info)) continue;
    return { record, merged: mergeDocs(defaultDoc, record.doc), defaultRecord: def };
  }
  if (!def) return null;
  return { record: def, merged: JSON.parse(JSON.stringify(defaultDoc)), defaultRecord: def };
}

export function systemName(systemInfo: any): string {
  return String(systemInfo?.dmi?.system?.name ?? "");
}
