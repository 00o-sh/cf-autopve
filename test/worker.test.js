/**
 * Integration tests: the real Worker bundle running in workerd (via Miniflare)
 * against a real D1 database with every migration applied, the static assets
 * binding, and outbound fetch captured. Where logic.test.js checks functions,
 * these check what an installer, a browser or a relay target actually sees.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = new URL("../", import.meta.url);
const compatibilityDate = readFileSync(new URL("wrangler.toml", root), "utf8").match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];
const ENC_KEY = "Zm9yLWxvY2FsLWRldi1vbmx5LTMyLWJ5dGUta2V5ISE=";
const TOKEN = "s3cr3t-serve-token";
const ORIGIN = "https://autopve.example.com";

/** Statements of a migration file, comments stripped. */
function statements(sql) {
  return sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
}

/**
 * Start the Worker with `vars`. Returns helpers bound to it; call close() when
 * done. `outbound` collects every request the Worker makes to the internet;
 * `respond` answers them.
 */
async function start(vars = {}, respond = () => new Response("ok")) {
  const outbound = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: new URL(".test-build/worker.mjs", root).pathname,
    compatibilityDate,
    d1Databases: { DB: "autopve-test" },
    assets: { directory: new URL("public", root).pathname, binding: "ASSETS", routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true } },
    bindings: { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "test-aud", ...vars },
    outboundService: async (req) => {
      outbound.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() });
      return respond(req);
    },
  }));
  let db;
  try {
    db = await mf.getD1Database("DB");
    const dir = new URL("migrations/", root);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await db.batch(statements(readFileSync(new URL(f, dir), "utf8")).map((s) => db.prepare(s)));
    }
  } catch (err) {
    await mf.dispose(); // a live workerd would keep the test process from exiting
    throw err;
  }
  const fetch = (path, init = {}) => mf.dispatchFetch(path.startsWith("http") ? path : ORIGIN + path, init);
  /** The configurator's own calls: same-origin JSON, as the UI makes them. */
  const api = async (path, method = "GET", body) => {
    const res = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
    return data;
  };
  const installer = (info, headers = {}, url = "/answer") =>
    fetch(url, { method: "POST", body: JSON.stringify(info), headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10", ...headers } });
  return { mf, db, fetch, api, installer, outbound, close: () => mf.dispose() };
}

const SYSINFO = { dmi: { system: { name: "RS700-E11", serial: "900030XXXX" } }, network_interfaces: [{ link: "eno1", mac: "24:8a:07:1e:05:bc" }] };
const NODE1 = {
  global: { keyboard: "de", country: "at", fqdn: "node1.lab.example", mailto: "root@lab.example", timezone: "Europe/Vienna", "root-password": "hunter2-plaintext" },
  network: { source: "from-dhcp" },
  "disk-setup": { filesystem: "ext4", "disk-list": ["sda"] },
  must_contain: ["RS700"],
};
const BEARER = { Authorization: `Bearer autopve:${TOKEN}` };

test("the configurator is closed without Cloudflare Access; installer endpoints are not", async () => {
  const w = await start();
  try {
    for (const path of ["/", "/api/bootstrap"]) {
      const res = await w.fetch(path);
      assert.equal(res.status, 401, path);
      assert.match(await res.text(), /Access/);
    }
    assert.equal((await w.fetch("/healthz")).status, 200);
    // No answers exist yet (the UI creates Default on first load), but the route answers.
    assert.equal((await w.installer(SYSINFO)).status, 404);
  } finally { await w.close(); }
});

test("the UI is served from assets with a strict CSP and framing denied", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true" });
  try {
    const res = await w.fetch("/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<script src="\/app.js"><\/script>/);
    assert.match(res.headers.get("Content-Security-Policy"), /default-src 'none'; script-src 'self'/);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal((await w.fetch("/app.js")).status, 200);
  } finally { await w.close(); }
});

test("a credential is stored encrypted, served once inside the arm window, and never shown back", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", ANSWER_ENC_KEY: ENC_KEY, SERVE_TOKEN: TOKEN });
  try {
    await w.api("/bootstrap");
    await assert.rejects(w.api("/answers/node1", "PUT", { doc: NODE1, settings: {} }), /contains credentials/);
    const saved = await w.api("/answers/node1", "PUT", { doc: NODE1, settings: { secrets_ack: true } });
    assert.equal(saved.answer.serve_mode, "armed", "an answer with credentials defaults to armed");
    assert.equal(saved.answer.doc.global["root-password"], "__autopve_secret_set__");

    const row = await w.db.prepare("SELECT doc FROM answers WHERE name = 'node1'").first();
    assert.ok(!row.doc.includes("hunter2"), "no plaintext in D1");
    assert.match(row.doc, /enc:v1:/);
    const preview = await w.api("/answers/node1/preview");
    assert.ok(!preview.toml.includes("hunter2") && preview.toml.includes("REDACTED-BY-AUTOPVE"));
    // Revealing is a POST, so the cross-site write guard applies to it.
    for (const action of ["preview", "download"]) {
      await assert.rejects(w.api(`/answers/node1/${action}?reveal=1`), (err) => err.status === 405);
      const forged = await w.fetch(`/api/answers/node1/${action}?reveal=1`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" } });
      assert.equal(forged.status, 403);
    }
    assert.match((await w.api("/answers/node1/preview?reveal=1", "POST", {})).toml, /hunter2-plaintext/);
    const download = await w.fetch("/api/answers/node1/download?reveal=1", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } });
    assert.match(await download.text(), /hunter2-plaintext/);
    const reveals = await w.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'answer.reveal'").first();
    assert.equal(reveals.n, 2, "only the two same-origin POSTs were audited as reveals");

    assert.match(await (await w.installer(SYSINFO)).text(), /serve token missing/);
    assert.match(await (await w.installer(SYSINFO, BEARER)).text(), /disarmed/);

    await w.api("/answers/node1/arm", "POST", { minutes: 5, serves: 1 });
    const served = await w.installer(SYSINFO, BEARER);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("X-AutoPVE-Answer"), "node1");
    const toml = await served.text();
    assert.match(toml, /root-password = "hunter2-plaintext"/);
    assert.match(toml, /fqdn = "node1.lab.example"/);
    assert.match(toml, /\[disk-setup\]\nfilesystem = "ext4"/);

    assert.match(await (await w.installer(SYSINFO, BEARER)).text(), /used up its allowed number of serves/);
    assert.equal((await w.installer(SYSINFO, BEARER, "http://autopve.example.com/answer")).status, 403);

    const { history } = await w.api("/history?limit=10");
    assert.deepEqual(history.map((h) => h.outcome).sort(), ["denied", "denied", "denied", "denied", "served"]);
    const hit = history.find((h) => h.outcome === "served");
    assert.ok(!hit.response.includes("hunter2"), "history keeps a redacted copy");
    assert.ok(history.every((h) => h.ip === "192.0.2.10"));
  } finally { await w.close(); }
});

