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

test("a NIC mapping implies pinning; pinning can also be enabled on its own", () => {
  const withMap = A.normaliseDoc({ "network.interface-name-pinning.mapping": { "aa:bb:cc:dd:ee:ff": "nic0" } });
  assert.deepEqual(withMap["network.interface-name-pinning"], { enabled: true });
  const enabledOnly = A.normaliseDoc({ "network.interface-name-pinning": { enabled: true } });
  assert.deepEqual(enabledOnly["network.interface-name-pinning"], { enabled: true }, "nic0, nic1, ... naming");
  assert.ok(!("network.interface-name-pinning.mapping" in enabledOnly));
  const off = A.normaliseDoc({ "network.interface-name-pinning": { enabled: false } });
  assert.ok(!("network.interface-name-pinning" in off));
});

test("keys the installer refuses together are rejected in one answer", () => {
  assert.throws(() => A.normaliseDoc({ global: { "root-password": "a", "root-password-hashed": "$6$x" } }), /root-password and root-password-hashed/);
  assert.throws(() => A.normaliseDoc({ global: { fqdn: "a.example.com", "fqdn.source": "from-dhcp" } }), /fqdn and fqdn.source/);
  assert.throws(() => A.normaliseDoc({ network: { source: "from-dhcp", cidr: "10.0.0.5/24" } }), /from-dhcp.*cidr/);
  assert.throws(() => A.normaliseDoc({ network: { source: "from-dhcp", "filter.ID_NET_NAME_MAC": "*bc" } }), /filter.ID_NET_NAME_MAC/);
  assert.doesNotThrow(() => A.normaliseDoc({ network: { source: "from-answer", cidr: "10.0.0.5/24", "filter.ID_NET_NAME_MAC": "*bc" } }));
});

test("an answer's choice replaces Default's alternative instead of colliding with it", () => {
  const def = {
    global: { "root-password": "enc:v1:x:y", fqdn: "default.example.com" },
    network: { source: "from-answer", cidr: "10.0.0.5/24", gateway: "10.0.0.1", "filter.ID_NET_NAME": "eno1" },
  };
  const merged = A.mergeDocs(def, {
    global: { "root-password-hashed": "$6$abc", "fqdn.source": "from-dhcp" },
    network: { source: "from-dhcp" },
  });
  assert.ok(!("root-password" in merged.global));
  assert.equal(merged.global["root-password-hashed"], "$6$abc");
  assert.ok(!("fqdn" in merged.global));
  assert.equal(merged.global["fqdn.source"], "from-dhcp");
  assert.deepEqual(merged.network, { source: "from-dhcp" });
});

