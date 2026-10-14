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

/* ------------------------- atomic serve claim ------------------------ */

// A minimal D1 stand-in over node:sqlite, using the real migration, so the
// claim's SQL is exercised as written.
async function d1() {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return {
    raw: db,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => db.prepare(sql).run(...args),
      }),
    }),
  };
}

async function armedRow(DB, fields) {
  const row = { serve_mode: "armed", armed_until: Date.now() + 60000, serves_remaining: 1, ...fields };
  DB.raw.prepare("INSERT INTO answers (name, serve_mode, armed_until, serves_remaining, created_at, updated_at) VALUES ('node1', ?, ?, ?, 0, 0)")
    .run(row.serve_mode, row.armed_until, row.serves_remaining);
  return { ...baseAnswer, ...row };
}

const rowOf = (DB) => DB.raw.prepare("SELECT serve_mode, armed_until, serves_remaining FROM answers WHERE name = 'node1'").get();

test("concurrent fetches against a one-serve arm get exactly one answer", async () => {
  const DB = await d1();
  const record = await armedRow(DB, { serves_remaining: 1 });
  // Every request read the same snapshot and passed canServe…
  assert.equal(A.canServe({}, record, ctx).allowed, true);
  // …but only one may spend the serve.
  const wins = (await Promise.all(Array.from({ length: 10 }, () => A.claimServe({ DB }, record)))).filter(Boolean);
  assert.equal(wins.length, 1);
  assert.deepEqual({ ...rowOf(DB) }, { serve_mode: "armed", armed_until: null, serves_remaining: 0 }, "last serve disarms");
});

test("a serve budget of N admits exactly N", async () => {
  const DB = await d1();
  const record = await armedRow(DB, { serves_remaining: 3 });
  const wins = (await Promise.all(Array.from({ length: 8 }, () => A.claimServe({ DB }, record)))).filter(Boolean);
  assert.equal(wins.length, 3);
  assert.equal(rowOf(DB).serves_remaining, 0);
});

test("an unlimited arm keeps serving inside its window and stops after it", async () => {
  const DB = await d1();
  const until = Date.now() + 60000;
  const record = await armedRow(DB, { serves_remaining: null, armed_until: until });
  assert.equal(await A.claimServe({ DB }, record), true);
  assert.equal(await A.claimServe({ DB }, record), true);
  assert.deepEqual({ ...rowOf(DB) }, { serve_mode: "armed", armed_until: until, serves_remaining: null });
  assert.equal(await A.claimServe({ DB }, record, until + 1), false);
});

test("a claim loses to a disarm or mode change made after the snapshot", async () => {
  const DB = await d1();
  const record = await armedRow(DB, { serves_remaining: 5 });
  DB.raw.exec("UPDATE answers SET armed_until = NULL, serves_remaining = NULL");
  assert.equal(await A.claimServe({ DB }, record), false);
  DB.raw.exec(`UPDATE answers SET armed_until = ${Date.now() + 60000}, serve_mode = 'off'`);
  assert.equal(await A.claimServe({ DB }, record), false);
});

test("always-mode answers need no claim", async () => {
  assert.equal(await A.claimServe({ DB: null }, { ...baseAnswer, serve_mode: "always" }), true);
});

/* ------------------------------ hook guard ---------------------------- */