test("JSON for installers that ask for it, TOML otherwise", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true" });
  try {
    await w.api("/bootstrap");
    await w.api("/answers/Default", "PUT", { doc: { ...NODE1, global: { ...NODE1.global, "root-password": undefined }, must_contain: [] }, settings: { serve_mode: "always" } });
    const asJson = await w.installer(SYSINFO, { Accept: "application/json" });
    assert.match(asJson.headers.get("Content-Type"), /^application\/json/);
    assert.equal((await asJson.json())["disk-setup"].filesystem, "ext4");
    const asToml = await w.installer(SYSINFO);
    assert.match(asToml.headers.get("Content-Type"), /^text\/plain/);
    assert.match(await asToml.text(), /^\[global\]/m);
  } finally { await w.close(); }
});

test("each client IP is rate limited", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", RATE_LIMIT_PER_MIN: "2", SERVE_TOKEN: TOKEN });
  try {
    await w.api("/bootstrap");
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await w.installer(SYSINFO)).status);
    assert.deepEqual(codes.slice(2), [429]);
    assert.notEqual((await w.installer(SYSINFO, { "CF-Connecting-IP": "192.0.2.99" })).status, 429, "another client is unaffected");
    const guesses = [];
    for (let i = 0; i < 3; i++) guesses.push((await w.fetch("/files/x.sh?t=guess", { headers: { "CF-Connecting-IP": "192.0.2.50" } })).status);
    assert.deepEqual(guesses, [403, 403, 429], "wrong-token guesses at /files count against the limit");
  } finally { await w.close(); }
});

