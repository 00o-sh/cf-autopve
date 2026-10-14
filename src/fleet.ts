/**
 * Machine tables: one answer, many machines.
 *
 * An answer can carry a table, one row per machine, keyed on a field of the
 * system information (a MAC, a serial). Values in the answer may then use
 * `{{ column }}` placeholders, filled in from the matching row when the answer
 * is served: `fqdn = "{{ hostname }}.lab.example"`, `cidr = "{{ ip }}"`.
 *
 * A table also routes: an answer with rows only claims machines that have a
 * row. And an answer whose placeholders cannot all be filled is never served
 * half-rendered; the request is refused with the reason.
 */

import { isSecretKey, keyDef, SECTION_ORDER } from "./schema";
import { coerceValue, type AnswerDoc } from "./toml";
import { checkValue } from "./validate";
import { fieldValues, globToRegExp, MATCH_FIELD_RE } from "./match";

export interface Fleet {
  /** Field of the system information the first column is compared against. */
  field: string;
  /** Column names; the first holds each row's key (a glob, like match rules). */
  columns: string[];
  rows: string[][];
}

export const MAX_MACHINES = 2000;
export const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const MAX_CELL = 500;

export interface Machine {
  /** 1-based row number, as a spreadsheet would show it. */
  row: number;
  key: string;
  vars: Record<string, string>;
}

/** Validate a table from the UI. Returns the clean table, or undefined for none. */
export function normaliseFleet(input: unknown): { fleet?: Fleet; error?: string } {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const rowsIn = Array.isArray(raw.rows) ? raw.rows : [];
  const columns = (Array.isArray(raw.columns) ? raw.columns : []).map((c) => String(c ?? "").trim());
  if (columns.length === 0 && rowsIn.length === 0) return {};
  const field = typeof raw.field === "string" ? raw.field.trim() : "";
  if (!MATCH_FIELD_RE.test(field)) return { error: `Machine table: "${field}" is not a field path like network_interfaces[].mac or dmi.system.serial.` };
  if (columns.length < 1) return { error: "Machine table needs a header row; the first column is the key." };
  for (const c of columns) if (!VAR_RE.test(c)) return { error: `Machine table: column "${c}" must be letters, digits and underscores, starting with a letter.` };
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup) return { error: `Machine table: column "${dup}" appears twice.` };
  if (rowsIn.length > MAX_MACHINES) return { error: `Machine table: at most ${MAX_MACHINES} machines per answer.` };
  const rows: string[][] = [];
  for (const [i, r] of rowsIn.entries()) {
    const cells = (Array.isArray(r) ? r : []).map((c) => String(c ?? "").trim());
    if (cells.every((c) => c === "")) continue;
    if (cells.length > columns.length) return { error: `Machine table row ${i + 1} has ${cells.length} cells but there are ${columns.length} columns.` };
    while (cells.length < columns.length) cells.push("");
    if (!cells[0]) return { error: `Machine table row ${i + 1} has no ${columns[0]}.` };
    const long = cells.findIndex((c) => c.length > MAX_CELL);
    if (long >= 0) return { error: `Machine table row ${i + 1}: ${columns[long]} is longer than ${MAX_CELL} characters.` };
    rows.push(cells);
  }
  return { fleet: { field, columns, rows } };
}

export function asFleet(v: unknown): Fleet | null {
  const f = v as Fleet | undefined;
  return f && typeof f.field === "string" && Array.isArray(f.columns) && Array.isArray(f.rows) ? f : null;
}

/** The first row whose key matches a value at the table's field, if any. */
export function findMachine(fleet: Fleet, info: unknown): Machine | null {
  const values = fieldValues(info, fleet.field);
  if (values.length === 0) return null;
  for (const [i, cells] of fleet.rows.entries()) {
    const re = globToRegExp(cells[0]);
    if (values.some((v) => re.test(v))) {
      return { row: i + 1, key: cells[0], vars: Object.fromEntries(fleet.columns.map((c, j) => [c, cells[j] ?? ""])) };
    }
  }
  return null;
}

/* ------------------------------ placeholders ----------------------------- */

