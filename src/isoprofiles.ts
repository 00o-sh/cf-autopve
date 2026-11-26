/**
 * ISO build profiles: the build-iso.sh settings for one network, saved so the
 * configurator can hand out a one-liner that fetches the script from this
 * Worker and builds the ISO. The serve token is never part of a profile or
 * a command: the script asks for it on the terminal.
 */

import type { Env } from "./env";
import { PublicError } from "./errors";

export class ProfileError extends PublicError {}

export interface IsoProfile {
  name: string;
  version: string;
  boot_range: string;
  boot_gateway: string;
  boot_dns: string;
  notes: string;
  updated_at: number;
  updated_by: string;
}

function ipToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** The same checks build-iso.sh applies to its --bootstrap-* options, so a saved profile never fails there. */
export function validateProfile(input: Partial<IsoProfile>): Pick<IsoProfile, "version" | "boot_range" | "boot_gateway" | "boot_dns" | "notes"> {
  const version = String(input.version ?? "").trim();
  const range = String(input.boot_range ?? "").trim();
  const gateway = String(input.boot_gateway ?? "").trim();
  // Split rather than trim with a regex: /,+$/ is polynomial on a long run of commas.
  const dns = String(input.boot_dns ?? "").slice(0, 500).replace(/\s+/g, "").split(",").filter(Boolean).join(",");
  const notes = String(input.notes ?? "").slice(0, 2000);

  if (version && !/^\d+\.\d+-\d+$/.test(version)) throw new ProfileError("Version must look like 9.2-1, or be empty for the newest release.");
  if (!range && !gateway && !dns) return { version, boot_range: "", boot_gateway: "", boot_dns: "", notes };
  if (!range || !gateway) throw new ProfileError("Bootstrap range and gateway go together (leave all three empty on a network with DHCP).");

  const m = range.match(/^([0-9.]+)-([0-9.]+)\/(\d+)$/);
  if (!m) throw new ProfileError("Bootstrap range must look like 10.0.0.240-10.0.0.249/24.");
  const start = ipToInt(m[1]);
  const end = ipToInt(m[2]);
  const prefix = Number(m[3]);
  if (start === null || end === null) throw new ProfileError("Bootstrap range: not IPv4 addresses.");
  if (prefix < 1 || prefix > 32) throw new ProfileError("Bootstrap range: prefix must be 1-32.");
  if (end < start) throw new ProfileError("Bootstrap range: end is before start.");
  const gw = ipToInt(gateway);
  if (gw === null) throw new ProfileError("Bootstrap gateway: not an IPv4 address.");
  const mask = prefix === 32 ? 0xffffffff : ((0xffffffff << (32 - prefix)) >>> 0);
  for (const [label, ip] of [["range end", end], ["gateway", gw]] as const) {
    if (((ip & mask) >>> 0) !== ((start & mask) >>> 0)) throw new ProfileError(`Bootstrap ${label} is not in ${m[1]}/${prefix}.`);
  }
  for (const a of dns ? dns.split(",") : []) {
    if (ipToInt(a) === null) throw new ProfileError(`Bootstrap DNS: ${a} is not an IPv4 address.`);
  }
  return { version, boot_range: range, boot_gateway: gateway, boot_dns: dns, notes };
}

/** The command that fetches build-iso.sh from this Worker and builds the ISO for `profile`. */
export function buildCommand(origin: string, profile: Pick<IsoProfile, "version" | "boot_range" | "boot_gateway" | "boot_dns">): string {
  // Saved to a file and run, not piped into bash: the script refuses to run
  // piped code without asking, and a file can be read before it runs.
  const args = [`--url ${origin}`];
  if (profile.version) args.push(`--version ${profile.version}`);
  if (profile.boot_range) {
    args.push(`--bootstrap-range ${profile.boot_range}`, `--bootstrap-gateway ${profile.boot_gateway}`);
    if (profile.boot_dns) args.push(`--bootstrap-dns ${profile.boot_dns}`);
  }
  return `curl -fsSLo build-iso.sh ${origin}/build-iso.sh && bash build-iso.sh ${args.join(" ")}`;
}

export async function listProfiles(env: Env): Promise<IsoProfile[]> {
  const res = await env.DB.prepare("SELECT * FROM iso_profiles ORDER BY name").all<IsoProfile>();
  return res.results ?? [];
}

export async function saveProfile(env: Env, name: string, input: Partial<IsoProfile>, actor: string): Promise<IsoProfile> {
  const p = validateProfile(input);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO iso_profiles (name, version, boot_range, boot_gateway, boot_dns, notes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET version = excluded.version, boot_range = excluded.boot_range,
       boot_gateway = excluded.boot_gateway, boot_dns = excluded.boot_dns, notes = excluded.notes,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(name, p.version, p.boot_range, p.boot_gateway, p.boot_dns, p.notes, now, actor).run();
  return { name, ...p, updated_at: now, updated_by: actor };
}

export async function deleteProfile(env: Env, name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM iso_profiles WHERE name = ?").bind(name).run();
}
