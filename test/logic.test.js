import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../.test-build/bundle.mjs";

/* ------------------------------- TOML ------------------------------- */

test("dotted keys are emitted bare, exotic keys stay quoted", () => {
  assert.equal(A.encodeKey("zfs.raid"), "zfs.raid");
  assert.equal(A.encodeKey("filter.ID_NET_NAME_MAC"), "filter.ID_NET_NAME_MAC");
  assert.equal(A.encodeKey("aa:bb:cc:dd:ee:ff"), '"aa:bb:cc:dd:ee:ff"');
  assert.equal(A.encodeKey("network.interface-name-pinning.mapping"), "network.interface-name-pinning.mapping");
});

test("a full answer renders in installer order", () => {
  const toml = A.emitToml({
    global: { keyboard: "en-us", country: "us", fqdn: "pve.example.com", "root-password": "hunter2", "reboot-on-error": true },
    network: { source: "from-dhcp" },
    "network.interface-name-pinning": { enabled: true },
    "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "nic0" },
    "disk-setup": { filesystem: "zfs", "zfs.raid": "raid1", "disk-list": ["sda", "sdb"] },
    "first-boot": {},
    must_contain: ["ignored"],
  });
  assert.match(toml, /\[global\]\nkeyboard = "en-us"/);
  assert.match(toml, /reboot-on-error = true/);
  assert.match(toml, /\[network.interface-name-pinning.mapping\]\n"aa:bb:cc:dd:ee:ff" = "nic0"/);
  assert.match(toml, /disk-list = \["sda", "sdb"\]/);
  assert.ok(!toml.includes("first-boot"), "empty sections are pruned");
  assert.ok(!toml.includes("must_contain"), "filter metadata never reaches the installer");
  assert.ok(toml.indexOf("[global]") < toml.indexOf("[network]"));
  assert.ok(toml.indexOf("[network]") < toml.indexOf("[disk-setup]"));
});

test("redaction replaces credentials only", () => {
  const toml = A.emitToml({ global: { fqdn: "pve.example.com", "root-password": "hunter2" } }, { redact: true, redactionText: "X" });
  assert.match(toml, /root-password = "X"/);
  assert.match(toml, /fqdn = "pve.example.com"/);
});

test("values are coerced the way the key catalogue declares", () => {
  assert.deepEqual(A.coerceValue("disk-setup", "disk-list", '["sda", "sdb"]'), ["sda", "sdb"]);
  assert.deepEqual(A.coerceValue("disk-setup", "disk-list", "sda"), ["sda"]);
  assert.equal(A.coerceValue("disk-setup", "zfs.ashift", "12"), 12);
  assert.equal(A.coerceValue("global", "reboot-on-error", "true"), true);
  assert.equal(A.coerceValue("global", "root-password", "1234"), "1234", "passwords stay strings");
  assert.equal(A.coerceValue("global", "fqdn", "pve.example.com"), "pve.example.com");
});

/* ---------------------------- inheritance ---------------------------- */

const DEFAULT_DOC = {
  global: { keyboard: "en-us", country: "us", fqdn: "default.example.com" },
  network: { source: "from-dhcp" },
  "disk-setup": { filesystem: "zfs", "zfs.raid": "raid1", "disk-list": ["sda", "sdb"] },
};

test("an answer overrides Default key by key", () => {
  const merged = A.mergeDocs(DEFAULT_DOC, { global: { fqdn: "node1.example.com" } });
  assert.equal(merged.global.fqdn, "node1.example.com");
  assert.equal(merged.global.keyboard, "en-us");
  assert.deepEqual(merged["disk-setup"]["disk-list"], ["sda", "sdb"]);
});

test("disk filters and disk-list never coexist after a merge", () => {
  const withFilter = A.mergeDocs(DEFAULT_DOC, { "disk-setup": { filter: "ID_SERIAL_SHORT=X" } });
  assert.ok(!("disk-list" in withFilter["disk-setup"]), "child filter drops inherited disk-list");

  const base = { "disk-setup": { filesystem: "ext4", filter: "ID_SERIAL_SHORT=X", "filter-match": "any" } };
  const withList = A.mergeDocs(base, { "disk-setup": { "disk-list": ["nvme0n1"] } });
  assert.ok(!("filter" in withList["disk-setup"]), "child disk-list drops inherited filters");
  assert.ok(!("filter-match" in withList["disk-setup"]));
  assert.equal(withList["disk-setup"].filesystem, "ext4");
});

