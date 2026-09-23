/**
 * Envelope encryption for the credential fields of an answer, plus the small
 * signing/hashing helpers the relay and the serve guards need.
 *
 * Format: enc:v1:<base64url iv>:<base64url ciphertext>  (AES-256-GCM)
 * The key lives only in the ANSWER_ENC_KEY Worker secret. D1 never sees a
 * plaintext credential; a dump of the database is useless without the secret.
 */

export const ENC_PREFIX = "enc:v1:";

export function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isEncrypted(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(ENC_PREFIX);
}

async function importKey(rawKey: string): Promise<CryptoKey> {
  const raw = b64decode(rawKey.trim());
  if (raw.length !== 32) {
    throw new Error("ANSWER_ENC_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptString(plain: string, rawKey: string): Promise<string> {
  const key = await importKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${ENC_PREFIX}${b64url(iv)}:${b64url(ct)}`;
}

export async function decryptString(value: string, rawKey: string): Promise<string> {
  if (!isEncrypted(value)) return value;
  const [, , ivPart, ctPart] = value.split(":");
  if (!ivPart || !ctPart) throw new Error("malformed ciphertext");
  const key = await importKey(rawKey);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivPart) }, key, b64decode(ctPart));
  return new TextDecoder().decode(plain);
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent constant-time-ish comparison for tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
