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
import { coerceValue, type AnswerDoc } from "./toml";
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
  out.must_not_contain = Array.isArray(input.must_not_contain)
    ? input.must_not_contain.filter((s: unknown) => typeof s === "string" && s.trim() !== "")
    : [];

  // Enabling NIC pinning is implied by having a mapping.
  const mapping = out["network.interface-name-pinning.mapping"] as Record<string, unknown> | undefined;
  if (mapping && Object.keys(mapping).length > 0) {
    out["network.interface-name-pinning"] = { enabled: true };
  } else {
    delete out["network.interface-name-pinning"];
    delete out["network.interface-name-pinning.mapping"];
  }

  const disk = out["disk-setup"] as Record<string, unknown> | undefined;
  if (disk && "disk-list" in disk && Object.keys(disk).some((k) => k.startsWith("filter"))) {
    throw new ValidationError("disk-setup cannot use disk-list and a filter at the same time.");
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

/** Port of the upstream filter test: any must_contain hit, no must_not_contain hit. */
export function matches(doc: AnswerDoc, systemInfoRaw: string): boolean {
  let match = false;
  const mustContain: string[] = Array.isArray(doc.must_contain) ? doc.must_contain : [];
  const mustNotContain: string[] = Array.isArray(doc.must_not_contain) ? doc.must_not_contain : [];
  for (const entry of mustContain) {
    if (entry.length > 0 && systemInfoRaw.includes(entry)) match = true;
  }
  for (const entry of mustNotContain) {
    if (entry.length > 0 && systemInfoRaw.includes(entry)) match = false;
  }
  return match;
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
    if (section === "disk-setup") {
      const base = (out[section] ?? {}) as Record<string, unknown>;
      const childKeys = Object.keys(child as Record<string, unknown>);
      if (childKeys.some((k) => k.startsWith("filter")) && "disk-list" in base) delete base["disk-list"];
      if (childKeys.includes("disk-list")) {
        for (const k of Object.keys(base)) if (k.startsWith("filter")) delete base[k];
      }
      out[section] = { ...base, ...(child as Record<string, unknown>) };
      continue;
    }
    out[section] = { ...((out[section] ?? {}) as Record<string, unknown>), ...(child as Record<string, unknown>) };
  }
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
  for (const record of all) {
    if (record.name === DEFAULT_NAME) continue;
    if (!matches(record.doc, systemInfoRaw)) continue;
    return { record, merged: mergeDocs(defaultDoc, record.doc), defaultRecord: def };
  }
  if (!def) return null;
  return { record: def, merged: JSON.parse(JSON.stringify(defaultDoc)), defaultRecord: def };
}

export function systemName(systemInfo: any): string {
  return String(systemInfo?.dmi?.system?.name ?? "");
}
