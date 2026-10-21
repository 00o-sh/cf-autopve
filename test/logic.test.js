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

test("control characters are escaped so the string stays valid TOML", () => {
  const value = "a\u0000b\bc\u001fd\u007fe\tf\ng\"h\\";
  assert.equal(A.encodeValue(value), '"a\\u0000b\\u0008c\\u001fd\\u007fe\\tf\\ng\\"h\\\\"');
  assert.equal(A.parseTomlRaw(`k = ${A.encodeValue(value)}`).k, value);
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
  assert.deepEqual(A.scanForSecrets(enc("export ROOT_PASSWORD=hunter2\n")), ["password assignment"], "prefixed names count");
  assert.deepEqual(A.scanForSecrets(enc("GITHUB_TOKEN=ghp_0123456789abcdef\n")), ["api token assignment"]);
  assert.deepEqual(A.scanForSecrets(enc("CLIENT_SECRET: 'abcdef0123456789'\n")), ["api token assignment"]);
  assert.deepEqual(A.scanForSecrets(enc("TOKEN_FILE=/etc/x\n")), [], "a short or path value is not a token");
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
    prepare: (sql) => {
      const bound = (...args) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => db.prepare(sql).run(...args),
        all: async () => ({ results: db.prepare(sql).all(...args) }),
      });
      return { bind: bound, ...bound() };
    },
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

/* ---------------------------- answer versions -------------------------- */

// D1 over node:sqlite with every migration applied, enough of the API for versions.ts.
async function d1All() {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../migrations/", import.meta.url);
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql, args) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => db.prepare(sql).run(...args),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { raw: db, prepare: (sql) => ({ ...stmt(sql, []), bind: (...args) => stmt(sql, args) }) };
}

const rec = (doc, extra = {}) => ({ ...baseAnswer, name: "node1", doc, priority: 100, serve_mode: "armed", allow_cidrs: [], notes: "", updated_at: 1000, updated_by: "old@example.com", ...extra });

test("saves become versions; a no-op save does not, and history is trimmed", async () => {
  const env = { DB: await d1All(), ANSWER_VERSIONS_KEEP: "3" };
  await A.recordVersion(env, rec({ global: { keyboard: "de" } }), "a@example.com", "save");
  await A.recordVersion(env, rec({ global: { keyboard: "de" } }), "a@example.com", "save");
  assert.equal((await A.listVersions(env, "node1")).length, 1, "identical state is not recorded twice");
  for (const k of ["fr", "us", "it"]) await A.recordVersion(env, rec({ global: { keyboard: k } }), "b@example.com", "save");
  const versions = await A.listVersions(env, "node1");
  assert.deepEqual(versions.map((v) => v.reason), ["save", "save", "save"]);
  assert.equal(versions.length, 3, "only the newest ANSWER_VERSIONS_KEEP are kept");
  assert.equal((await A.getVersion(env, "node1", versions[0].id)).snapshot.doc.global.keyboard, "it", "newest first");
});

test("the first tracked save also keeps the state from before history existed", async () => {
  const env = { DB: await d1All() };
  const before = rec({ global: { keyboard: "de" } });
  await A.recordVersion(env, rec({ global: { keyboard: "fr" } }), "a@example.com", "save", before);
  const [now, then] = await A.listVersions(env, "node1");
  assert.equal(then.reason, "state before history was kept");
  assert.equal(then.created_by, "old@example.com");
  assert.equal((await A.getVersion(env, "node1", then.id)).snapshot.doc.global.keyboard, "de");
  assert.equal(now.created_by, "a@example.com");
});

test("version history follows renames and goes with the answer", async () => {
  const env = { DB: await d1All() };
  await A.recordVersion(env, rec({}), "a@example.com", "created");
  await A.renameVersions(env, "node1", "node2");
  assert.equal((await A.listVersions(env, "node1")).length, 0);
  assert.equal((await A.listVersions(env, "node2")).length, 1);
  await A.deleteVersions(env, "node2");
  assert.equal((await A.listVersions(env, "node2")).length, 0);
});

test("history is best effort: a missing table never breaks a save", async () => {
  const env = { DB: { prepare: () => { throw new Error("no such table: answer_versions"); } } };
  const quiet = console.error; console.error = () => {};
  try { await assert.doesNotReject(A.recordVersion(env, rec({}), "a@example.com", "save")); } finally { console.error = quiet; }
});

