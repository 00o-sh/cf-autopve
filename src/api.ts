/**
 * JSON API behind Cloudflare Access. Everything the configurator UI does goes
 * through here; nothing in this file is reachable without a verified Access
 * assertion (see index.ts).
 */

import type { Env } from "./env";
import { bool, num } from "./env";
import { requireIdentity, type Identity } from "./access";
import { audit, trimHistory } from "./db";
import {
  DEFAULT_NAME, MASK_MARKER, ValidationError, deleteAnswer, decryptDoc, docHasSecrets, ensureDefaultAnswer,
  getAnswer, lintMerged, listAnswers, maskDoc, mergeDocs, normaliseDoc, saveAnswer, secretKeysIn, selectAnswer, validateName,
  type AnswerRecord, type ServeMode,
} from "./answers";
import { parseAnswerToml } from "./tomlimport";
import { armAnswer, canServe, crossSiteWriteRefusal, defaultArmMinutes, disarmAnswer } from "./guards";
import { deleteFile, listFiles, putFile, FileError, FILE_NAME_RE } from "./files";
import { RELAY_MASK, RelayError, deleteRelay, deliver, getRelay, listRelays, maskRelay, saveRelay } from "./relay";
import { SECTIONS, SECTION_ORDER } from "./schema";
import { FORMATS } from "./validate";
import { emitToml } from "./toml";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const REDACTION = "REDACTED-BY-AUTOPVE";

function errorResponse(err: unknown): Response {
  const status = (err as any)?.status ?? 500;
  const message = (err as Error)?.message ?? "unexpected error";
  if (status >= 500) console.error("api error:", err);
  return json({ error: message }, status);
}

/** Answer as the UI sees it: credential values masked, never plaintext. */
function publicAnswer(record: AnswerRecord) {
  return {
    name: record.name,
    doc: maskDoc(record.doc),
    priority: record.priority,
    serve_mode: record.serve_mode,
    armed_until: record.armed_until,
    serves_remaining: record.serves_remaining,
    allow_cidrs: record.allow_cidrs,
    secrets_ack: record.secrets_ack,
    has_secrets: record.has_secrets,
    secret_keys: secretKeysIn(record.doc),
    notes: record.notes,
    updated_at: record.updated_at,
    updated_by: record.updated_by,
    armed: record.serve_mode === "always" || (record.serve_mode === "armed" && !!record.armed_until && record.armed_until > Date.now()),
  };
}

async function mergedDocFor(env: Env, record: AnswerRecord): Promise<any> {
  if (record.name === DEFAULT_NAME) return record.doc;
  const def = await getAnswer(env, DEFAULT_NAME);
  return mergeDocs(def?.doc ?? {}, record.doc);
}

async function problemsFor(env: Env, record: AnswerRecord): Promise<string[]> {
  return lintMerged(await mergedDocFor(env, record));
}

async function renderToml(env: Env, record: AnswerRecord, reveal: boolean): Promise<string> {
  const merged = await mergedDocFor(env, record);
  const doc = reveal ? await decryptDoc(merged, env) : merged;
  const header =
    `Proxmox VE automated installation answer file\n` +
    `answer: ${record.name} (inherits from ${record.name === DEFAULT_NAME ? "nothing" : DEFAULT_NAME})\n` +
    (docHasSecrets(merged) && !reveal ? `credentials are shown as ${REDACTION} in this preview\n` : "") +
    `generated ${new Date().toISOString()}`;
  return emitToml(doc, { redact: !reveal, redactionText: REDACTION, header });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  let identity: Identity;
  try {
    identity = await requireIdentity(request, env);
  } catch (err) {
    return errorResponse(err);
  }
  const refusal = crossSiteWriteRefusal(request);
  if (refusal) return json({ error: refusal }, 403);
  try {
    return await route(request, env, identity);
  } catch (err) {
    return errorResponse(err);
  }
}

