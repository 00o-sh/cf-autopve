# cf-autopve

A port of [`00o-sh/autopve`](https://github.com/00o-sh/autopve) — the GUI configurator for
[Proxmox VE automated installation](https://pve.proxmox.com/wiki/Automated_Installation) answer files —
to a single Cloudflare Worker with D1 storage.

The upstream project is a NiceGUI app that both **builds** answer files and **hosts** them for the
installer to fetch. This port keeps both, but reverses their emphasis: the configurator is the product,
and hosting is an explicitly-armed, audited, guarded mode you opt into per answer. That is deliberate —
an answer file can contain `root-password`, and the Proxmox installer cannot authenticate, so anything
that can reach a live answer endpoint can read whatever that answer holds.

```
  ┌──────────────┐   Cloudflare Access    ┌────────────────────────────┐
  │  you         │ ─────────────────────▶ │  /            configurator │
  └──────────────┘   (JWT verified in     │  /api/*       JSON API     │
                      the Worker too)     └────────────┬───────────────┘
                                                       │  D1 (answers, history,
  ┌──────────────┐   POST system info                  │      relays, files, audit)
  │ PVE          │ ──────────────────────▶ /answer ────┤  credentials AES-256-GCM
  │ installer    │ ◀──── answer.toml ──────────────────┤  encrypted at rest
  └──────┬───────┘                                     │
         │ post-installation-webhook                   │
         └───────────────────────▶ /hook/<relay> ──────┼──▶ your automation
                                                       │    (AWX, CI, n8n, Tunnel)
         first-boot download ────▶ /files/<name> ──────┘
```

## What changed, and why

| upstream | here | why |
|---|---|---|
| NiceGUI server-rendered UI | static HTML/JS + JSON API | Workers have no long-lived Python process |
| `app.storage.general` JSON file | **D1** | durable, queryable, multi-region |
| in-memory history list | `history` table (trimmed to `HISTORY_LIMIT`) | survives restarts, filterable per answer |
| live notifications over websocket | history polling → toasts (5 s, toggleable) | no DO/websocket dependency; same information |
| no auth at all | **Cloudflare Access** on `/` and `/api/*`, verified in the Worker | the configurator is the sensitive surface |
| `ansible-playbook` execution | **outbound webhook relay** (`/hook/<name>`) | a Worker has no shell; relay to something that does |
| SSH keypair tab (for the built-in ansible runner) | *removed* | nothing here SSHes anywhere any more. To get a key onto new nodes, set `root-ssh-keys` in the Global section — the automation target brings its own credentials |
| files on disk (`data/files`) | D1 blobs, optional R2 for large files | no filesystem on Workers |
| secrets stored and served in the clear | encrypted at rest, acknowledged, armed, rate-limited, audited | see below |

Two upstream bugs are fixed along the way: the disk-setup merge compared `disk_list` against a key
actually stored as `disk-list` (so filters and an inherited disk list could both survive a merge), and
`reboot-on-error = "true"` was emitted as a string instead of a TOML boolean.

## Hosting secrets — the part worth reading

An answer file is served to an unauthenticated client, because that is all the Proxmox installer can be.
Every guardrail below narrows *when* and *to whom*; none of them make hosting a plaintext root password
safe in the way a real secret store is.

**The safest path is not to host at all.** Build the answer in the UI, hit **Download answer.toml**, and
bake it into the ISO:

```bash
proxmox-auto-install-assistant prepare-iso pve.iso --fetch-from iso --answer-file answer.toml
```

If you do host:

1. **Encryption at rest.** `root-password`, `root-password-hashed`, and any key that looks like a
   credential (`*password*`, `*secret*`, `*token*`, `*api-key*`, `*private-key*`) are encrypted with
   AES-256-GCM under the `ANSWER_ENC_KEY` Worker secret before they touch D1. A database dump without
   that secret yields `enc:v1:…` and nothing else. **Without `ANSWER_ENC_KEY` set, a credential field
   cannot be saved at all** — the API refuses rather than silently storing plaintext.
2. **Explicit acknowledgement.** An answer that holds a credential will not save until someone ticks the
   acknowledgement (typing `HOST SECRETS`) on the Serving tab. That flag is per answer and recorded.
3. **Armed windows.** Credential-bearing answers default to `serve_mode = "armed"`: they are refused
   until you arm them for N minutes and/or N serves. One install, one arm. `"always"` is rejected for
   such answers unless `ALLOW_ALWAYS_SECRETS=true`.
4. **Source restrictions.** Per-answer IP/CIDR allowlist, an optional deployment-wide `SERVE_TOKEN`
   (`POST /answer/<token>` or the `X-AutoPVE-Token` header), and a per-IP rate limit.
5. **HTTPS required.** Credentials are never served over plain HTTP (`REQUIRE_HTTPS`, default on).
6. **Nothing leaks into history.** Request history stores the response with credentials replaced by
   `REDACTED-BY-AUTOPVE`; the UI preview is redacted too. Revealing or downloading the real values is a
   deliberate action and lands in the audit log with the Access identity that did it.
7. **Denials are recorded.** A refused fetch is written to history with its reason, so probing is visible.
8. **Uploaded files are scanned.** A first-boot script containing something that looks like a password or
   a private key is flagged at upload — `/files/*` is as public as `/answer`.

Prefer `root-password-hashed` over `root-password` (generate with `mkpasswd -m sha-512`). It is still
offline-crackable, so it is still treated as a secret here, but it is not a plaintext password on the wire.

## Deploy

```bash
npm install

# 1. database
npx wrangler d1 create autopve                 # put the returned id in wrangler.toml
npx wrangler d1 migrations apply autopve --remote

# 2. encryption key (required before any credential can be stored)
openssl rand -base64 32 | npx wrangler secret put ANSWER_ENC_KEY

# 3. optional: a token the installer must present
openssl rand -hex 24 | npx wrangler secret put SERVE_TOKEN

# 4. deploy
npx wrangler deploy
```

Then put **Cloudflare Access** in front of the configurator:

1. Zero Trust → Access → Applications → *Add a self-hosted application*.
2. Domain: your Worker's hostname. **Path: leave empty** — the Worker keeps `/answer`, `/hook/*` and
   `/files/*` public itself; Access only needs to cover the browser surface.
   (If you prefer Access to protect only the UI paths, create the app on `/` and a bypass policy for
   `/answer`, `/hook`, `/files`.)
3. Add your policy (email, group, device posture…).
4. Copy the **Application Audience (AUD) tag** into `ACCESS_AUD` and your team domain into
   `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, then redeploy.

The Worker verifies the Access JWT itself — signature against your team's JWKS, `iss`, `aud`, `exp` —
so a request that bypasses the Access hostname still gets nothing. Until those two vars are set, the
configurator refuses to load (fail closed); the installer endpoints keep working.

### Local development

```bash
cp .dev.vars.example .dev.vars     # sets DEV_ALLOW_INSECURE_UI=true and a throwaway ANSWER_ENC_KEY
npx wrangler d1 migrations apply autopve --local
npm run dev
npm test                           # TOML, inheritance, matching, guards, crypto, relay templating
```

`DEV_ALLOW_INSECURE_UI=true` bypasses Access **and says so in a red banner**. Never set it on a
deployment.

## Using it

### Answers

`Default` is the base; every other answer inherits from it and overrides key by key, exactly as upstream.
An answer is chosen by its **filters**: it matches when any *must contain* string appears in the raw JSON
the installer POSTs, and no *must not contain* string does. First match by `priority` (then name) wins;
no match falls back to `Default`. The Filters tab has a dry-run box — paste a `system_info` payload from
History and see which answer would win and whether it would actually be served.

Point the installer at:

```bash
proxmox-auto-install-assistant prepare-iso pve.iso \
  --fetch-from http --url https://autopve.example.com/answer
# with a SERVE_TOKEN configured:
#   --url https://autopve.example.com/answer/<SERVE_TOKEN>
```

### Post-installation webhook relay

Create a relay, then set it in the answer's **Post Install** section:

```toml
[post-installation-webhook]
url = "https://autopve.example.com/hook/deploy"
```

When the installer finishes, it POSTs its system information here; the Worker records it and forwards it
to the relay target in the background (retries with backoff, delivery log per relay). The body is
forwarded verbatim unless you give a template:

```json
{"ref":"main","inputs":{"host":"{{ system_info.dmi.system.name }}","version":"{{ system_info.product.version }}"}}
```

Header values and the signing secret are encrypted at rest like answer credentials. With a signing secret
set, each delivery carries:

```
X-AutoPVE-Timestamp: 1790000000
X-AutoPVE-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
```

Verify it on the receiving end before acting on the payload, and reject stale timestamps:

```python
expected = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
if not hmac.compare_digest(expected, sig.removeprefix("sha256=")) or abs(time.time() - int(ts)) > 300:
    abort(401)
```

The target must be reachable from Cloudflare's network — a LAN address is rejected with an explanation.
Put a Cloudflare Tunnel in front of an internal runner if that is where the work happens.

### First-boot files

Upload under **Files**; reference from an answer:

```toml
[first-boot]
source = "from-url"
ordering = "network-online"
url = "https://autopve.example.com/files/first-boot.sh"
```

Files up to `FILE_MAX_BYTES` (default 1 MB) live in D1; bigger ones need the optional R2 binding in
`wrangler.toml`. Same exposure rule as answers: whatever is here is readable by whoever can reach the URL.

## Configuration reference

| var | default | meaning |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | — | `https://<team>.cloudflareaccess.com`; required |
| `ACCESS_AUD` | — | Access application AUD tag; required |
| `ARM_DEFAULT_MINUTES` | `30` | default length of an arm window |
| `REQUIRE_HTTPS` | `true` | refuse to serve credentials over plain HTTP |
| `ALLOW_ALWAYS_SECRETS` | `false` | permit `serve_mode = "always"` on credential-bearing answers |
| `RATE_LIMIT_PER_MIN` | `30` | per-IP limit on `/answer`, `/hook`, `/files` |
| `FILE_MAX_BYTES` | `1000000` | largest file stored in D1 (D1's hard row limit is 2 MB) |
| `HISTORY_MAX_BYTES` | `131072` | cap on stored `system_info` per history row |
| `HISTORY_LIMIT` | `1000` | history rows retained |
| `DEV_ALLOW_INSECURE_UI` | unset | local only; bypasses Access |
| `ANSWER_ENC_KEY` | secret | base64 32-byte AES-256-GCM key; required to store any credential |
| `SERVE_TOKEN` | secret | optional token the installer must present |

## Endpoints

| route | auth | purpose |
|---|---|---|
| `GET /` | Access | configurator UI |
| `/api/*` | Access | configurator API |
| `POST /answer[/<token>]` | guards | installer fetches its answer file |
| `POST /hook/<relay>[/<token>]` | guards | post-installation webhook → relay |
| `GET /files/<name>[?t=<token>]` | guards | first-boot scripts and downloads |
| `GET /healthz` | none | liveness |

## Layout

```
src/
  index.ts     router; the three public endpoints
  api.ts       Access-gated JSON API for the UI
  access.ts    Cloudflare Access JWT verification (JWKS, iss/aud/exp)
  answers.ts   storage, inheritance, filter matching, masking
  guards.ts    serve decisions: mode, arm window, CIDR, token, HTTPS
  crypto.ts    AES-256-GCM envelope encryption, HMAC, token compare
  relay.ts     outbound webhook relay, templating, delivery log
  toml.ts      answer.toml writer + value coercion
  schema.ts    the Proxmox key catalogue (ported from settings.py)
  files.ts     D1/R2 file hosting + credential scanning
  db.ts        history, audit, rate limiting, sysinfo key learning
public/        the configurator (no build step, no external assets, strict CSP)
migrations/    D1 schema
test/          logic tests (node --test)
```

## Credits

Original project by [natankeddem](https://github.com/natankeddem/autopve) and
[00o-sh](https://github.com/00o-sh/autopve). This is an independent port; bugs here are this port's.
