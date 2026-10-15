/**
 * cf-autopve — Proxmox VE automated-installation answer configurator, on Workers.
 *
 *   /                 configurator UI            (Cloudflare Access required)
 *   /api/*            configurator API           (Cloudflare Access required)
 *   POST /answer      installer answer endpoint  (unauthenticated by nature — see guards.ts)
 *   POST /hook/<name> post-installation webhook -> outbound relay (needs SERVE_TOKEN)
 *   POST /hook        post-installation webhook, install tracking only (needs SERVE_TOKEN)
 *   GET  /files/<n>   first-boot scripts and other hosted files
 *   GET  /healthz     liveness
 */

import type { Env } from "./env";
import { clientIp, num, trimTrailing } from "./env";
import { publicError } from "./errors";
import { AccessError, requireIdentity } from "./access";
import { handleApi } from "./api";
import { addHistory, rateLimited, recordSysinfoKeys, trimHistory } from "./db";
import { decryptDoc, docHasSecrets, lintMerged, selectAnswer, systemName } from "./answers";
import { bodyTokenOk, canServe, claimServe, hookAllowed, tokenOk } from "./guards";
import { serveFile } from "./files";
import { MAX_QUEUED_JOB_BYTES, deliver, getRelay, handleRelayBatch, type RelayJob } from "./relay";
import { emitJson, emitToml, prefersJson } from "./toml";
import { trackAnswer, trackInstalled } from "./installs";

const TEXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = trimTrailing(url.pathname, "/") || "/";

    try {
      if (path === "/healthz") return new Response("ok\n", { headers: TEXT });
      if (path === "/answer" || path.startsWith("/answer/")) return await handleAnswer(request, env, ctx, path);
      if (path === "/hook" || path.startsWith("/hook/")) return await handleHook(request, env, ctx, path);
      if (path.startsWith("/files/")) return await handleFile(request, env, path);
      if (path === "/api" || path.startsWith("/api/")) return await handleApi(request, env);
      return await handleUi(request, env);
    } catch (err) {
      console.error("unhandled:", err);
      return new Response("internal error\n", { status: 500, headers: TEXT });
    }
  },

  async queue(batch: MessageBatch<RelayJob>, env: Env): Promise<void> {
    await handleRelayBatch(batch, env);
  },
};

/* ------------------------------------------------------------------ *
 * Configurator UI (static assets, gated on Access)
 * ------------------------------------------------------------------ */

async function handleUi(request: Request, env: Env): Promise<Response> {
  try {
    await requireIdentity(request, env);
  } catch (err) {
    if (!(err instanceof AccessError)) console.error("ui error:", err);
    const { status, message } = publicError(err);
    return new Response(
      `${message}\n\nThe configurator is protected by Cloudflare Access. ` +
        `The installer endpoints (/answer, /hook, /files) are unaffected.\n`,
      { status, headers: TEXT },
    );
  }
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(res.body, { status: res.status, headers });
}

/* ------------------------------------------------------------------ *
 * POST /answer — what the Proxmox installer talks to
 * ------------------------------------------------------------------ */

async function handleAnswer(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      "This endpoint serves Proxmox answer files to the automated installer, which POSTs its system information here.\n",
      { status: 405, headers: { ...TEXT, Allow: "POST" } },
    );
  }
  const ip = clientIp(request);
  const pathToken = path.startsWith("/answer/") ? path.slice("/answer/".length) : null;

  if (await rateLimited(env, ip, "answer")) {
    return new Response("rate limit exceeded\n", { status: 429, headers: TEXT });
  }

  const rawBody = (await request.text()).slice(0, num(env.HISTORY_MAX_BYTES, 131072) * 4);
  let systemInfo: any = {};
  try {
    systemInfo = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    systemInfo = {};
  }
  const systemInfoRaw = JSON.stringify(systemInfo);

  const selection = await selectAnswer(env, systemInfoRaw);
  if (!selection) {
    return new Response("no answers are configured on this deployment\n", { status: 404, headers: TEXT });
  }
  const record = selection.record;
  const refuse = (reason: string): Response => {
    ctx.waitUntil(
      (async () => {
        await addHistory(env, {
          ts: Date.now(), kind: "answer", answer: record.name, system_name: systemName(systemInfo),
          ip, outcome: "denied", detail: reason, response: "", system_info: systemInfoRaw,
        });
        await recordSysinfoKeys(env, systemInfoRaw);
        // Only a caller holding the token gets a dashboard row: anyone can POST
        // a made-up machine to /answer, and that must not fill the table.
        if (env.SERVE_TOKEN && tokenOk(env, request, pathToken)) {
          await trackAnswer(env, systemInfo, { answer: record.name, status: "refused", detail: reason, ip, systemName: systemName(systemInfo) });
        }
      })(),
    );
    return new Response(`refused: ${reason}\n`, { status: 403, headers: TEXT });
  };

  const decision = canServe(env, record, { request, ip, pathToken });
  if (!decision.allowed) return refuse(decision.reason);
  // Never hand out an answer with a placeholder left in it.
  if (selection.templateProblems.length) return refuse(selection.templateProblems.join(" "));

  // Spend the serve before decrypting anything; a lost claim means a
  // concurrent request took the last serve or the answer was disarmed.
  if (!(await claimServe(env, record))) {
    return refuse(`answer "${record.name}" was disarmed or used up its serves while this request was in flight`);
  }

  const problems = lintMerged(selection.merged);
  const plain = await decryptDoc(selection.merged, env);
  const asJson = (env.ANSWER_FORMAT ?? "auto").toLowerCase() !== "toml" && prefersJson(request.headers.get("Accept"));
  const body = asJson ? JSON.stringify(emitJson(plain)) : emitToml(plain);
  const redacted = emitToml(selection.merged, { redact: true, redactionText: "REDACTED-BY-AUTOPVE" });

  ctx.waitUntil(
    (async () => {
      const id = await addHistory(env, {
        ts: Date.now(), kind: "answer", answer: record.name, system_name: systemName(systemInfo),
        ip, outcome: "served",
        detail: [
          selection.machine ? `machine table row ${selection.machine.row} (${selection.machine.key})` : "",
          docHasSecrets(selection.merged) ? "served with credentials" : "",
          asJson ? "as JSON" : "",
          problems.length ? `installer will likely reject it: ${problems.join(" ")}` : "",
        ].filter(Boolean).join("; "),
        response: redacted, system_info: systemInfoRaw,
      });
      await recordSysinfoKeys(env, systemInfoRaw);
      await trackAnswer(env, systemInfo, { answer: record.name, status: "served", detail: asJson ? "as JSON" : "", ip, systemName: systemName(systemInfo) });
      if (id % 25 === 0) await trimHistory(env);
    })(),
  );

  return new Response(body, {
    headers: {
      ...TEXT,
      // TOML keeps the text/plain it has always been served with.
      ...(asJson ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      "X-AutoPVE-Answer": record.name,
      "X-Robots-Tag": "noindex",
      Vary: "Accept",
    },
  });
}

