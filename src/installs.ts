/**
 * Install tracking: what each machine's latest install got to.
 *
 *   served     the installer fetched an answer (the install is under way)
 *   refused    it asked and was turned away (the reason is in `detail`)
 *   installed  the post-installation webhook reported back
 *
 * The installer reports nothing when an install fails, so a machine that was
 * served and never reported back within INSTALL_TIMEOUT_MINUTES is shown as
 * "no report"; that is derived when read, not stored.
 *
 * Machines are identified the same way in both payloads: DMI system UUID,
 * else the system serial, else the lowest MAC address. Firmware placeholder
 * values ("To Be Filled By O.E.M.", all-zero UUIDs) are skipped.
 */

import type { Env } from "./env";
import { num } from "./env";

export type InstallStatus = "served" | "refused" | "installed";

export interface InstallRow {
  machine_id: string;
  system_name: string;
  answer: string | null;
  status: InstallStatus;
  detail: string;
  ip: string;
  fqdn: string;
  macs: string;
  first_seen: number;
  served_at: number | null;
  installed_at: number | null;
  updated_at: number;
}

const JUNK = /^(?:|none|null|n\/a|na|default string|to be filled by o\.e\.m\.?|system serial number|not specified|not applicable|0+|1234567890|0123456789|serial)$/i;

function cleanUuid(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!/^[0-9a-f-]{8,}$/.test(s)) return null;
  const hex = s.replace(/-/g, "");
  // All one digit, or the common 03000200-0400-0500-0006-000700080009 filler.
  if (/^(.)\1*$/.test(hex) || hex === "03000200040005000006000700080009") return null;
  return s;
}

function cleanSerial(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s && !JUNK.test(s) ? s : null;
}

/** MACs from either payload shape: network_interfaces (answer request) or network-interfaces (webhook). */
export function macsOf(info: any): string[] {
  const list = [...(Array.isArray(info?.network_interfaces) ? info.network_interfaces : []),
    ...(Array.isArray(info?.["network-interfaces"]) ? info["network-interfaces"] : [])];
  const macs = list
    .map((n) => (typeof n?.mac === "string" ? n.mac.trim().toLowerCase() : ""))
    .filter((m) => /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(m) && m !== "00:00:00:00:00:00");
  return [...new Set(macs)].sort();
}

/** Every identity this payload could be filed under, best first. */
export function machineIds(info: any): string[] {
  const ids: string[] = [];
  const uuid = cleanUuid(info?.dmi?.system?.uuid);
  if (uuid) ids.push(`uuid:${uuid}`);
  const serial = cleanSerial(info?.dmi?.system?.serial);
  if (serial) ids.push(`serial:${serial}`);
  for (const mac of macsOf(info)) ids.push(`mac:${mac}`);
  return ids;
}

/** Record an answer request: served or refused. Best effort, like history. */
export async function trackAnswer(
  env: Env, info: any, e: { answer: string; status: "served" | "refused"; detail: string; ip: string; systemName: string },
): Promise<void> {
  const ids = machineIds(info);
  if (ids.length === 0) return;
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO installs (machine_id, system_name, answer, status, detail, ip, macs, first_seen, served_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id) DO UPDATE SET
         system_name = excluded.system_name, answer = excluded.answer, status = excluded.status, detail = excluded.detail,
         ip = excluded.ip, macs = excluded.macs, updated_at = excluded.updated_at,
         served_at = COALESCE(excluded.served_at, installs.served_at),
         installed_at = CASE WHEN excluded.status = 'served' THEN NULL ELSE installs.installed_at END`,
    )
      .bind(ids[0], e.systemName, e.answer, e.status, e.detail, e.ip, JSON.stringify(macsOf(info)), now, e.status === "served" ? now : null, now)
      .run();
    await trimInstalls(env);
  } catch (err) {
    console.error("install not tracked (has migration 0003 been applied?):", err);
  }
}

/**
 * Record a post-installation webhook. It is filed against whichever existing
 * row shares an identity with it; a machine installed from an answer that
 * was baked into the ISO has no row yet and gets one.
 */
export async function trackInstalled(env: Env, info: any, e: { ip: string; systemName: string; detail: string }): Promise<void> {
  const ids = machineIds(info);
  if (ids.length === 0) return;
  const now = Date.now();
  const fqdn = typeof info?.fqdn === "string" ? info.fqdn.slice(0, 253) : "";
  try {
    const existing = await env.DB.prepare(
      `SELECT machine_id FROM installs WHERE machine_id IN (${ids.map(() => "?").join(", ")}) ORDER BY updated_at DESC LIMIT 1`,
    ).bind(...ids).first<{ machine_id: string }>();
    await env.DB.prepare(
      `INSERT INTO installs (machine_id, system_name, answer, status, detail, ip, fqdn, macs, first_seen, installed_at, updated_at)
       VALUES (?, ?, NULL, 'installed', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id) DO UPDATE SET
         status = 'installed', detail = excluded.detail, ip = excluded.ip, fqdn = excluded.fqdn,
         system_name = CASE WHEN excluded.system_name <> '' THEN excluded.system_name ELSE installs.system_name END,
         installed_at = excluded.installed_at, updated_at = excluded.updated_at`,
    )
      .bind(existing?.machine_id ?? ids[0], e.systemName, e.detail, e.ip, fqdn, JSON.stringify(macsOf(info)), now, now, now)
      .run();
    if (!existing) await trimInstalls(env);
  } catch (err) {
    console.error("install not tracked (has migration 0003 been applied?):", err);
  }
}

/** Keep the table bounded: the machines heard from most recently. */
async function trimInstalls(env: Env): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM installs WHERE machine_id NOT IN (SELECT machine_id FROM installs ORDER BY updated_at DESC LIMIT ?)",
  ).bind(Math.max(1, num(env.INSTALLS_LIMIT, 2000))).run();
}

export interface InstallView extends Omit<InstallRow, "macs"> {
  macs: string[];
  /** Served, and nothing heard back within the timeout. */
  no_report: boolean;
}

export async function listInstalls(env: Env, limit = 500): Promise<InstallView[]> {
  const timeout = num(env.INSTALL_TIMEOUT_MINUTES, 120) * 60_000;
  const now = Date.now();
  const res = await env.DB.prepare("SELECT * FROM installs ORDER BY updated_at DESC LIMIT ?").bind(limit).all<InstallRow>();
  return (res.results ?? []).map((r) => ({
    ...r,
    macs: safeArray(r.macs),
    no_report: r.status === "served" && !!r.served_at && now - r.served_at > timeout,
  }));
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function forgetInstall(env: Env, machineId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM installs WHERE machine_id = ?").bind(machineId).run();
}

export async function forgetInstalled(env: Env): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM installs WHERE status = 'installed'").run();
  return Number(res.meta?.changes ?? 0);
}