test("PVE 9.x options are catalogued: subscription key and webhook auth token are credentials", () => {
  assert.equal(A.isSecretKey("global", "subscription-key"), true);
  assert.equal(A.isSecretKey("post-installation-webhook", "auth-token"), true);
  assert.equal(A.checkValue("disk-setup", "zfs.compress", "lz4"), null);
  assert.match(A.checkValue("disk-setup", "zfs.checksum", "md5"), /one of on, fletcher4, sha256/);
  assert.equal(A.checkValue("disk-setup", "lvm.hdsize", 31.5), null, "sizes are GiB and may be fractional");
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

/* ----------------------------- TOML import ---------------------------- */

const UPSTREAM_EXAMPLE = `# provenance header, not attached to any key

[global]
keyboard = "de"
country = "at"
# the node's name
fqdn = "pveauto.testinstall"
root_password = "12345678"
root-ssh-keys = ["ssh-ed25519 AAAA..."]
subscription-key = "pve1c-0123456789"

[network]
source = "from-dhcp"

[network.interface-name-pinning]
enabled = true

[network.interface-name-pinning.mapping]
"24:8a:07:1e:05:bc" = "lan0"

[disk_setup]
filesystem = "zfs"
zfs.raid = "raid1"
zfs.arc_max = 2048
# Kioxia only
filter.ID_SERIAL = "KIOXIA*"

[post-installation-webhook]
url = "https://my.endpoint.local/postinst"
auth-token = "secret-token"

[first-boot]
source = "from-iso"
ordering = "before-network"

[mystery]
x = 1
`;

test("an existing answer.toml imports into the flat dotted-key model", () => {
  const { doc, warnings } = A.parseAnswerToml(UPSTREAM_EXAMPLE);
  assert.equal(doc.global.fqdn, "pveauto.testinstall");
  assert.equal(doc.global["root-password"], "12345678", "snake_case renamed");
  assert.equal(doc.global["subscription-key"], "pve1c-0123456789");
  assert.deepEqual(doc.global["root-ssh-keys"], ["ssh-ed25519 AAAA..."]);
  assert.deepEqual(doc["network.interface-name-pinning"], { enabled: true });
  assert.deepEqual(doc["network.interface-name-pinning.mapping"], { "24:8a:07:1e:05:bc": "lan0" });
  assert.equal(doc["disk-setup"]["zfs.raid"], "raid1");
  assert.equal(doc["disk-setup"]["zfs.arc-max"], 2048);
  assert.equal(doc["disk-setup"]["filter.ID_SERIAL"], "KIOXIA*", "udev property names keep their underscores");
  assert.equal(doc["post-installation-webhook"]["auth-token"], "secret-token");
  assert.equal(doc["first-boot"].ordering, "before-network");
  assert.ok(!("mystery" in doc));
  assert.ok(warnings.some((w) => /\[mystery\]/.test(w)));
  assert.ok(warnings.some((w) => /root_password → global.root-password/.test(w)));
  assert.ok(warnings.some((w) => /\[disk_setup\] → \[disk-setup\]/.test(w)));
});

test("comments directly above a key survive import; header comments do not attach", () => {
  const { doc } = A.parseAnswerToml(UPSTREAM_EXAMPLE);
  assert.deepEqual(doc.comments.global, { fqdn: "the node's name" });
  assert.deepEqual(doc.comments["disk-setup"], { "filter.ID_SERIAL": "Kioxia only" });
});

test("fqdn written as a table imports as fqdn.source / fqdn.domain", () => {
  const { doc } = A.parseAnswerToml(`[global]\nfqdn.source = "from-dhcp"\nfqdn.domain = "example.com"\n`);
  assert.deepEqual(doc.global, { "fqdn.source": "from-dhcp", "fqdn.domain": "example.com" });
  const inline = A.parseAnswerToml(`[global]\nfqdn = { source = "from-dhcp", domain = "example.com" }\n`).doc;
  assert.deepEqual(inline.global, { "fqdn.source": "from-dhcp", "fqdn.domain": "example.com" });
});

test("import -> emit -> import is stable, including comments and the secret marker", () => {
  const first = A.parseAnswerToml(UPSTREAM_EXAMPLE).doc;
  first.global["root-password"] = A.MASK_MARKER;
  const second = A.parseAnswerToml(A.emitToml(first)).doc;
  assert.deepEqual(second, first);
  // The marker then resolves to the stored ciphertext on save.
  const restored = A.unmaskDoc(second, { global: { "root-password": "enc:v1:aa:bb" } });
  assert.equal(restored.global["root-password"], "enc:v1:aa:bb");
});

test("broken TOML is refused with the parser's reason; invalid values still load for fixing", () => {
  assert.throws(() => A.parseAnswerToml(`[global\nkeyboard = "de"`), /Not valid TOML/);
  const { doc, warnings } = A.parseAnswerToml(`[global]\nkeyboard = "klingon"\n`);
  assert.equal(doc.global.keyboard, "klingon");
  assert.ok(warnings.some((w) => /global.keyboard is not a recognised value|must be one of/.test(w)));
});

/* ------------------------- token placements --------------------------- */

const tokenReq = (headers = {}) => new Request("https://pve.example.com/answer", { method: "POST", headers });

test("the installer's Authorization: Bearer <name>:<token> is accepted", () => {
  const env = { SERVE_TOKEN: "s3cr3t" };
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "Bearer autopve:s3cr3t" }), null), true);
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "Bearer s3cr3t" }), null), true);
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "bearer node7:s3cr3t" }), null), true, "scheme is case-insensitive");
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "Bearer autopve:wrong" }), null), false);
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "Bearer :s3cr3t" }), null), false, "an empty name is not the <name>:<secret> form");
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "Basic czNjcjN0" }), null), false);
  assert.equal(A.tokenOk(env, tokenReq({ Authorization: "Bearer s3cr3t:autopve" }), null), false, "the token is the part after the name");
});

