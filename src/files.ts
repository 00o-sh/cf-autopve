/**
 * Hosting for first-boot scripts and other files the installer downloads.
 *
 * Small files live in D1 (2 MB is the hard per-row limit, FILE_MAX_BYTES keeps
 * it well under that); bigger ones need the optional R2 binding. Whatever is
 * here is downloadable by anything that can reach the URL — the installer has
 * no credential — so uploads are scanned for credential-looking content and
 * flagged loudly in the UI.
 */

import type { Env } from "./env";
import { num } from "./env";
import { sha256Hex } from "./crypto";

export class FileError extends Error {
  status = 400;
}

export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface FileRecord {
  name: string;
  size: number;
  content_type: string;
  sha256: string;
  storage: "d1" | "r2";
  uploaded_at: number;
  uploaded_by: string;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // [A-Za-z0-9_]* so ROOT_PASSWORD= and GITHUB_TOKEN= count: \b alone never fires after an underscore.
  ["password assignment", /\b[A-Za-z0-9_]*(pass(word|wd)?|passphrase)\s*[:=]\s*\S+/i],
  ["api token assignment", /\b[A-Za-z0-9_]*(api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/i],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer header", /Authorization\s*:\s*Bearer\s+\S+/i],
];

/** Best-effort scan so an operator is told before a credential goes public. */
export function scanForSecrets(bytes: Uint8Array): string[] {
  const head = bytes.subarray(0, 64 * 1024);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(head);
  } catch {
    return [];
  }
  // Skip obvious binaries.
  let control = 0;
  for (let i = 0; i < Math.min(head.length, 1024); i++) {
    const c = head[i];
    if (c === 0 || (c < 9 && c !== 0) || (c > 13 && c < 32)) control++;
  }
  if (control > 16) return [];
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export async function listFiles(env: Env): Promise<FileRecord[]> {
  const res = await env.DB.prepare(
    "SELECT name, size, content_type, sha256, storage, uploaded_at, uploaded_by FROM files ORDER BY name ASC",
  ).all<FileRecord>();
  return res.results || [];
}

export async function putFile(
  env: Env,
  name: string,
  bytes: Uint8Array,
  contentType: string,
  actor: string,
): Promise<{ record: FileRecord; warnings: string[] }> {
  if (!FILE_NAME_RE.test(name)) throw new FileError("File names may contain letters, digits, dot, dash and underscore only.");
  const maxD1 = num(env.FILE_MAX_BYTES, 1_000_000);
  const useR2 = bytes.length > maxD1;
  if (useR2 && !env.FILES) {
    throw new FileError(
      `${name} is ${bytes.length} bytes, over the ${maxD1}-byte D1 limit for this deployment. ` +
        "Bind an R2 bucket (see wrangler.toml) or raise FILE_MAX_BYTES below D1's 2 MB row limit.",
    );
  }
  const digest = await sha256Hex(bytes);
  const now = Date.now();
  if (useR2) {
    await env.FILES!.put(name, bytes, { httpMetadata: { contentType } });
    await env.DB.prepare(
      `INSERT INTO files (name, size, content_type, sha256, storage, blob, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, 'r2', NULL, ?, ?)
       ON CONFLICT(name) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, sha256 = excluded.sha256,
         storage = 'r2', blob = NULL, uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by`,
    ).bind(name, bytes.length, contentType, digest, now, actor).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO files (name, size, content_type, sha256, storage, blob, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, 'd1', ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, sha256 = excluded.sha256,
         storage = 'd1', blob = excluded.blob, uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by`,
    ).bind(name, bytes.length, contentType, digest, bytes, now, actor).run();
  }
  const record: FileRecord = {
    name, size: bytes.length, content_type: contentType, sha256: digest,
    storage: useR2 ? "r2" : "d1", uploaded_at: now, uploaded_by: actor,
  };
  return { record, warnings: scanForSecrets(bytes) };
}

export async function deleteFile(env: Env, name: string): Promise<void> {
  const row = await env.DB.prepare("SELECT storage FROM files WHERE name = ?").bind(name).first<{ storage: string }>();
  if (!row) return;
  if (row.storage === "r2" && env.FILES) await env.FILES.delete(name);
  await env.DB.prepare("DELETE FROM files WHERE name = ?").bind(name).run();
}

export async function serveFile(env: Env, name: string): Promise<Response> {
  if (!FILE_NAME_RE.test(name)) return new Response("not found\n", { status: 404 });
  const row = await env.DB
    .prepare("SELECT name, size, content_type, sha256, storage, blob FROM files WHERE name = ?")
    .bind(name)
    .first<{ name: string; size: number; content_type: string; sha256: string; storage: string; blob: ArrayBuffer | number[] | null }>();
  if (!row) return new Response("not found\n", { status: 404 });
  const headers = {
    "Content-Type": row.content_type || "application/octet-stream",
    "Content-Length": String(row.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${row.sha256}"`,
  };
  if (row.storage === "r2") {
    if (!env.FILES) return new Response("file is in R2 but no R2 binding is configured\n", { status: 500 });
    const obj = await env.FILES.get(name);
    if (!obj) return new Response("not found\n", { status: 404 });
    return new Response(obj.body, { headers });
  }
  // D1 returns a BLOB column as a plain array of byte values, which Response
  // cannot stream; Uint8Array takes that or an ArrayBuffer alike.
  return new Response(row.blob ? new Uint8Array(row.blob) : null, { headers });
}