async function route(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method.toUpperCase();
  const head = parts[0] ?? "";

  /* ----------------------------- bootstrap ----------------------------- */
  if (head === "bootstrap" && method === "GET") {
    await ensureDefaultAnswer(env);
    const [answers, relays, files] = await Promise.all([listAnswers(env), listRelays(env), listFiles(env)]);
    return json({
      identity: { email: identity.email, dev: identity.dev },
      answers: answers.map(publicAnswer),
      relays: relays.map((r) => ({ ...maskRelay(r), has_hmac: !!r.hmac_secret })),
      files,
      schema: { sections: SECTIONS, order: SECTION_ORDER, formats: FORMATS },
      config: {
        encryption_configured: !!env.ANSWER_ENC_KEY,
        serve_token_configured: !!env.SERVE_TOKEN,
        access_enforced: !identity.dev,
        allow_always_secrets: bool(env.ALLOW_ALWAYS_SECRETS),
        require_https: bool(env.REQUIRE_HTTPS, true),
        arm_default_minutes: defaultArmMinutes(env),
        file_max_bytes: num(env.FILE_MAX_BYTES, 1_000_000),
        r2_configured: !!env.FILES,
        origin: url.origin,
      },
    });
  }

  /* ------------------------------ answers ------------------------------ */
  if (head === "answers") {
    const name = parts[1];
    const action = parts[2];

    if (!name && method === "GET") return json({ answers: (await listAnswers(env)).map(publicAnswer) });

    if (!name && method === "POST") {
      const body = (await request.json()) as { name: string; copy_from?: string };
      const newName = validateName(body.name);
      if (await getAnswer(env, newName)) throw new ValidationError(`An answer named "${newName}" already exists.`);
      const source = body.copy_from ? await getAnswer(env, body.copy_from) : null;
      if (body.copy_from && !source) throw new ValidationError(`No answer named "${body.copy_from}" to copy.`);
      const record = await saveAnswer(
        env, newName, source?.doc ?? { must_contain: [], must_not_contain: [] },
        { secrets_ack: source?.secrets_ack ?? false, serve_mode: source?.serve_mode, priority: source?.priority, allow_cidrs: source?.allow_cidrs },
        identity.email,
      );
      await audit(env, identity.email, source ? "answer.copy" : "answer.create", newName, source ? `from ${source.name}` : "");
      return json({ answer: publicAnswer(record) }, 201);
    }

    if (!name) return json({ error: "method not allowed" }, 405);
    const record = await getAnswer(env, name);

    if (!action) {
      if (method === "GET") {
        if (!record) return json({ error: "no such answer" }, 404);
        return json({ answer: publicAnswer(record), preview: await renderToml(env, record, false), problems: await problemsFor(env, record) });
      }
      if (method === "PUT") {
        const body = (await request.json()) as { doc: any; settings?: any };
        const settings = body.settings ?? {};
        const saved = await saveAnswer(
          env, validateName(name), body.doc ?? {},
          {
            priority: settings.priority,
            serve_mode: settings.serve_mode as ServeMode | undefined,
            allow_cidrs: settings.allow_cidrs,
            secrets_ack: settings.secrets_ack,
            notes: settings.notes,
          },
          identity.email,
        );
        await audit(env, identity.email, "answer.save", name, saved.has_secrets ? `holds ${secretKeysIn(saved.doc).join(", ")}` : "");
        return json({ answer: publicAnswer(saved), preview: await renderToml(env, saved, false), problems: await problemsFor(env, saved) });
      }
      if (method === "DELETE") {
        await deleteAnswer(env, name);
        await audit(env, identity.email, "answer.delete", name);
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (!record) return json({ error: "no such answer" }, 404);

    if (action === "rename" && method === "POST") {
      const body = (await request.json()) as { to: string };
      const to = validateName(body.to);
      if (name === DEFAULT_NAME) throw new ValidationError("The Default answer cannot be renamed.");
      if (await getAnswer(env, to)) throw new ValidationError(`An answer named "${to}" already exists.`);
      await env.DB.prepare("UPDATE answers SET name = ?, updated_at = ?, updated_by = ? WHERE name = ?")
        .bind(to, Date.now(), identity.email, name).run();
      await audit(env, identity.email, "answer.rename", name, `to ${to}`);
      return json({ answer: publicAnswer((await getAnswer(env, to))!) });
    }

    if (action === "arm" && method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { minutes?: number; serves?: number | null };
      const minutes = Math.min(24 * 60, Math.max(1, Number(body.minutes ?? defaultArmMinutes(env))));
      const serves = body.serves === null || body.serves === undefined ? null : Math.max(1, Number(body.serves));
      if (record.has_secrets && !record.secrets_ack) {
        throw new ValidationError("Acknowledge credential hosting for this answer before arming it.");
      }
      await armAnswer(env, name, minutes, serves);
      await audit(env, identity.email, "answer.arm", name, `${minutes}m, ${serves ?? "unlimited"} serves`);
      return json({ answer: publicAnswer((await getAnswer(env, name))!) });
    }

    if (action === "disarm" && method === "POST") {
      await disarmAnswer(env, name);
      await audit(env, identity.email, "answer.disarm", name);
      return json({ answer: publicAnswer((await getAnswer(env, name))!) });
    }

    if ((action === "preview" || action === "download") && method === "GET") {
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal) {
        if (!env.ANSWER_ENC_KEY && record.has_secrets) throw new ValidationError("ANSWER_ENC_KEY is not configured; credentials cannot be decrypted.");
        await audit(env, identity.email, "answer.reveal", name, `via ${action}`);
      }
      const toml = await renderToml(env, record, reveal);
      if (action === "download") {
        return new Response(toml, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="answer-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.toml"`,
            "Cache-Control": "no-store",
          },
        });
      }
      const merged = await mergedDocFor(env, record);
      return json({ toml, revealed: reveal, secret_keys: secretKeysIn(merged), problems: lintMerged(merged) });
    }

    return json({ error: "method not allowed" }, 405);
  }

  /* -------------------------------- toml ------------------------------- */
  // Pure conversions for the raw editor and file import; nothing is stored.
  // Saving still goes through PUT /answers/<name> and all of its checks.
  if (head === "toml" && parts[1] === "parse" && method === "POST") {
    const body = (await request.json()) as { toml?: string };
    return json(parseAnswerToml(String(body.toml ?? "")));
  }
  if (head === "toml" && parts[1] === "render" && method === "POST") {
    const body = (await request.json()) as { doc?: any };
    const doc = body.doc ?? {};
    let shaped = doc;
    try {
      shaped = normaliseDoc(doc);
    } catch {
      // Show the document as it is; the problem is reported on save.
    }
    const header =
      `only the keys this answer sets; everything else is inherited from ${DEFAULT_NAME}\n` +
      `${MASK_MARKER} keeps a stored credential unchanged; replace it to set a new one`;
    return json({ toml: emitToml(shaped, { header }) });
  }

  /* ------------------------------- match ------------------------------- */
  if (head === "match" && method === "POST") {
    // Dry run: which answer would serve this system_info, and would it be allowed?
    const body = (await request.json()) as { system_info: unknown };
    const raw = JSON.stringify(body.system_info ?? {});
    const selection = await selectAnswer(env, raw);
    if (!selection) return json({ matched: null, reason: "no answers are configured" });
    const decision = canServe(env, selection.record, { request, ip: "203.0.113.1", pathToken: env.SERVE_TOKEN ?? null });
    return json({
      matched: selection.record.name,
      would_serve: decision.allowed,
      reason: decision.reason,
      toml: emitToml(selection.merged, { redact: true, redactionText: REDACTION }),
      problems: lintMerged(selection.merged),
    });
  }

  /* ------------------------------ history ------------------------------ */
  if (head === "history") {
    if (method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
      const since = Number(url.searchParams.get("since") ?? 0);
      const answer = url.searchParams.get("answer");
      let sql = "SELECT id, ts, kind, answer, system_name, ip, outcome, detail, response, system_info FROM history WHERE ts > ?";
      const binds: unknown[] = [Number.isFinite(since) ? since : 0];
      if (answer) {
        sql += " AND answer = ?";
        binds.push(answer);
      }
      sql += " ORDER BY ts DESC LIMIT ?";
      binds.push(limit);
      const res = await env.DB.prepare(sql).bind(...binds).all();
      return json({ history: res.results ?? [] });
    }
    if (method === "DELETE") {
      const body = (await request.json().catch(() => ({}))) as { ids?: number[]; all?: boolean };
      if (body.all) {
        await env.DB.prepare("DELETE FROM history").run();
      } else if (Array.isArray(body.ids) && body.ids.length) {
        const ids = body.ids.slice(0, 90).map(Number).filter(Number.isFinite);
        await env.DB.prepare(`DELETE FROM history WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
      }
      await audit(env, identity.email, "history.delete", body.all ? "all" : String(body.ids?.length ?? 0));
      return json({ ok: true });
    }
  }

  if (head === "sysinfo-keys" && method === "GET") {
    const res = await env.DB.prepare("SELECT k FROM sysinfo_keys ORDER BY last_seen DESC LIMIT 500").all<{ k: string }>();
    return json({ keys: (res.results ?? []).map((r) => r.k) });
  }

  /* ------------------------------- relays ------------------------------ */
  if (head === "relays") {
    const name = parts[1];
    if (!name && method === "GET") return json({ relays: (await listRelays(env)).map((r) => ({ ...maskRelay(r), has_hmac: !!r.hmac_secret })) });
    if (!name) return json({ error: "method not allowed" }, 405);

    if (method === "PUT") {
      const body = (await request.json()) as any;
      const relay = await saveRelay(env, validateName(name), body, identity.email);
      await audit(env, identity.email, "relay.save", name, relay.url);
      return json({ relay: { ...maskRelay(relay), has_hmac: !!relay.hmac_secret } });
    }
    if (method === "DELETE") {
      await deleteRelay(env, name);
      await audit(env, identity.email, "relay.delete", name);
      return json({ ok: true });
    }
    if (parts[2] === "test" && method === "POST") {
      const relay = await getRelay(env, name);
      if (!relay) return json({ error: "no such relay" }, 404);
      const body = (await request.json().catch(() => ({}))) as { system_info?: unknown };
      const payload = body.system_info ?? { test: true, source: "cf-autopve", at: new Date().toISOString() };
      const result = await deliver(env, relay, payload, JSON.stringify(payload), null);
      await audit(env, identity.email, "relay.test", name, `status ${result.status ?? result.error}`);
      return json({ result });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (head === "relay-log" && method === "GET") {
    const relay = url.searchParams.get("relay");
    const res = relay
      ? await env.DB.prepare("SELECT * FROM relay_log WHERE relay = ? ORDER BY ts DESC LIMIT 100").bind(relay).all()
      : await env.DB.prepare("SELECT * FROM relay_log ORDER BY ts DESC LIMIT 100").all();
    return json({ log: res.results ?? [] });
  }

  /* -------------------------------- files ------------------------------ */
  if (head === "files") {
    const name = parts[1];
    if (!name && method === "GET") return json({ files: await listFiles(env) });
    if (name && method === "POST") {
      if (!FILE_NAME_RE.test(name)) throw new FileError("Invalid file name.");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length === 0) throw new FileError("Empty upload.");
      const contentType = request.headers.get("X-File-Type") || "application/octet-stream";
      const { record, warnings } = await putFile(env, name, bytes, contentType, identity.email);
      await audit(env, identity.email, "file.upload", name, warnings.length ? `warnings: ${warnings.join(", ")}` : `${bytes.length} bytes`);
      return json({ file: record, warnings });
    }
    if (name && method === "DELETE") {
      await deleteFile(env, name);
      await audit(env, identity.email, "file.delete", name);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  /* -------------------------------- audit ------------------------------ */
  if (head === "audit" && method === "GET") {
    const res = await env.DB.prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT 200").all();
    return json({ audit: res.results ?? [] });
  }

  if (head === "maintenance" && method === "POST") {
    await trimHistory(env);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