test("a webhook body token equal to SERVE_TOKEN authorises /hook without a URL token", () => {
  const env = { SERVE_TOKEN: "s3cr3t" };
  const hook = new Request("https://pve.example.com/hook/deploy", { method: "POST" });
  assert.equal(A.hookAllowed(env, hook, null, "s3cr3t").allowed, true);
  assert.equal(A.hookAllowed(env, hook, null, "receivers-own-token").allowed, false);
  assert.equal(A.hookAllowed(env, hook, null, { not: "a string" }).allowed, false);
  assert.match(A.hookAllowed({}, hook, null, "s3cr3t").reason, /disabled until a SERVE_TOKEN/, "a body token never stands in for having a SERVE_TOKEN");
  assert.equal(A.bodyTokenOk({ SERVE_TOKEN: "s3cr3t" }, "s3cr3t"), true);
  assert.equal(A.bodyTokenOk({}, ""), false);
});

/* --------------------------- merged answer ----------------------------- */

const GOOD = {
  global: { keyboard: "en-us", country: "us", fqdn: "pve1.example.com", mailto: "a@example.com", timezone: "UTC", "root-password-hashed": "$6$x" },
  network: { source: "from-dhcp" },
  "disk-setup": { filesystem: "zfs", "zfs.raid": "raid1", "disk-list": ["sda", "sdb"] },
};

test("a complete merged answer has no problems", () => {
  assert.deepEqual(A.lintMerged(GOOD), []);
});

test("an answer that is fine alone can merge into one the installer rejects", () => {
  const merged = A.mergeDocs(GOOD, { network: { cidr: "10.0.0.5/24" } });
  assert.deepEqual(A.lintMerged(merged), ['network.source is "from-dhcp", so network.cidr must not be set.']);
});

test("missing required keys and mismatched filesystem options are reported", () => {
  const problems = A.lintMerged({
    global: { keyboard: "de" },
    network: { source: "from-answer", cidr: "10.0.0.5/24" },
    "disk-setup": { filesystem: "ext4", "zfs.raid": "raid1" },
    "first-boot": { source: "from-url" },
  });
  const all = problems.join("\n");
  for (const want of [/global.country is required/, /global.fqdn/, /root-password or global.root-password-hashed/,
    /network.dns is required/, /network.gateway is required/, /disk-list or at least one filter/,
    /zfs.\* options but filesystem = "ext4"/, /first-boot.url is required/]) {
    assert.match(all, want);
  }
  assert.doesNotMatch(all, /zfs.raid is required/);
});

test("the stock Default answer is flagged for its missing root password", () => {
  const def = { global: { keyboard: "en-us", country: "at", fqdn: "pveauto.testinstall", mailto: "mail@no.invalid", timezone: "Europe/Vienna" },
    network: { source: "from-dhcp" }, "disk-setup": { filesystem: "zfs", "zfs.raid": "raid1", "disk-list": ["sda", "sdb"] } };
  assert.deepEqual(A.lintMerged(def), ["Set one of global.root-password or global.root-password-hashed."]);
});

/* ------------------------------ JSON answers --------------------------- */

test("the JSON answer is exactly what a TOML parser reads from the TOML answer", () => {
  const doc = A.parseAnswerToml(UPSTREAM_EXAMPLE).doc;
  const toml = A.emitToml(doc);
  assert.deepEqual(A.emitJson(doc), JSON.parse(JSON.stringify(A.parseTomlRaw(toml))));
  const json = A.emitJson(doc);
  assert.equal(json["disk-setup"].zfs.raid, "raid1");
  assert.equal(json["disk-setup"].filter.ID_SERIAL, "KIOXIA*");
  assert.deepEqual(json.network["interface-name-pinning"], { enabled: true, mapping: { "24:8a:07:1e:05:bc": "lan0" } });
  assert.ok(!("comments" in json) && !("must_contain" in json));
});

test("JSON only when the client prefers it", () => {
  assert.equal(A.prefersJson(null), false, "no Accept header keeps TOML");
  assert.equal(A.prefersJson("*/*"), false);
  assert.equal(A.prefersJson("application/json"), true);
  assert.equal(A.prefersJson("application/json, application/toml;q=0.9"), true);
  assert.equal(A.prefersJson("application/toml, application/json;q=0.5"), false);
  assert.equal(A.prefersJson("application/json;q=0"), false);
  assert.equal(A.prefersJson("text/plain;q=0.8, application/json;q=0.8"), true, "a tie goes to JSON");
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
