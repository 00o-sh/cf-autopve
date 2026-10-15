/**
 * Reading values out of the installer's system information, shared by match
 * rules and the machine table.
 */

/** A dotted path into the system information; `[]` crosses a list. */
export const MATCH_FIELD_RE = /^[A-Za-z0-9_$-]+(?:\[\])?(?:\.[A-Za-z0-9_$-]+(?:\[\])?)*$/;

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
