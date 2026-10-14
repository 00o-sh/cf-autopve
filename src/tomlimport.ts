/**
 * Read an existing answer.toml back into the configurator's document model.
 *
 * The model keeps each installer section as a flat table of dotted keys
 * (`zfs.raid`, `filter.ID_SERIAL`, `fqdn.source`), so a parsed TOML tree is
 * flattened leaf by leaf. Along the way:
 *
 *   - snake_case keys, deprecated since PVE 9.0, are renamed to their
 *     kebab-case form when the catalogue knows it (udev property names under
 *     `filter.` keep their underscores);
 *   - `# comment` lines directly above a key become that key's comment, which
 *     is what emitToml() writes, so a file round-trips through the raw editor;
 *   - anything the installer would not understand is reported, not guessed at.
 */

import { parse, TomlError } from "smol-toml";
import { ValidationError, normaliseDoc } from "./answers";
import { keyDef } from "./schema";
import type { AnswerDoc } from "./toml";

export interface ImportResult {
  doc: AnswerDoc;
  warnings: string[];
}

const TOP_SECTIONS = ["global", "network", "disk-setup", "post-installation-webhook", "first-boot"];
const PINNING = "network.interface-name-pinning";
const MAPPING = "network.interface-name-pinning.mapping";
const MAX_TOML_BYTES = 256 * 1024;

const kebab = (s: string) => s.replace(/_/g, "-");

interface Resolved {
  section: string;
  key: string;
  renamedFrom?: string;
}

/** Map a full TOML key path (section segments + key segments) onto the model. */
function resolve(path: string[]): Resolved | null {
  if (path.length < 2) return null;
  const section = kebab(path[0]);
  if (!TOP_SECTIONS.includes(section)) return null;
  const rest = path.slice(1);

  if (section === "network" && kebab(rest[0]) === "interface-name-pinning") {
    if (rest[1] === "mapping") return rest.length === 3 ? { section: MAPPING, key: rest[2] } : null;
    return rest.length === 2 ? { section: PINNING, key: kebab(rest[1]) } : null;
  }

  const key = rest.join(".");
  // Rename snake_case segments, but never inside a udev filter property name.
  const filterAt = rest.findIndex((seg) => seg === "filter");
  const fixed = rest.map((seg, i) => (filterAt !== -1 && i > filterAt ? seg : kebab(seg))).join(".");
  if (fixed !== key && (keyDef(section, fixed) || fixed.startsWith("filter."))) {
    return { section, key: fixed, renamedFrom: `${path[0]}.${key}` };
  }
  return { section, key };
}

function isTable(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function leaf(value: unknown, where: string, warnings: string[]): unknown {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) {
    if (value.every((x) => ["string", "number", "boolean"].includes(typeof x))) return value;
    warnings.push(`${where}: arrays of tables are not part of the answer format; skipped.`);
    return undefined;
  }
  // Dates and anything else: the installer has no date-valued keys.
  warnings.push(`${where}: unexpected value type; kept as text.`);
  return String(value);
}

/* ---------------------------- comment scan ---------------------------- */

/** Split `a."b.c".d` into segments, honouring basic and literal quoted keys. */
function splitKey(raw: string): string[] | null {
  const segs: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let pos = 0;
  while (pos < raw.length) {
    re.lastIndex = pos;
    const m = re.exec(raw);
    if (!m) return null;
    segs.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] ?? m[3]);
    pos = re.lastIndex;
    if (m[4] === "") break;
  }
  return segs;
}

/** `# comment` lines directly above a key, keyed by full path "section\0key". */
function scanComments(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let table: string[] = [];
  let pending: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") { pending = []; continue; }
    if (line.startsWith("#")) { pending.push(line.replace(/^#+\s?/, "")); continue; }
    const header = line.match(/^\[(?!\[)(.+?)\]\s*(#.*)?$/);
    if (header) {
      table = splitKey(header[1].trim()) ?? [];
      pending = [];
      continue;
    }
    if (line.startsWith("[[")) { table = []; pending = []; continue; }
    const eq = line.match(/^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=/);
    if (eq && pending.length) {
      const key = splitKey(eq[1].trim());
      if (key) {
        const r = resolve([...table, ...key]);
        if (r) out.set(`${r.section}\0${r.key}`, pending.join(" "));
      }
    }
    pending = [];
  }
  return out;
}

/* ------------------------------- import ------------------------------- */

export function parseAnswerToml(text: string): ImportResult {
  if (text.length > MAX_TOML_BYTES) throw new ValidationError("That file is too large to be an answer file.");
  let tree: Record<string, unknown>;
  try {
    tree = parse(text) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof TomlError ? err.message.split("\n")[0] : String((err as Error)?.message ?? err);
    throw new ValidationError(`Not valid TOML: ${msg}`);
  }

  const warnings: string[] = [];
  const renamed: string[] = [];
  const doc: AnswerDoc = {};

  for (const [top, value] of Object.entries(tree)) {
    if (!TOP_SECTIONS.includes(kebab(top))) {
      warnings.push(`[${top}] is not an answer-file section; ignored.`);
      continue;
    }
    if (!isTable(value)) {
      warnings.push(`${top} must be a table; ignored.`);
      continue;
    }
    if (top !== kebab(top)) renamed.push(`[${top}] → [${kebab(top)}]`);

    const walk = (node: Record<string, unknown>, path: string[]) => {
      for (const [k, v] of Object.entries(node)) {
        const here = [...path, k];
        if (isTable(v)) { walk(v, here); continue; }
        const r = resolve(here);
        const where = here.join(".");
        if (!r) { warnings.push(`${where} is not part of the answer format; ignored.`); continue; }
        const val = leaf(v, where, warnings);
        if (val === undefined) continue;
        if (r.renamedFrom) renamed.push(`${r.renamedFrom} → ${r.section}.${r.key}`);
        (doc[r.section] ??= {})[r.key] = val;
      }
    };
    walk(value, [top]);
  }
  if (renamed.length) warnings.push(`Renamed deprecated snake_case keys (PVE 9.0+ expects kebab-case): ${renamed.join(", ")}.`);

  const comments: Record<string, Record<string, string>> = {};
  for (const [path, note] of scanComments(text)) {
    const [section, key] = path.split("\0");
    if (doc[section] && key in doc[section]) (comments[section] ??= {})[key] = note;
  }
  if (Object.keys(comments).length) doc.comments = comments;

  try {
    return { doc: normaliseDoc(doc), warnings };
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // Hand the document over anyway so it can be fixed in the editor; saving re-checks.
    warnings.push(err.message);
    return { doc: { ...doc, must_contain: [], must_not_contain: [] }, warnings };
  }
}