test("filters match on raw system information", () => {
  const raw = JSON.stringify({ dmi: { system: { name: "PowerEdge R620", serial: "ABC123" } } });
  assert.equal(A.matches({ must_contain: ['"name":"PowerEdge R620"'] }, raw), true);
  assert.equal(A.matches({ must_contain: ['"name":"Other"'] }, raw), false);
  assert.equal(A.matches({ must_contain: ["R620"], must_not_contain: ["ABC123"] }, raw), false);
  assert.equal(A.matches({}, raw), false, "an answer with no filters never matches");
});

test("normalisation enables NIC pinning only when a mapping exists", () => {
  const withMap = A.normaliseDoc({ "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "nic0" } });
  assert.deepEqual(withMap["network.interface-name-pinning"], { enabled: true });
  const without = A.normaliseDoc({ "network.interface-name-pinning": { enabled: true } });
  assert.ok(!("network.interface-name-pinning" in without));
});

test("normalisation refuses a disk-list plus filter combination", () => {
  assert.throws(() => A.normaliseDoc({ "disk-setup": { "disk-list": ["sda"], filter: "x" } }), /disk-list and a filter/);
});

test("names are constrained", () => {
  assert.equal(A.validateName(" node-1 "), "node-1");
  assert.throws(() => A.validateName("../etc/passwd"), /Names must be/);
  assert.throws(() => A.validateName(""), /Names must be/);
});

/* ------------------------------ secrets ------------------------------ */

test("credential keys are recognised, including invented ones", () => {
  assert.equal(A.isSecretKey("global", "root-password"), true);
  assert.equal(A.isSecretKey("global", "root-password-hashed"), true);
  assert.equal(A.isSecretKey("global", "fqdn"), false);
  assert.equal(A.isSecretKey("first-boot", "api-token"), true);
  assert.equal(A.isSecretKey("first-boot", "url"), false);
});

test("masking hides credentials and unmasking restores the stored value", () => {
  const stored = { global: { fqdn: "a.example.com", "root-password": "enc:v1:aaa:bbb" } };
  const masked = A.maskDoc(stored);
  assert.equal(masked.global["root-password"], A.MASK_MARKER);
  assert.equal(masked.global.fqdn, "a.example.com");
  const back = A.unmaskDoc(masked, stored);
  assert.equal(back.global["root-password"], "enc:v1:aaa:bbb");
  const cleared = A.unmaskDoc({ global: { fqdn: "a.example.com" } }, stored);
  assert.ok(!("root-password" in cleared.global), "removing the field removes it");
});

test("credential values survive an encrypt/decrypt round trip", async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const ct = await A.encryptString("hunter2", key);
  assert.ok(ct.startsWith("enc:v1:"));
  assert.ok(!ct.includes("hunter2"));
  assert.equal(await A.decryptString(ct, key), "hunter2");
  const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  await assert.rejects(() => A.decryptString(ct, other));
});

test("uploaded files are scanned for credentials", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(A.scanForSecrets(enc("#!/bin/bash\napt update\n")), []);
  assert.ok(A.scanForSecrets(enc("#!/bin/bash\nPASSWORD=hunter2\n")).length > 0);
  assert.ok(A.scanForSecrets(enc("-----BEGIN OPENSSH PRIVATE KEY-----")).length > 0);
});

/* ------------------------------ guards ------------------------------- */

test("CIDR matching covers v4, v6 and family mismatches", () => {
  assert.equal(A.ipMatchesCidr("203.0.113.5", "203.0.113.0/24"), true);
  assert.equal(A.ipMatchesCidr("203.0.114.5", "203.0.113.0/24"), false);
  assert.equal(A.ipMatchesCidr("203.0.113.5", "203.0.113.5"), true);
  assert.equal(A.ipMatchesCidr("10.0.0.1", "0.0.0.0/0"), true);
  assert.equal(A.ipMatchesCidr("2001:db8::1", "2001:db8::/32"), true);
  assert.equal(A.ipMatchesCidr("2001:db9::1", "2001:db8::/32"), false);
  assert.equal(A.ipMatchesCidr("2001:db8::1", "203.0.113.0/24"), false);
  assert.equal(A.ipMatchesCidr("not-an-ip", "203.0.113.0/24"), false);
  assert.equal(A.ipAllowed("203.0.113.5", []), true, "no allowlist means anywhere");
  assert.equal(A.ipAllowed("", ["203.0.113.0/24"]), false, "unknown client fails a set allowlist");
});

const baseAnswer = {
  name: "node1", doc: {}, priority: 100, serve_mode: "armed", armed_until: null, serves_remaining: null,
  allow_cidrs: [], secrets_ack: false, has_secrets: false, notes: "", created_at: 0, updated_at: 0, updated_by: "",
};
const req = (url = "https://pve.example.com/answer") => new Request(url, { method: "POST" });
const ctx = { request: req(), ip: "203.0.113.5", pathToken: null };

