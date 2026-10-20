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
 * done. `outbound` collects every request the Worker makes to the internet.
 */
async function start(vars = {}) {
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
      return new Response("ok");
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
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", RATE_LIMIT_PER_MIN: "2" });
  try {
    await w.api("/bootstrap");
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await w.installer(SYSINFO)).status);
    assert.deepEqual(codes.slice(2), [429]);
    assert.notEqual((await w.installer(SYSINFO, { "CF-Connecting-IP": "192.0.2.99" })).status, 429, "another client is unaffected");
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
    const leaky = await w.fetch("/api/files/leaky.sh", {
      method: "POST", body: "#!/bin/sh\nexport API_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
      headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    assert.ok((await leaky.json()).warnings.length > 0, "a credential in a hosted file is called out");
  } finally { await w.close(); }
});

test("credentials inherited from Default gate the answer that serves them", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", ANSWER_ENC_KEY: ENC_KEY });
  try {
    await w.api("/bootstrap");
    const base = { ...NODE1, global: { ...NODE1.global, "root-password": "VERIFY-dummy-pw" }, must_contain: [] };
    await w.api("/answers/Default", "PUT", { doc: base, settings: { secrets_ack: true, serve_mode: "off" } });
    const child = await w.api("/answers/rackv", "PUT", { doc: { global: { fqdn: "rackv.lab.example" }, must_contain: ["RS700"] }, settings: {} });
    assert.equal(child.answer.has_secrets, true, "the API reports the inherited credential");
    assert.deepEqual(child.answer.secret_keys, ["global.root-password"]);
    assert.equal(child.answer.serve_mode, "armed");
    await assert.rejects(w.api("/answers/rackv", "PUT", { doc: child.answer.doc, settings: { serve_mode: "always" } }), /"always"/);

    // A child saved before Default held the credential: cached flag clear, serving always.
    await w.db.prepare("UPDATE answers SET serve_mode = 'always', has_secrets = 0 WHERE name = 'rackv'").run();
    const http = "http://autopve.example.com/answer";
    for (const url of ["/answer", http]) {
      const res = await w.installer(SYSINFO, {}, url);
      assert.equal(res.status, 403, url);
      assert.match(await res.text(), /not been acknowledged/);
    }
    let dry = await w.api("/match", "POST", { system_info: SYSINFO });
    assert.equal(dry.matched, "rackv");
    assert.equal(dry.would_serve, false);
    assert.match(dry.reason, /not been acknowledged/);
    await assert.rejects(w.api("/answers/rackv/arm", "POST", { minutes: 5, serves: 1 }), /Acknowledge credential hosting/);

    await w.db.prepare("UPDATE answers SET secrets_ack = 1 WHERE name = 'rackv'").run();
    assert.match(await (await w.installer(SYSINFO)).text(), /"always" mode/);
    await w.db.prepare("UPDATE answers SET serve_mode = 'armed' WHERE name = 'rackv'").run();
    assert.match(await (await w.installer(SYSINFO)).text(), /disarmed/);
    dry = await w.api("/match", "POST", { system_info: SYSINFO });
    assert.equal(dry.would_serve, false);
    assert.match(dry.reason, /disarmed/);

    await w.api("/answers/rackv/arm", "POST", { minutes: 5, serves: 1 });
    assert.match(await (await w.installer(SYSINFO, {}, http)).text(), /plain HTTP/);
    const served = await w.installer(SYSINFO);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("X-AutoPVE-Answer"), "rackv");
    const toml = await served.text();
    assert.match(toml, /root-password = "VERIFY-dummy-pw"/);
    assert.match(toml, /fqdn = "rackv.lab.example"/);
  } finally { await w.close(); }
});

test("a key the current classifier calls a credential is gated even if the cached flag says otherwise", async () => {
  const w = await start({ DEV_ALLOW_INSECURE_UI: "true", ANSWER_ENC_KEY: ENC_KEY });
  try {
    await w.api("/bootstrap");
    // A row saved before global.subscription-key was classified as a credential.
    const doc = { global: { "subscription-key": "pve2c-VERIFYDUMMY02" }, must_contain: ["RS700"], must_not_contain: [] };
    await w.db.prepare(
      `INSERT INTO answers (name, doc, priority, serve_mode, allow_cidrs, secrets_ack, has_secrets, notes, created_at, updated_at, updated_by)
       VALUES ('legacy', ?, 100, 'always', '[]', 0, 0, '', 0, 0, 'test')`,
    ).bind(JSON.stringify(doc)).run();

    for (const url of ["/answer", "http://autopve.example.com/answer"]) {
      const res = await w.installer(SYSINFO, {}, url);
      assert.equal(res.status, 403, url);
      assert.ok(!(await res.text()).includes("VERIFYDUMMY"));
    }
    const { answers } = await w.api("/bootstrap");
    assert.equal(answers.find((a) => a.name === "legacy").has_secrets, true);

    // Maintenance encrypts the plaintext value and corrects the cached flag.
    assert.deepEqual((await w.api("/maintenance", "POST", {})).refreshed, ["legacy"]);
    const row = await w.db.prepare("SELECT doc, has_secrets FROM answers WHERE name = 'legacy'").first();
    assert.ok(!row.doc.includes("VERIFYDUMMY"), "no plaintext left in D1");
    assert.match(row.doc, /enc:v1:/);
    assert.equal(row.has_secrets, 1);
    assert.equal((await w.installer(SYSINFO)).status, 403);
  } finally { await w.close(); }
});