/** Apply `fn` to every string in the answer's TOML sections (not metadata, not comments). */
function mapStrings(doc: AnswerDoc, fn: (text: string, section: string, key: string) => string): AnswerDoc {
  const out: AnswerDoc = { ...doc };
  for (const section of SECTION_ORDER) {
    const table = doc[section];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (typeof value === "string") next[key] = fn(value, section, key);
      else if (Array.isArray(value)) next[key] = value.map((v) => (typeof v === "string" ? fn(v, section, key) : v));
      else next[key] = value;
    }
    out[section] = next;
  }
  return out;
}

export interface PlaceholderUse {
  name: string;
  section: string;
  key: string;
  /** section.key */
  where: string;
}

export function placeholdersIn(doc: AnswerDoc): PlaceholderUse[] {
  const found: PlaceholderUse[] = [];
  mapStrings(doc, (text, section, key) => {
    for (const m of text.matchAll(PLACEHOLDER)) found.push({ name: m[1], section, key, where: `${section}.${key}` });
    return text;
  });
  return found;
}

export function hasPlaceholder(text: unknown): boolean {
  return typeof text === "string" && /\{\{[^{}]*\}\}/.test(text);
}

/**
 * Save-time checks for one answer document: placeholders name real columns,
 * stay out of credentials, and every row renders into valid values.
 */
export function checkTemplate(doc: AnswerDoc, fleet: Fleet | undefined): string[] {
  const problems: string[] = [];
  const uses = placeholdersIn(doc);
  for (const u of uses) {
    if (isSecretKey(u.section, u.key)) problems.push(`${u.where} cannot use placeholders: machine tables are stored unencrypted.`);
    else if (!VAR_RE.test(u.name)) problems.push(`${u.where}: "{{ ${u.name} }}" is not a placeholder name.`);
    else if (fleet && !fleet.columns.includes(u.name)) problems.push(`${u.where} uses {{ ${u.name} }} but the machine table has no such column.`);
  }
  if (problems.length || !fleet || uses.length === 0) return dedupe(problems);
  for (const [i, cells] of fleet.rows.entries()) {
    const machine: Machine = { row: i + 1, key: cells[0], vars: Object.fromEntries(fleet.columns.map((c, j) => [c, cells[j] ?? ""])) };
    const r = renderTemplate(doc, machine);
    problems.push(...r.problems);
    if (problems.length >= 5) break;
  }
  return dedupe(problems).slice(0, 5);
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Fill placeholders from `machine`. Values whose declared type is int or bool
 * are re-coerced after substitution, and every substituted value is checked
 * like a typed one. Problems are returned, not thrown: the caller refuses to
 * serve rather than hand out a half-rendered answer.
 */
export function renderTemplate(doc: AnswerDoc, machine: Machine | null): { doc: AnswerDoc; problems: string[] } {
  const problems: string[] = [];
  const touched = new Set<string>();
  const label = machine ? `machine table row ${machine.row} (${machine.key})` : "";
  const rendered = mapStrings(doc, (text, section, key) => {
    if (!hasPlaceholder(text)) return text;
    touched.add(`${section}\u0000${key}`);
    return text.replace(PLACEHOLDER, (whole, name: string) => {
      if (!machine) {
        problems.push(`${section}.${key} uses {{ ${name} }} but no machine table row matches this machine.`);
        return whole;
      }
      if (!(name in machine.vars)) {
        problems.push(`${section}.${key} uses {{ ${name} }} but the machine table has no such column.`);
        return whole;
      }
      const v = machine.vars[name];
      if (v === "") problems.push(`${section}.${key}: ${label} leaves ${name} empty.`);
      return v;
    });
  });
  if (problems.length) return { doc: rendered, problems: dedupe(problems) };
  for (const id of touched) {
    const [section, key] = id.split("\u0000");
    const table = rendered[section] as Record<string, unknown>;
    const type = keyDef(section, key)?.type;
    if (type === "int" || type === "bool") table[key] = coerceValue(section, key, table[key]);
    const problem = checkValue(section, key, table[key]);
    if (problem) problems.push(`${section}.${key} ${problem} (${label} gives "${String(table[key])}")`);
  }
  return { doc: rendered, problems };
}