/* ------------------------------------------------------------------ *
 * POST /hook/<relay> — post-installation webhook relay
 * ------------------------------------------------------------------ */

async function handleHook(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405, headers: { ...TEXT, Allow: "POST" } });
  const segments = path.slice("/hook".length).split("/").filter(Boolean).map(decodeURIComponent);
  const name = segments[0] ?? "";
  const pathToken = segments[1] ?? null;
  const ip = clientIp(request);

  if (!env.SERVE_TOKEN) return new Response(`refused: ${hookAllowed(env, request, pathToken).reason}\n`, { status: 403, headers: TEXT });
  if (await rateLimited(env, ip, "hook")) return new Response("rate limit exceeded\n", { status: 429, headers: TEXT });

  let rawBody = (await request.text()).slice(0, 512 * 1024);
  let payload: any = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = {};
  }
  const bodyToken = payload && typeof payload === "object" ? payload.token : null;
  const decision = hookAllowed(env, request, pathToken, bodyToken);
  if (!decision.allowed) return new Response(`refused: ${decision.reason}\n`, { status: 403, headers: TEXT });

  // Our token authenticated the call; it is not the relay target's business,
  // and it must not land in history either. Any other token value is the
  // receiver's own auth-token and is passed through untouched.
  if (bodyTokenOk(env, bodyToken)) {
    delete payload.token;
    rawBody = JSON.stringify(payload);
  }

  // A token is a credential either way: never into history or the key index.
  const infoRaw = JSON.stringify(payload && typeof payload === "object" && "token" in payload ? { ...payload, token: undefined } : payload);
  const track = () => trackInstalled(env, payload, { ip, systemName: systemName(payload), detail: name ? `reported via /hook/${name}` : "reported" });

  if (!name) {
    // No relay: the webhook only marks the machine installed.
    ctx.waitUntil((async () => {
      await addHistory(env, {
        ts: Date.now(), kind: "hook", answer: null, system_name: systemName(payload), ip,
        outcome: "recorded", detail: "install reported", response: "", system_info: infoRaw,
      });
      await recordSysinfoKeys(env, infoRaw);
      await track();
    })());
    return new Response("accepted\n", { status: 202, headers: TEXT });
  }

  const relay = await getRelay(env, name);
  if (!relay || !relay.enabled) return new Response(`no enabled relay named "${name}"\n`, { status: 404, headers: TEXT });

  const job: RelayJob = { relay: relay.name, history_id: null, payload, raw_body: rawBody };
  const queueable = !!env.RELAY_QUEUE && JSON.stringify(job).length <= MAX_QUEUED_JOB_BYTES;
  const id = await addHistory(env, {
    ts: Date.now(), kind: "hook", answer: null, system_name: systemName(payload), ip,
    outcome: queueable ? "queued" : "relaying", detail: `-> ${relay.name}`, response: "", system_info: infoRaw,
  });
  job.history_id = id;
  ctx.waitUntil((async () => {
    await recordSysinfoKeys(env, infoRaw);
    await track();
  })());

  if (queueable) {
    // Enqueued before the 202, so an accepted payload survives this invocation.
    await env.RELAY_QUEUE!.send(job);
  } else {
    ctx.waitUntil(
      (async () => {
        const result = await deliver(env, relay, payload, rawBody, id);
        const note = env.RELAY_QUEUE ? " (payload too large for the queue, delivered inline)" : "";
        await env.DB.prepare("UPDATE history SET outcome = ?, detail = ? WHERE id = ?")
          .bind(
            result.ok ? "relayed" : "error",
            result.ok ? `-> ${relay.name} (HTTP ${result.status})${note}` : `-> ${relay.name} failed: ${result.error}${note}`,
            id,
          )
          .run();
      })(),
    );
  }

  // The installer only needs to know we took the payload; delivery is async.
  return new Response("accepted\n", { status: 202, headers: TEXT });
}

/* ------------------------------------------------------------------ *
 * GET /files/<name>
 * ------------------------------------------------------------------ */

async function handleFile(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("GET only\n", { status: 405, headers: { ...TEXT, Allow: "GET" } });
  }
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("t");
  const name = decodeURIComponent(path.slice("/files/".length));
  if (!tokenOk(env, request, queryToken)) return new Response("refused: serve token missing or incorrect\n", { status: 403, headers: TEXT });
  if (await rateLimited(env, clientIp(request), "files")) return new Response("rate limit exceeded\n", { status: 429, headers: TEXT });
  return serveFile(env, name);
}