test("a disarmed answer is refused, an armed one is served", () => {
  const env = {};
  assert.equal(A.canServe(env, { ...baseAnswer }, ctx).allowed, false);
  assert.match(A.canServe(env, { ...baseAnswer }, ctx).reason, /disarmed/);
  assert.equal(A.canServe(env, { ...baseAnswer, armed_until: Date.now() + 60000 }, ctx).allowed, true);
  assert.equal(A.canServe(env, { ...baseAnswer, armed_until: Date.now() - 1 }, ctx).allowed, false);
  assert.equal(A.canServe(env, { ...baseAnswer, serve_mode: "off" }, ctx).allowed, false);
  assert.equal(A.canServe(env, { ...baseAnswer, serve_mode: "always" }, ctx).allowed, true);
});

test("an answer holding credentials needs acknowledgement, HTTPS and an arm window", () => {
  const env = {};
  const secretAnswer = { ...baseAnswer, has_secrets: true, armed_until: Date.now() + 60000 };
  assert.match(A.canServe(env, secretAnswer, ctx).reason, /not been acknowledged/);
  const acked = { ...secretAnswer, secrets_ack: true };
  assert.equal(A.canServe(env, acked, ctx).allowed, true);
  const plain = { request: req("http://pve.example.com/answer"), ip: "203.0.113.5", pathToken: null };
  assert.match(A.canServe(env, acked, plain).reason, /plain HTTP/);
  assert.match(A.canServe(env, { ...acked, serve_mode: "always" }, ctx).reason, /"always" mode/);
  assert.equal(A.canServe({ ALLOW_ALWAYS_SECRETS: "true" }, { ...acked, serve_mode: "always" }, ctx).allowed, true);
});

test("serve counters and allowlists are enforced", () => {
  const armed = { ...baseAnswer, armed_until: Date.now() + 60000 };
  assert.match(A.canServe({}, { ...armed, serves_remaining: 0 }, ctx).reason, /used up/);
  assert.equal(A.canServe({}, { ...armed, serves_remaining: 1 }, ctx).allowed, true);
  assert.match(A.canServe({}, { ...armed, allow_cidrs: ["198.51.100.0/24"] }, ctx).reason, /allowlist/);
  assert.equal(A.canServe({}, { ...armed, allow_cidrs: ["203.0.113.0/24"] }, ctx).allowed, true);
});

test("the serve token is required when one is configured", () => {
  const env = { SERVE_TOKEN: "s3cr3t" };
  const armed = { ...baseAnswer, armed_until: Date.now() + 60000 };
  assert.match(A.canServe(env, armed, ctx).reason, /serve token/);
  assert.equal(A.canServe(env, armed, { ...ctx, pathToken: "s3cr3t" }).allowed, true);
  assert.equal(A.canServe(env, armed, { ...ctx, pathToken: "wrong" }).allowed, false);
  const withHeader = new Request("https://pve.example.com/answer", { method: "POST", headers: { "X-AutoPVE-Token": "s3cr3t" } });
  assert.equal(A.canServe(env, armed, { request: withHeader, ip: ctx.ip, pathToken: null }).allowed, true);
});

/* ------------------------------- relay ------------------------------- */

test("relay templates resolve nested paths and escape strings", () => {
  const out = A.renderTemplate('{"host":"{{ system_info.dmi.system.name }}","nics":{{ system_info.network-interfaces }}}', {
    system_info: { dmi: { system: { name: 'Power"Edge' } }, "network-interfaces": [{ address: "10.0.0.1/24" }] },
  });
  assert.equal(out, '{"host":"Power\\"Edge","nics":[{"address":"10.0.0.1/24"}]}');
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(A.renderTemplate("{{ missing.path }}", {}), "");
});

test("relay targets on the LAN are rejected with an explanation", () => {
  assert.throws(() => A.validateRelayUrl("http://192.168.1.10/hook"), /Cloudflare Tunnel/);
  assert.throws(() => A.validateRelayUrl("http://localhost:8080/hook"), /Cloudflare Tunnel/);
  assert.throws(() => A.validateRelayUrl("ftp://example.com"), /http or https/);
  assert.equal(A.validateRelayUrl("https://automation.example.com/h"), "https://automation.example.com/h");
});

test("signatures are stable and token comparison is length-safe", async () => {
  const sig = await A.hmacSha256Hex("secret", "1700000000.{}");
  assert.equal(sig, await A.hmacSha256Hex("secret", "1700000000.{}"));
  assert.notEqual(sig, await A.hmacSha256Hex("other", "1700000000.{}"));
  assert.equal(A.timingSafeEqual("abc", "abc"), true);
  assert.equal(A.timingSafeEqual("abc", "abcd"), false);
});