test("relays are refused outright without a SERVE_TOKEN", () => {
  const hook = new Request("https://pve.example.com/hook/deploy", { method: "POST" });
  assert.match(A.hookAllowed({}, hook, null).reason, /disabled until a SERVE_TOKEN/);
  assert.equal(A.hookAllowed({}, hook, "anything").allowed, false);
  const env = { SERVE_TOKEN: "s3cr3t" };
  assert.match(A.hookAllowed(env, hook, null).reason, /missing or incorrect/);
  assert.equal(A.hookAllowed(env, hook, "wrong").allowed, false);
  assert.equal(A.hookAllowed(env, hook, "s3cr3t").allowed, true);
  const withHeader = new Request("https://pve.example.com/hook/deploy", { method: "POST", headers: { "X-AutoPVE-Token": "s3cr3t" } });
  assert.equal(A.hookAllowed(env, withHeader, null).allowed, true);
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

/* ----------------------------- validation ---------------------------- */

test("enumerated global keys accept only known values", () => {
  assert.equal(A.checkValue("global", "keyboard", "en-us"), null);
  assert.match(A.checkValue("global", "keyboard", "en_US"), /not a recognised value/);
  assert.match(A.checkValue("disk-setup", "filesystem", "ntfs"), /must be one of ext4, xfs, zfs, btrfs/);
  assert.equal(A.checkValue("global", "country", "us"), null);
  assert.match(A.checkValue("global", "country", "usa"), /not a recognised value/);
  assert.equal(A.checkValue("global", "timezone", "Europe/Vienna"), null);
  assert.equal(A.checkValue("global", "timezone", "America/New_York"), null);
  assert.equal(A.checkValue("global", "timezone", "UTC"), null);
  assert.match(A.checkValue("global", "timezone", "Europe/Atlantis"), /not a recognised value/);
});

test("formatted keys are checked against their pattern", () => {
  assert.equal(A.checkValue("global", "fqdn", "servervirtual2.yeled.org"), null);
  assert.match(A.checkValue("global", "fqdn", "servervirtual2"), /fully qualified/);
  assert.match(A.checkValue("global", "fqdn", "bad_host.example.com"), /fully qualified/);
  assert.equal(A.checkValue("global", "mailto", "ebrody@yeled.org"), null);
  assert.match(A.checkValue("global", "mailto", "not an email"), /email/);
  assert.equal(A.checkValue("network", "cidr", "192.168.1.10/24"), null);
  assert.equal(A.checkValue("network", "cidr", "2001:db8::10/64"), null);
  assert.match(A.checkValue("network", "cidr", "192.168.1.10"), /prefix length/);
  assert.match(A.checkValue("network", "cidr", "192.168.1.300/24"), /prefix length/);
  assert.equal(A.checkValue("network", "gateway", "fe80::1"), null);
  assert.match(A.checkValue("network", "dns", "1.1.1"), /IPv4 or IPv6/);
  const fp = Array(32).fill("ab").join(":");
  assert.equal(A.checkValue("post-installation-webhook", "cert-fingerprint", fp), null);
  assert.match(A.checkValue("post-installation-webhook", "cert-fingerprint", "abcd"), /fingerprint/);
});

test("typed keys and uncatalogued keys", () => {
  assert.equal(A.checkValue("disk-setup", "zfs.ashift", 12), null);
  assert.match(A.checkValue("disk-setup", "zfs.ashift", "twelve"), /non-negative number/);
  assert.match(A.checkValue("global", "reboot-on-error", "maybe"), /true or false/);
  assert.equal(A.checkValue("global", "my-own-key", "anything"), null);
});

test("the UI regex sources compile and agree with the server", () => {
  for (const [name, f] of Object.entries(A.FORMATS)) assert.doesNotThrow(() => new RegExp(f.pattern), name);
  assert.ok(new RegExp(A.FORMATS.fqdn.pattern).test("pve1.example.com"));
});

test("normalisation refuses invalid values and names every problem", () => {
  assert.throws(
    () => A.normaliseDoc({ global: { timezone: "Mars/Olympus", country: "zz", fqdn: "pve.example.com" } }),
    (err) => /global\.timezone/.test(err.message) && /global\.country/.test(err.message) && !/global\.fqdn/.test(err.message),
  );
  assert.doesNotThrow(() => A.normaliseDoc({ global: { keyboard: "en-us", country: "us", timezone: "America/New_York" } }));
});

/* ------------------------------ comments ----------------------------- */

test("comments are emitted as # lines above their key", () => {
  const toml = A.emitToml({
    "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "nic0", "aa:bb:cc:dd:ee:00": "nic1" },
    comments: { "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "onboard port 1\nsecond line" } },
  });
  assert.match(toml, /# onboard port 1 second line\n"aa:bb:cc:dd:ee:ff" = "nic0"\n"aa:bb:cc:dd:ee:00" = "nic1"/);
  assert.ok(!toml.includes("[comments]"), "comments never become a TOML table");
});

test("normalisation keeps only comments that still belong to something", () => {
  const doc = A.normaliseDoc({
    global: { fqdn: "pve.example.com" },
    "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "nic0" },
    must_contain: ['"serial":"ABC1234"'],
    comments: {
      global: { fqdn: "  rack 3  ", keyboard: "orphan" },
      "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "left port" },
      must_contain: { '"serial":"ABC1234"': "servervirtual2 service tag", gone: "orphan" },
      bogus: { x: "not a scope" },
      "disk-setup": { filesystem: "" },
    },
  });
  assert.deepEqual(doc.comments, {
    global: { fqdn: "rack 3" },
    "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "left port" },
    must_contain: { '"serial":"ABC1234"': "servervirtual2 service tag" },
  });
  assert.ok(!("comments" in A.normaliseDoc({ global: { fqdn: "pve.example.com" } })));
});

test("an answer's own key never inherits Default's comment", () => {
  const merged = A.mergeDocs(
    { global: { fqdn: "default.example.com", keyboard: "en-us" }, comments: { global: { fqdn: "placeholder", keyboard: "everyone" } } },
    { global: { fqdn: "node1.example.com" } },
  );
  assert.deepEqual(merged.comments.global, { keyboard: "everyone" });
  const own = A.mergeDocs(merged, { global: { fqdn: "node2.example.com" }, comments: { global: { fqdn: "node 2" } } });
  assert.equal(own.comments.global.fqdn, "node 2");
});