test("diff text fingerprints credentials and puts each list item on its own line", async () => {
  const snap = (pw) => ({ doc: { global: { keyboard: "de", "root-password": pw }, must_contain: ["R620", "R630"], comments: { global: { keyboard: "German" } } },
    priority: 10, serve_mode: "armed", allow_cidrs: ["10.0.0.0/24"], notes: "" });
  const a = await A.describeSnapshot(snap("enc:v1:aaaa:bbbb"));
  const b = await A.describeSnapshot(snap("enc:v1:aaaa:cccc"));
  assert.match(a, /# German\nkeyboard = "de"/);
  assert.match(a, /root-password = "\(stored credential [0-9a-f]{8}\)"/);
  assert.ok(!a.includes("enc:v1"), "no ciphertext in the text");
  assert.notEqual(a, b, "a changed credential shows as a changed fingerprint");
  assert.equal(a, await A.describeSnapshot(snap("enc:v1:aaaa:bbbb")), "stable for the same state");
  assert.match(a, /# must_contain\[0\] = "R620"\n# must_contain\[1\] = "R630"/);
  assert.match(a, /# allow_cidrs\[0\] = "10.0.0.0\/24"/);
  assert.match(a, /# serve_mode = "armed"/);
  assert.ok(!a.includes("comments"), "comments are in the TOML, not repeated as metadata");
});

/* ---------------------------- install tracking ------------------------- */

// D1 over node:sqlite with every migration applied and the parts of the D1 API the Worker uses.
async function d1Migrated() {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../migrations/", import.meta.url);
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql, args) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  const prepare = (sql) => ({ ...stmt(sql, []), bind: (...args) => stmt(sql, args) });
  return { raw: db, prepare, batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const REQ_INFO = {
  dmi: { system: { uuid: "6FB36FD4-77A1-4E7D-9C2A-0E5F3B1D2C4B", serial: "900030XXXX", name: "RS700" } },
  network_interfaces: [{ link: "eno2", mac: "24:8A:07:1E:05:BD" }, { link: "eno1", mac: "24:8a:07:1e:05:bc" }],
};
// What the post-installation webhook sends: same DMI, kebab-case NIC list, plus the installed fqdn.
const HOOK_INFO = {
  fqdn: "pve1.lab.example", dmi: { system: { uuid: "6fb36fd4-77a1-4e7d-9c2a-0e5f3b1d2c4b", name: "RS700" } },
  "network-interfaces": [{ name: "nic0", mac: "24:8a:07:1e:05:bc", address: "10.0.0.11/24" }],
};

test("machines are identified by DMI uuid, then serial, then MAC; firmware filler is skipped", () => {
  assert.deepEqual(A.machineIds(REQ_INFO), ["uuid:6fb36fd4-77a1-4e7d-9c2a-0e5f3b1d2c4b", "serial:900030XXXX", "mac:24:8a:07:1e:05:bc", "mac:24:8a:07:1e:05:bd"]);
  assert.deepEqual(A.machineIds({ dmi: { system: { uuid: "03000200-0400-0500-0006-000700080009", serial: "To Be Filled By O.E.M." } }, network_interfaces: [{ mac: "AA:BB:CC:DD:EE:FF" }] }), ["mac:aa:bb:cc:dd:ee:ff"]);
  assert.deepEqual(A.machineIds({ dmi: { system: { uuid: "00000000-0000-0000-0000-000000000000", serial: "Default string" } } }), []);
  assert.deepEqual(A.macsOf(HOOK_INFO), ["24:8a:07:1e:05:bc"], "the webhook's network-interfaces are read too");
});

test("an install goes served -> installed, and a reinstall starts over", async () => {
  const env = { DB: await d1Migrated() };
  await A.trackAnswer(env, REQ_INFO, { answer: "rack", status: "served", detail: "", ip: "10.0.0.50", systemName: "RS700" });
  let [row] = await A.listInstalls(env);
  assert.equal(row.machine_id, "uuid:6fb36fd4-77a1-4e7d-9c2a-0e5f3b1d2c4b");
  assert.equal(row.status, "served");
  assert.equal(row.no_report, false);
  await A.trackInstalled(env, HOOK_INFO, { ip: "10.0.0.11", systemName: "RS700", detail: "reported" });
  const all = await A.listInstalls(env);
  assert.equal(all.length, 1, "the webhook is filed against the same machine");
  [row] = all;
  assert.equal(row.status, "installed");
  assert.equal(row.fqdn, "pve1.lab.example");
  assert.equal(row.answer, "rack", "the answer it was served is kept");
  assert.ok(row.installed_at >= row.served_at);
  await A.trackAnswer(env, REQ_INFO, { answer: "rack", status: "served", detail: "", ip: "10.0.0.50", systemName: "RS700" });
  [row] = await A.listInstalls(env);
  assert.equal(row.status, "served");
  assert.equal(row.installed_at, null, "a new install clears the old result");
});

test("a served machine that never reports back shows as no report", async () => {
  const env = { DB: await d1Migrated(), INSTALL_TIMEOUT_MINUTES: "30" };
  await A.trackAnswer(env, REQ_INFO, { answer: "rack", status: "served", detail: "", ip: "", systemName: "" });
  env.DB.raw.exec(`UPDATE installs SET served_at = ${Date.now() - 31 * 60_000}`);
  assert.equal((await A.listInstalls(env))[0].no_report, true);
});

test("a webhook from a machine never served here still gets a row; the table is bounded", async () => {
  const env = { DB: await d1Migrated(), INSTALLS_LIMIT: "2" };
  for (const mac of ["aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02", "aa:bb:cc:00:00:03"]) {
    await A.trackInstalled(env, { "network-interfaces": [{ mac }] }, { ip: "", systemName: "", detail: "reported" });
  }
  const rows = await A.listInstalls(env);
  assert.deepEqual(rows.map((r) => [r.machine_id, r.status, r.answer]), [["mac:aa:bb:cc:00:00:03", "installed", null], ["mac:aa:bb:cc:00:00:02", "installed", null]]);
});

test("through the Worker: /answer marks a machine served, POST /hook marks it installed", async () => {
  const DB = await d1Migrated();
  const now = Date.now();
  DB.raw.prepare("INSERT INTO answers (name, doc, priority, serve_mode, created_at, updated_at) VALUES ('Default', ?, 1000, 'always', ?, ?)")
    .run(JSON.stringify({ global: { keyboard: "de" } }), now, now);
  const env = { DB, SERVE_TOKEN: "s3cr3t" };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const post = (path, body, headers = {}) => A.worker.fetch(new Request(`https://pve.example.com${path}`, { method: "POST", body: JSON.stringify(body), headers }), env, ctx);

  const denied = await post("/answer", REQ_INFO);
  assert.equal(denied.status, 403);
  await Promise.all(pending.splice(0));
  assert.equal((await A.listInstalls(env)).length, 0, "a caller without the token leaves no dashboard row");

  const wrongAnswer = await post("/answer", REQ_INFO, { Authorization: "Bearer autopve:s3cr3t" });
  assert.equal(wrongAnswer.status, 200);
  await Promise.all(pending.splice(0));
  assert.equal((await A.listInstalls(env))[0].status, "served");

  assert.equal((await post("/hook", HOOK_INFO)).status, 403, "/hook needs the token too");
  const hook = await post("/hook", { ...HOOK_INFO, token: "s3cr3t" });
  assert.equal(hook.status, 200);
  await Promise.all(pending.splice(0));
  const [row] = await A.listInstalls(env);
  assert.equal(row.status, "installed");
  assert.equal(row.answer, "Default");
  const hist = DB.raw.prepare("SELECT kind, outcome, system_info FROM history ORDER BY id DESC LIMIT 1").get();
  assert.equal(hist.outcome, "recorded");
  assert.ok(!hist.system_info.includes("s3cr3t"), "the token never lands in history");
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
  const json = JSON.parse(JSON.stringify(A.emitJson(doc))); // as served; emitJson builds null-prototype objects
  assert.deepEqual(json, JSON.parse(JSON.stringify(A.parseTomlRaw(toml))));
  assert.equal(json["disk-setup"].zfs.raid, "raid1");
  assert.equal(json["disk-setup"].filter.ID_SERIAL, "KIOXIA*");
  assert.deepEqual(json.network["interface-name-pinning"], { enabled: true, mapping: { "24:8a:07:1e:05:bc": "lan0" } });
  assert.ok(!("comments" in json) && !("must_contain" in json));
});

test("a key segment like __proto__ never reaches Object.prototype", () => {
  for (const key of ["__proto__.POLLUTED", "constructor.prototype.POLLUTED", "x.__proto__"]) {
    assert.throws(() => A.emitJson({ global: { keyboard: "de", [key]: "true" } }), /not allowed/, key);
  }
  assert.equal({}.POLLUTED, undefined);
  assert.equal(Object.prototype.POLLUTED, undefined);
  assert.throws(() => A.parseAnswerToml('[global]\nkeyboard = "de"\n"__proto__".X = "1"\n'), A.ValidationError);
  assert.throws(() => A.normaliseDoc({ global: { keyboard: "de", "constructor.prototype.X": "1" } }), /constructor\.prototype\.X/);
  assert.deepEqual(A.fieldValues({ dmi: {} }, "dmi.constructor.name"), [], "field paths read own properties only");
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

/* ------------------------ configurator CSRF guard ---------------------- */

const apiReq = (method, headers = {}) =>
  new Request("https://autopve.example.com/api/answers/node1/arm", { method, headers });

test("the configurator's own writes pass", () => {
  const same = { "Sec-Fetch-Site": "same-origin", Origin: "https://autopve.example.com" };
  assert.equal(A.crossSiteWriteRefusal(apiReq("POST", { ...same, "Content-Type": "application/json" })), null);
  assert.equal(A.crossSiteWriteRefusal(apiReq("POST", { ...same, "Content-Type": "application/json; charset=utf-8" })), null);
  assert.equal(A.crossSiteWriteRefusal(apiReq("POST", { ...same, "Content-Type": "application/octet-stream" })), null, "file upload");
  assert.equal(A.crossSiteWriteRefusal(apiReq("PUT", same)), null);
  assert.equal(A.crossSiteWriteRefusal(apiReq("DELETE", same)), null);
  assert.equal(A.crossSiteWriteRefusal(apiReq("GET", { "Sec-Fetch-Site": "cross-site" })), null, "reads are not guarded");
});

test("writes another site triggers are refused", () => {
  assert.match(A.crossSiteWriteRefusal(apiReq("POST", { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" })), /cross-site POST/);
  assert.match(A.crossSiteWriteRefusal(apiReq("POST", { "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" })), /same-site/, "a sibling subdomain is another site here");
  assert.match(A.crossSiteWriteRefusal(apiReq("DELETE", { Origin: "https://evil.example" })), /Origin: https:\/\/evil.example/);
  // A plain HTML form: no preflight, so it must fail on the content type even without fetch metadata.
  for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain", ""]) {
    const headers = type ? { "Content-Type": type } : {};
    assert.match(A.crossSiteWriteRefusal(apiReq("POST", headers)), /needs a Content-Type/, type || "(none)");
  }
});

test("non-browser clients (no fetch metadata) pass on content type alone", () => {
  assert.equal(A.crossSiteWriteRefusal(apiReq("POST", { "Content-Type": "application/json" })), null);
  assert.equal(A.crossSiteWriteRefusal(apiReq("PUT", {})), null);
});

/* --------------------- root password hashing (browser) ------------------ */

await import("../public/sha512crypt.js");

test("sha512crypt matches the specification's published vectors", async () => {
  // https://www.akkadia.org/drepper/SHA-crypt.txt, SHA-512 test vectors
  const vectors = [
    ["Hello world!", "saltstring", undefined, "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"],
    ["Hello world!", "saltstringsaltstring", 10000, "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v."],
    ["This is just a test", "toolongsaltstring", 5000, "$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0"],
    ["a very much longer text to encrypt.  This one even stretches over morethan one line.", "anotherlongsaltstring", 1400,
      "$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvMxQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1"],
    ["the minimum number is still observed", "roundstoolow", 10, "$6$rounds=1000$roundstoolow$kUMsbe306n21p9R.FRkW3IGn.S9NPN0x50YhH1xhLsPuWGsUSklZt58jaTfF4ZEQpyUNGc0dqbpBYYBaHHrsX."],
  ];
  for (const [pw, salt, rounds, want] of vectors) assert.equal(await globalThis.sha512crypt(pw, salt, rounds), want);
});

test("sha512crypt uses a fresh 16-character salt and handles non-ASCII passwords", async () => {
  const a = await globalThis.sha512crypt("pässwörd ✓");
  const b = await globalThis.sha512crypt("pässwörd ✓");
  assert.match(a, /^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
  assert.notEqual(a, b, "salted");
});

test("root-password-hashed must be a crypt hash: it goes verbatim into /etc/shadow", () => {
  for (const ok of ["$6$abcdefgh$xyz", "$y$j9T$salt$hash", "$2b$10$abcdefghijklmnopqrstuv"]) {
    assert.equal(A.checkValue("global", "root-password-hashed", ok), null, ok);
  }
  for (const bad of ["hunter2", "$6$has space", "$6$a:b", "$9$x"]) {
    assert.match(A.checkValue("global", "root-password-hashed", bad), /crypt\(3\) hash/, bad);
  }
});

/* ------------------------- relay delivery queue ------------------------ */

async function relayEnv(relayFields = {}) {
  const DB = await d1();
  DB.raw.prepare(
    "INSERT INTO relays (name, url, method, headers, hmac_secret, body_template, enabled, timeout_ms, retries, created_at, updated_at) VALUES (?, ?, 'POST', '{}', '', '', ?, ?, ?, 0, 0)",
  ).run("deploy", "https://target.example/hook", relayFields.enabled ?? 1, relayFields.timeout_ms ?? 1000, relayFields.retries ?? 2);
  DB.raw.prepare("INSERT INTO history (id, ts, kind, outcome, detail, system_info) VALUES (7, 0, 'hook', 'queued', '-> deploy', '{}')").run();
  return { DB };
}
const historyRow = (env) => env.DB.raw.prepare("SELECT outcome, detail FROM history WHERE id = 7").get();
const relayLog = (env) => env.DB.raw.prepare("SELECT attempt, ok, status, error FROM relay_log ORDER BY id").all().map((r) => ({ ...r }));

function fakeMessage(attempts) {
  const m = { body: { relay: "deploy", history_id: 7, payload: { a: 1 }, raw_body: '{"a":1}' }, attempts, acked: false, retried: null };
  m.ack = () => { m.acked = true; };
  m.retry = (opts) => { m.retried = opts ?? {}; };
  return m;
}

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init.body }); return impl(calls.length); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test("queued delivery: success acks and marks the history row relayed", async () => {
  const env = await relayEnv();
  const msg = fakeMessage(1);
  await withFetch(() => new Response("ok", { status: 200 }), async (calls) => {
    await A.handleRelayBatch({ messages: [msg] }, env);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, '{"a":1}');
  });
  assert.equal(msg.acked, true);
  assert.equal(msg.retried, null);
  assert.deepEqual({ ...historyRow(env) }, { outcome: "relayed", detail: "-> deploy (HTTP 200, attempt 1)" });
  assert.deepEqual(relayLog(env), [{ attempt: 1, ok: 1, status: 200, error: "" }]);
});

test("queued delivery: failures back off until the relay's retries are spent", async () => {
  const env = await relayEnv({ retries: 2 });
  await withFetch(() => new Response("nope", { status: 503 }), async () => {
    const first = fakeMessage(1);
    await A.handleRelayBatch({ messages: [first] }, env);
    assert.deepEqual(first.retried, { delaySeconds: 10 });
    assert.equal(historyRow(env).outcome, "retrying");
    assert.match(historyRow(env).detail, /HTTP 503; retry 1 of 2 in 10s/);

    const second = fakeMessage(2);
    await A.handleRelayBatch({ messages: [second] }, env);
    assert.deepEqual(second.retried, { delaySeconds: 20 });

    const last = fakeMessage(3);
    await A.handleRelayBatch({ messages: [last] }, env);
    assert.equal(last.acked, true, "gives up instead of retrying forever");
    assert.equal(last.retried, null);
  });
  assert.deepEqual({ ...historyRow(env) }, { outcome: "error", detail: "-> deploy failed after 3 attempt(s): HTTP 503" });
  assert.deepEqual(relayLog(env).map((r) => r.attempt), [1, 2, 3], "every attempt is logged");
});

test("queued delivery: a relay disabled while a delivery waits is not called", async () => {
  const env = await relayEnv({ enabled: 0 });
  const msg = fakeMessage(2);
  await withFetch(() => { throw new Error("must not be called"); }, async (calls) => {
    await A.handleRelayBatch({ messages: [msg] }, env);
    assert.equal(calls.length, 0);
  });
  assert.equal(msg.acked, true);
  assert.match(historyRow(env).detail, /dropped: the relay was deleted or disabled/);
});

test("retry backoff doubles from 10s and caps at 5 minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(A.retryDelaySeconds), [10, 20, 40, 80, 160, 300, 300]);
});

test("inline delivery stops, and says so, when the next attempt would not fit the time budget", async () => {
  const env = await relayEnv({ retries: 5, timeout_ms: 10_000 });
  const relay = await A.getRelay(env, "deploy");
  // A target that hangs until the timeout: each attempt costs the full 10s on a fake clock.
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  let result;
  try {
    result = await withFetch(() => { clock += 10_000; throw new Error("The operation was aborted due to timeout"); }, (calls) =>
      A.deliver(env, relay, { a: 1 }, '{"a":1}', 7, 25_000).then((r) => ({ r, n: calls.length })));
  } finally {
    Date.now = realNow;
  }
  // 10s attempts in a 25s budget: at 10s the second fits (10 + 0.5 + 10 <= 25), at 20s a third would not.
  assert.equal(result.n, 2);
  assert.match(result.r.error, /stopped after 2 attempt\(s\): no time left .* Bind RELAY_QUEUE/);
  const log = relayLog(env);
  assert.equal(log.length, 3, "two attempts plus the stop notice");
  assert.match(log[2].error, /stopped after 2/);
});

/* ------------------------- structured match rules ---------------------- */

const SYSINFO = {
  product: { fullname: "Proxmox VE", product: "pve" },
  dmi: { system: { serial: "900030XXXX", name: "RS700-E11 Server", uuid: "6fb36fd4-77a1" }, chassis: { serial: "I02308XXXX" } },
  network_interfaces: [{ link: "enp6s18", mac: "00:10:20:30:40:50" }, { link: "enp6s19", mac: "24:8A:07:1E:05:BC" }],
};
const RAW = JSON.stringify(SYSINFO);

test("field paths reach nested values and every element of a list", () => {
  assert.deepEqual(A.fieldValues(SYSINFO, "dmi.system.serial"), ["900030XXXX"]);
  assert.deepEqual(A.fieldValues(SYSINFO, "network_interfaces[].mac"), ["00:10:20:30:40:50", "24:8A:07:1E:05:BC"]);
  assert.deepEqual(A.fieldValues(SYSINFO, "dmi.baseboard.serial"), [], "missing fields have no values");
  assert.deepEqual(A.fieldValues(SYSINFO, "network_interfaces.mac"), [], "a list needs [] to be entered");
});

test("globs follow the installer's filter syntax and ignore case", () => {
  const t = (p, v) => A.globToRegExp(p).test(v);
  assert.equal(t("24:8a:07:*", "24:8A:07:1E:05:BC"), true);
  assert.equal(t("node-??", "node-01"), true);
  assert.equal(t("node-[0-4]?", "node-12"), true);
  assert.equal(t("node-[!0-4]?", "node-12"), false);
  assert.equal(t("a.b", "axb"), false, "dots are literal");
  assert.equal(t("9000*", "x900030"), false, "anchored");
});

test("match rules: all (default) and any", () => {
  const rules = [{ field: "network_interfaces[].mac", pattern: "24:8a:07:1e:05:bc" }, { field: "dmi.system.serial", pattern: "9000*" }];
  assert.equal(A.matches({ match: rules }, RAW), true);
  assert.equal(A.matches({ match: [...rules, { field: "dmi.system.serial", pattern: "1234*" }] }, RAW), false);
  assert.equal(A.matches({ match: [...rules, { field: "dmi.system.serial", pattern: "1234*" }], match_mode: "any" }, RAW), true);
  assert.equal(A.matches({ match: [{ field: "dmi.baseboard.serial", pattern: "*" }] }, RAW), false, "an absent field never matches");
});

test("text filters keep their meaning, alone and alongside rules", () => {
  assert.equal(A.matches({ must_contain: ["RS700"] }, RAW), true);
  assert.equal(A.matches({ must_contain: [] }, RAW), false, "no filters at all never matches");
  const rule = [{ field: "dmi.system.serial", pattern: "9000*" }];
  assert.equal(A.matches({ match: rule, must_not_contain: ["RS700"] }, RAW), false, "must_not_contain still vetoes");
  assert.equal(A.matches({ match: rule, must_contain: ["nope"] }, RAW), false, "set text filters must agree");
  assert.equal(A.matches({ match: rule, must_contain: ["RS700"] }, RAW), true);
});

test("the dry run explains each rule with the values it saw", () => {
  const r = A.evaluateRules(SYSINFO, [{ field: "network_interfaces[].mac", pattern: "00:10:*" }, { field: "dmi.system.sku", pattern: "*" }]);
  assert.deepEqual(r.map((x) => [x.hit, x.values]), [[true, ["00:10:20:30:40:50", "24:8A:07:1E:05:BC"]], [false, []]]);
});

test("rules are validated and normalised on save", () => {
  const out = A.normaliseDoc({ match: [{ field: " dmi.system.serial ", pattern: " 9000* " }, { field: "", pattern: "" }], match_mode: "weird" });
  assert.deepEqual(out.match, [{ field: "dmi.system.serial", pattern: "9000*" }], "trimmed; empty rows dropped");
  assert.equal(out.match_mode, "all");
  assert.throws(() => A.normaliseDoc({ match: [{ field: "dmi..serial", pattern: "x" }] }), /not a field path/);
  assert.throws(() => A.normaliseDoc({ match: [{ field: "dmi.system.serial", pattern: "" }] }), /needs a pattern/);
  assert.ok(!A.emitToml(out).includes("9000"), "rules never reach the answer file");
});

/* ---------------------------- machine tables --------------------------- */

const FLEET = {
  field: "network_interfaces[].mac",
  columns: ["mac", "hostname", "ip", "zfs_arc"],
  rows: [["00:10:20:30:40:5?", "pve1", "10.0.0.11/24", "4096"], ["aa:bb:*", "pve2", "10.0.0.12/24", "2048"]],
};

test("a machine is found by globbing the key column against every value at the field", () => {
  const m = A.findMachine(FLEET, SYSINFO);
  assert.deepEqual(m, { row: 1, key: "00:10:20:30:40:5?", vars: { mac: "00:10:20:30:40:5?", hostname: "pve1", ip: "10.0.0.11/24", zfs_arc: "4096" } });
  assert.equal(A.findMachine(FLEET, { network_interfaces: [{ mac: "ff:ff:ff:ff:ff:ff" }] }), null);
  assert.equal(A.findMachine({ ...FLEET, field: "dmi.system.serial" }, SYSINFO), null);
});

test("placeholders fill from the row, re-typed and checked like any value", () => {
  const doc = { global: { fqdn: "{{ hostname }}.lab.example" }, network: { cidr: "{{ip}}" }, "disk-setup": { "zfs.arc-max": "{{ zfs_arc }}", "disk-list": ["sda", "{{ hostname }}-boot"] } };
  const m = A.findMachine(FLEET, SYSINFO);
  const { doc: out, problems } = A.renderFleet(doc, m);
  assert.deepEqual(problems, []);
  assert.equal(out.global.fqdn, "pve1.lab.example");
  assert.equal(out.network.cidr, "10.0.0.11/24");
  assert.deepEqual(out["disk-setup"]["disk-list"], ["sda", "pve1-boot"], "lists are filled element by element");
  assert.equal(out["disk-setup"]["zfs.arc-max"], 4096, "an int key becomes a number again");
  assert.equal(doc.global.fqdn, "{{ hostname }}.lab.example", "the stored document is untouched");

  assert.match(A.renderFleet(doc, null).problems[0], /no machine table row matches/);
  const bad = A.renderFleet({ network: { cidr: "{{ hostname }}" } }, m).problems;
  assert.match(bad[0], /network.cidr must be an address with prefix length.*row 1/);
});

test("a table routes: an answer with rows claims only machines that have one", () => {
  assert.equal(A.matches({ fleet: FLEET }, RAW), true, "no other filters needed");
  assert.equal(A.matches({ fleet: { ...FLEET, rows: [["ff:*", "x", "y", "1"]] } }, RAW), false);
  assert.equal(A.matches({ fleet: FLEET, must_not_contain: ["RS700"] }, RAW), false);
  assert.equal(A.matches({ fleet: FLEET, match: [{ field: "dmi.system.serial", pattern: "1234*" }] }, RAW), false, "rules must also hold");
  assert.equal(A.matches({ fleet: { ...FLEET, rows: [] }, must_contain: ["RS700"] }, RAW), true, "an empty table changes nothing");
});

test("tables and placeholders are validated on save", () => {
  const ok = A.normaliseDoc({ global: { fqdn: "{{ hostname }}.lab.example" }, fleet: { ...FLEET, rows: [...FLEET.rows, ["", "", "", ""]] } });
  assert.equal(ok.fleet.rows.length, 2, "blank rows dropped");
  assert.equal(ok.global.fqdn, "{{ hostname }}.lab.example", "a placeholder is not format-checked as written");
  assert.throws(() => A.normaliseDoc({ global: { fqdn: "{{ hostnme }}.x.y" }, fleet: FLEET }), /no such column/);
  assert.throws(() => A.normaliseDoc({ network: { cidr: "{{ hostname }}" }, fleet: FLEET }), /row 1 \(00:10:20:30:40:5\?\) gives "pve1"/);
  assert.throws(() => A.normaliseDoc({ global: { "root-password": "{{ hostname }}" }, fleet: FLEET }), /cannot use placeholders/);
  assert.throws(() => A.normaliseDoc({ fleet: { ...FLEET, columns: ["mac", "host-name"] } }), /letters, digits and underscores/);
  assert.throws(() => A.normaliseDoc({ fleet: { ...FLEET, field: "nope..x" } }), /not a field path/);
  assert.throws(() => A.normaliseDoc({ fleet: { ...FLEET, rows: [["", "pve1"]] } }), /has no mac/);
  assert.ok(!A.emitToml(ok).includes("pve2"), "the table never reaches the answer file");
});

test("selection fills Default's placeholders from the winning answer's table", async () => {
  const row = (name, doc, priority) => ({ name, doc: JSON.stringify(doc), priority, serve_mode: "always", armed_until: null, serves_remaining: null,
    allow_cidrs: "[]", secrets_ack: 0, has_secrets: 0, notes: "", created_at: 0, updated_at: 0, updated_by: "" });
  const rows = [
    row("rack", { network: { source: "from-answer", cidr: "{{ ip }}" }, fleet: FLEET }, 10),
    row("Default", { global: { fqdn: "{{ hostname }}.lab.example" }, network: { source: "from-dhcp" } }, 1000),
  ];
  const env = { DB: { prepare: () => ({ all: async () => ({ results: rows }) }) } };
  const hit = await A.selectAnswer(env, RAW);
  assert.equal(hit.record.name, "rack");
  assert.deepEqual(hit.templateProblems, []);
  assert.equal(hit.merged.global.fqdn, "pve1.lab.example");
  assert.equal(hit.merged.network.cidr, "10.0.0.11/24");
  assert.equal(hit.machine.row, 1);
  const miss = await A.selectAnswer(env, JSON.stringify({ network_interfaces: [{ mac: "ff:ff:ff:ff:ff:ff" }] }));
  assert.equal(miss.record.name, "Default");
  assert.match(miss.templateProblems[0], /global.fqdn uses \{\{ hostname \}\} but no machine table row/, "never served half-rendered");
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
  for (const host of [
    "localhost.", "foo.localhost", "2130706433", "127.1", "0x7f.0.0.1", "0.1.2.3", "100.64.0.1", "100.127.255.254",
    "[::]", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[::ffff:a9fe:a9fe]",
    "[fd00::1]", "[fc00::1]", "[fe80::1]", "172.31.0.1", "169.254.169.254",
  ]) assert.throws(() => A.validateRelayUrl(`http://${host}/hook`), /Cloudflare Tunnel/, host);
  for (const host of ["100.128.0.1", "8.8.8.8", "[2606:4700::1111]", "[::ffff:8.8.8.8]", "[2001:db8::fd00]"]) {
    assert.doesNotThrow(() => A.validateRelayUrl(`http://${host}/hook`), host);
  }
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

/* ------------------------------ wrangler.toml ------------------------- */

test("every [vars] key is repeated in [previews.vars], and previews never touch production D1", async () => {
  const { readFileSync } = await import("node:fs");
  const cfg = A.parseTomlRaw(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"));
  // `wrangler preview` (Workers Builds, every PR) refuses to run when a var is missing here.
  const missing = Object.keys(cfg.vars).filter((k) => !(k in (cfg.previews?.vars ?? {})));
  assert.deepEqual(missing, [], "add these to [previews.vars] in wrangler.toml");
  assert.ok(!("DEV_ALLOW_INSECURE_UI" in cfg.previews.vars), "previews must keep Access enforced");
  const prod = cfg.d1_databases.map((d) => d.database_id);
  for (const d of cfg.previews.d1_databases) assert.ok(!prod.includes(d.database_id), `preview binding ${d.binding} points at a production database`);
  // `npm run deploy:preview` migrates the database named by preview_database_id, so it must be the
  // one previews actually bind, and never production.
  for (const d of cfg.d1_databases) {
    const preview = cfg.previews.d1_databases.find((p) => p.binding === d.binding);
    assert.equal(d.preview_database_id, preview?.database_id, `preview_database_id of ${d.binding} must match [[previews.d1_databases]]`);
    assert.notEqual(d.preview_database_id, d.database_id);
  }
});

test("only errors written for the user reach the response; anything else stays in the logs", () => {
  assert.deepEqual(A.publicError(new A.ValidationError("bad name")), { status: 400, message: "bad name" });
  assert.deepEqual(A.publicError(new A.FileError("too big")), { status: 400, message: "too big" });
  assert.deepEqual(A.publicError(new A.AccessError("no token", 401)), { status: 401, message: "no token" });
  const internal = new Error("D1_ERROR: no such table: installs at /src/installs.ts:82");
  internal.status = 400; // a status alone does not make a message safe to show
  assert.deepEqual(A.publicError(internal), { status: 500, message: A.INTERNAL_ERROR });
  assert.deepEqual(A.publicError("thrown string"), { status: 500, message: A.INTERNAL_ERROR });
});

test("trimTrailing strips runs of a character in linear time", () => {
  assert.equal(A.trimTrailing("https://team.cloudflareaccess.com///", "/"), "https://team.cloudflareaccess.com");
  assert.equal(A.trimTrailing("////", "/"), "");
  assert.equal(A.trimTrailing("/answer", "/"), "/answer");
  const long = "/" + "/".repeat(200_000) + "x" + "/".repeat(200_000);
  const t = Date.now();
  assert.equal(A.trimTrailing(long, "/").length, 200_002);
  assert.ok(Date.now() - t < 200);
});

test("a failed relay fetch is described by kind, never by the error itself", () => {
  const timeout = new Error("signal timed out"); timeout.name = "TimeoutError";
  assert.equal(A.fetchFailure(timeout, 5000), "no response within 5000 ms");
  assert.match(A.fetchFailure(new TypeError("internal detail at /x.js:1"), 5000), /^could not connect/);
  for (const e of [new Error("secret internals"), "a string", { stack: "at foo" }]) {
    const out = A.fetchFailure(e, 5000);
    assert.ok(!/secret|string|foo/.test(out), out);
  }
});

test("an Access token must carry a numeric exp; nbf is optional but numeric", async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
  const env = { ACCESS_TEAM_DOMAIN: "jwt-test.cloudflareaccess.com", ACCESS_AUD: "aud1" };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = async (claims) => {
    const head = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: "https://jwt-test.cloudflareaccess.com", aud: "aud1", email: "op@example.com", ...claims })}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(head));
    return `${head}.${Buffer.from(sig).toString("base64url")}`;
  };
  const check = async (claims) => {
    const req = new Request("https://autopve.example.com/api/bootstrap", { headers: { "Cf-Access-Jwt-Assertion": await sign(claims) } });
    try { return (await A.requireIdentity(req, env)).email; } catch (err) { return err.message; }
  };
  const now = Math.floor(Date.now() / 1000);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  try {
    assert.equal(await check({ exp: now + 60 }), "op@example.com");
    assert.equal(await check({ exp: now + 60, nbf: now - 10 }), "op@example.com");
    assert.match(await check({}), /no expiry/);
    assert.match(await check({ exp: String(now + 60) }), /no expiry/);
    assert.match(await check({ exp: now - 120 }), /expired/);
    assert.match(await check({ exp: now + 60, nbf: "0" }), /malformed nbf/);
    assert.match(await check({ exp: now + 60, nbf: now + 120 }), /not yet valid/);
  } finally { globalThis.fetch = real; }
});