test("a webhook is relayed signed, without the serve token, to the configured target", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", ANSWER_ENC_KEY: ENC_KEY, SERVE_TOKEN: TOKEN });
  try {
    await w.api("/relays/deploy", "PUT", { url: "https://automation.example.com/hook", hmac_secret: "relay-hmac", enabled: true });
    const payload = { token: TOKEN, fqdn: "node1.lab.example", dmi: { system: { name: "RS700-E11" } } };
    assert.equal((await w.fetch("/hook/deploy", { method: "POST", body: JSON.stringify({ ...payload, token: "wrong" }) })).status, 403);
    assert.equal(w.outbound.length, 0);

    const res = await w.fetch("/hook/deploy", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });
    assert.equal(res.status, 202);
    for (let i = 0; i < 50 && w.outbound.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.outbound.length, 1);
    const [sent] = w.outbound;
    assert.equal(sent.url, "https://automation.example.com/hook");
    const body = JSON.parse(sent.body);
    assert.equal(body.fqdn, "node1.lab.example");
    assert.ok(!("token" in body) && !sent.body.includes(TOKEN), "the serve token is not forwarded");
    assert.match(sent.headers["x-autopve-signature"], /^sha256=[0-9a-f]{64}$/);
    const { createHmac } = await import("node:crypto");
    const expect = createHmac("sha256", "relay-hmac").update(`${sent.headers["x-autopve-timestamp"]}.${sent.body}`).digest("hex");
    assert.equal(sent.headers["x-autopve-signature"], `sha256=${expect}`, "the receiver can verify it");
  } finally { await w.close(); }
});

test("a relay target's redirect is not followed, so its credentials go nowhere else", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", ANSWER_ENC_KEY: ENC_KEY, SERVE_TOKEN: TOKEN },
    () => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example.net/steal" } }));
  try {
    await w.api("/relays/deploy", "PUT", { url: "https://automation.example.com/hook", headers: { "X-Api-Key": "k-123" }, hmac_secret: "h", retries: 0 });
    const { result } = await w.api("/relays/deploy/test", "POST", {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 307);
    assert.match(result.error, /redirects are not followed/);
    assert.deepEqual(w.outbound.map((r) => r.url), ["https://automation.example.com/hook"]);
  } finally { await w.close(); }
});

test("changing a relay's URL drops its stored credentials instead of sending them to the new target", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", ANSWER_ENC_KEY: ENC_KEY });
  try {
    const { relay } = await w.api("/relays/deploy", "PUT", { url: "https://a.example.com/h", headers: { "X-Api-Key": "k-123" }, hmac_secret: "h" });
    const masked = { headers: relay.headers, hmac_secret: relay.hmac_secret };
    // Same URL: masked values keep what is stored.
    assert.deepEqual(Object.keys((await w.api("/relays/deploy", "PUT", { url: "https://a.example.com/h", ...masked })).relay.headers), ["X-Api-Key"]);
    await assert.rejects(w.api("/relays/deploy", "PUT", { url: "https://b.example.com/h", ...masked }), /URL changed.*Re-enter/);
    await assert.rejects(w.api("/relays/deploy", "PUT", { url: "https://b.example.com/h", hmac_secret: masked.hmac_secret }), /URL changed/);
    // Omitting the headers on a retarget does not carry the stored ones over either.
    const moved = (await w.api("/relays/deploy", "PUT", { url: "https://b.example.com/h" })).relay;
    assert.deepEqual(moved.headers, {});
    assert.equal(moved.hmac_secret, "");
  } finally { await w.close(); }
});

