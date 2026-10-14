/**
 * Answer version history.
 *
 * Every save records the answer's full state (document and serving settings)
 * as a snapshot, so a change can be read as a diff and undone by restoring an
 * earlier snapshot. Credentials stay encrypted in snapshots exactly as they are
 * in the answers table; the text used for diffs shows a short fingerprint of
 * the ciphertext instead, enough to see that a password changed and nothing
 * more.
 */

import type { Env } from "./env";
import { num } from "./env";
import type { AnswerRecord, ServeMode } from "./answers";
import { isEncrypted } from "./crypto";
import { isSecretKey, SECTION_ORDER } from "./schema";
import { emitToml, type AnswerDoc } from "./toml";

export interface Snapshot {
  doc: AnswerDoc;
  priority: number;
  serve_mode: ServeMode;
  allow_cidrs: string[];
  notes: string;
}

export interface VersionMeta {
  id: number;
  name: string;
  created_at: number;
  created_by: string;
  reason: string;
}

export interface Version extends VersionMeta {
  snapshot: Snapshot;
}

export function snapshotOf(record: AnswerRecord): Snapshot {
  return {
    doc: record.doc,
    priority: record.priority,
    serve_mode: record.serve_mode,
    allow_cidrs: record.allow_cidrs,
    notes: record.notes,
  };
}

const keep = (env: Env) => Math.max(1, num(env.ANSWER_VERSIONS_KEEP, 50));

/**
 * Record `record` as the newest version of its answer, unless it is identical
 * to the newest one already there (a save that changed nothing). `before` is
 * the state the answer had before this change: when the answer has no history
 * yet (it predates versioning) that state is recorded first, so the very first
 * tracked change can still be undone.
 *
 * Never throws: history is a convenience, and a missing migration must not
 * stop answers being saved.
 */
export async function recordVersion(
  env: Env, record: AnswerRecord, actor: string, reason: string, before?: AnswerRecord | null,
): Promise<void> {
  try {
    const latest = await env.DB.prepare("SELECT snapshot FROM answer_versions WHERE name = ? ORDER BY id DESC LIMIT 1")
      .bind(record.name).first<{ snapshot: string }>();
    const snap = JSON.stringify(snapshotOf(record));
    if (latest?.snapshot === snap) return;
    const insert = (s: string, at: number, by: string, why: string) =>
      env.DB.prepare("INSERT INTO answer_versions (name, snapshot, created_at, created_by, reason) VALUES (?, ?, ?, ?, ?)")
        .bind(record.name, s, at, by, why).run();
    if (!latest && before) {
      const prior = JSON.stringify(snapshotOf(before));
      if (prior !== snap) await insert(prior, before.updated_at, before.updated_by, "state before history was kept");
    }
    await insert(snap, Date.now(), actor, reason);
    await env.DB.prepare(
      `DELETE FROM answer_versions WHERE name = ? AND id NOT IN
         (SELECT id FROM answer_versions WHERE name = ? ORDER BY id DESC LIMIT ?)`,
    ).bind(record.name, record.name, keep(env)).run();
  } catch (err) {
    console.error(`answer history not recorded for "${record.name}" (has migration 0002 been applied?):`, err);
  }
}

export async function listVersions(env: Env, name: string): Promise<VersionMeta[]> {
  const res = await env.DB.prepare(
    "SELECT id, name, created_at, created_by, reason FROM answer_versions WHERE name = ? ORDER BY id DESC",
  ).bind(name).all<VersionMeta>();
  return res.results ?? [];
}

export async function getVersion(env: Env, name: string, id: number): Promise<Version | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, snapshot, created_at, created_by, reason FROM answer_versions WHERE name = ? AND id = ?",
  ).bind(name, id).first<VersionMeta & { snapshot: string }>();
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshot) as Snapshot };
}

export async function renameVersions(env: Env, from: string, to: string): Promise<void> {
  await env.DB.prepare("UPDATE answer_versions SET name = ? WHERE name = ?").bind(to, from).run();
}

export async function deleteVersions(env: Env, name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM answer_versions WHERE name = ?").bind(name).run();
}

async function fingerprint(ciphertext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ciphertext));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A snapshot as stable, line-oriented text for diffing: the answer's own keys
 * as TOML (with comments), then its configurator metadata and serving
 * settings as `# key = value` lines, list items one per line so that adding a
 * filter or a machine shows as one added line.
 */
export async function describeSnapshot(snap: Snapshot): Promise<string> {
  const doc: AnswerDoc = JSON.parse(JSON.stringify(snap.doc ?? {}));
  for (const section of SECTION_ORDER) {
    const table = doc[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (!isSecretKey(section, key) || value === "" || value === undefined || value === null) continue;
      (table as Record<string, unknown>)[key] = isEncrypted(value)
        ? `(stored credential ${await fingerprint(String(value))})`
        : "(credential)";
    }
  }
  const lines = [emitToml(doc).trimEnd() || "# (no keys of its own; everything is inherited)", "", "# --- configurator settings (not part of the answer file) ---"];
  const meta = (key: string, value: unknown) => {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`# ${key} = []`);
      value.forEach((v, i) => lines.push(`# ${key}[${i}] = ${JSON.stringify(v)}`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) meta(`${key}.${k}`, v);
    } else lines.push(`# ${key} = ${JSON.stringify(value)}`);
  };
  meta("priority", snap.priority);
  meta("serve_mode", snap.serve_mode);
  meta("allow_cidrs", snap.allow_cidrs ?? []);
  meta("notes", snap.notes ?? "");
  const sections = new Set<string>([...SECTION_ORDER, "comments"]);
  for (const key of Object.keys(doc).sort()) if (!sections.has(key)) meta(key, doc[key]);
  return lines.join("\n") + "\n";
}