test("hosted files need the serve token, and uploads that look like they hold a credential are flagged", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", SERVE_TOKEN: TOKEN });
  try {
    const script = "#!/bin/sh\necho first boot\n";
    const up = await w.fetch("/api/files/first-boot.sh", {
      method: "POST", body: script,
      headers: { "Content-Type": "application/octet-stream", "X-File-Type": "text/x-shellscript", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(up.status, 200);
    assert.deepEqual((await up.json()).warnings, []);
    assert.equal((await w.fetch("/files/first-boot.sh")).status, 403);
    const got = await w.fetch(`/files/first-boot.sh?t=${TOKEN}`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), script);
    assert.equal(got.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'");
    assert.equal(got.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(got.headers.get("Content-Disposition"), null, "a script is served inline for the installer");
    await w.fetch("/api/files/page.html", {
      method: "POST", body: "<script>fetch('/api/answers')</script>",
      headers: { "Content-Type": "application/octet-stream", "X-File-Type": "text/html", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    const page = await w.fetch(`/files/page.html?t=${TOKEN}`);
    assert.equal(page.headers.get("Content-Disposition"), "attachment", "active content is never rendered on this origin");
    assert.equal(page.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'");
    assert.equal((await w.fetch(`/files/%E0%A4%A?t=${TOKEN}`)).status, 404, "a malformed escape is not found, not a 500");
    assert.equal((await w.fetch("/hook/%E0%A4%A", { method: "POST", body: "{}" })).status, 404);
    const leaky = await w.fetch("/api/files/leaky.sh", {
      method: "POST", body: "#!/bin/sh\nexport API_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
      headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    assert.ok((await leaky.json()).warnings.length > 0, "a credential in a hosted file is called out");
  } finally { await w.close(); }
});

/** Poll until `check` holds: history and key writes run in waitUntil, after the response. */
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("condition not reached");
}

const count = async (w, table) => (await w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test("unauthenticated refusals leave a bounded history with short excerpts and no learned keys", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", SERVE_TOKEN: TOKEN, HISTORY_LIMIT: "5", RATE_LIMIT_PER_MIN: "0" });
  try {
    await w.api("/bootstrap");
    const big = { ...SYSINFO, pad: "x".repeat(200000) };
    for (let i = 0; i < 300; i++) big[`k${i}`] = `v${i}`;
    for (let i = 0; i < 50; i++) assert.equal((await w.installer(big)).status, 403);
    await eventually(async () => (await count(w, "history")) <= 5 + 24);
    const rows = (await w.db.prepare("SELECT outcome, LENGTH(system_info) AS len FROM history").all()).results;
    assert.ok(rows.every((r) => r.outcome === "denied" && r.len <= 2048), "only a short excerpt is kept");
    assert.equal(await count(w, "sysinfo_keys"), 0);
  } finally { await w.close(); }
});

test("refusals of a token holder still learn keys, capped in length, and maintenance bounds the key table", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", SERVE_TOKEN: TOKEN });
  try {
    await w.api("/bootstrap");
    await w.api("/answers/Default", "PUT", { doc: { ...NODE1, global: { ...NODE1.global, "root-password": undefined }, must_contain: [] }, settings: { serve_mode: "off" } });
    assert.equal((await w.installer({ ...SYSINFO, long: "y".repeat(1000) }, BEARER)).status, 403);
    await eventually(async () => (await count(w, "sysinfo_keys")) > 0);
    const keys = (await w.db.prepare("SELECT k FROM sysinfo_keys").all()).results.map((r) => r.k);
    assert.ok(keys.includes('"name":"RS700-E11"'));
    assert.ok(keys.every((k) => k.length <= 256), "an oversized key is not learned");

    const insert = w.db.prepare("INSERT INTO sysinfo_keys (k, last_seen) VALUES (?, ?)");
    await w.db.batch(Array.from({ length: 2100 }, (_, i) => insert.bind(`"filler":"${i}"`, i)));
    await w.api("/maintenance", "POST", {});
    assert.equal(await count(w, "sysinfo_keys"), 2000);
    assert.ok(await w.db.prepare(`SELECT 1 FROM sysinfo_keys WHERE k = '"name":"RS700-E11"'`).first(), "the newest keys are kept");
  } finally { await w.close(); }
});

test("IPv6 clients share one rate-limit budget per /64", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", RATE_LIMIT_PER_MIN: "2" });
  try {
    await w.api("/bootstrap");
    const codes = [];
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:ffff::5", "2001:0db8:0001:0002::9"]) {
      codes.push((await w.installer(SYSINFO, { "CF-Connecting-IP": ip })).status);
    }
    assert.equal(codes[2], 429, "a third address in the same /64 is over the limit");
    assert.notEqual((await w.installer(SYSINFO, { "CF-Connecting-IP": "2001:db8:1:3::1" })).status, 429, "another /64 is unaffected");
  } finally { await w.close(); }
});
