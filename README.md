# cf-autopve

A port of [`00o-sh/autopve`](https://github.com/00o-sh/autopve), the GUI configurator for
[Proxmox VE automated installation](https://pve.proxmox.com/wiki/Automated_Installation) answer files,
to a single Cloudflare Worker with D1 storage.

The upstream project is a NiceGUI app that both **builds** answer files and **hosts** them for the
installer to fetch. This port keeps both, but reverses their emphasis: the configurator is the product,
and hosting is an explicitly-armed, audited, guarded mode you opt into per answer. That is deliberate:
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
| SSH keypair tab (for the built-in ansible runner) | *removed* | nothing here SSHes anywhere any more. To get a key onto new nodes, set `root-ssh-keys` in the Global section; the automation target brings its own credentials |
| files on disk (`data/files`) | D1 blobs, optional R2 for large files | no filesystem on Workers |
| secrets stored and served in the clear | encrypted at rest, acknowledged, armed, rate-limited, audited | see below |

This port also fixes two upstream bugs: the disk-setup merge compared `disk_list` against a key
actually stored as `disk-list` (so filters and an inherited disk list could both survive a merge), and
`reboot-on-error = "true"` was emitted as a string instead of a TOML boolean.

## Hosting secrets

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
   cannot be saved at all.** The API refuses rather than silently storing plaintext.
2. **Explicit acknowledgement.** An answer that holds a credential will not save until someone ticks the
   acknowledgement (typing `HOST SECRETS`) on the Serving tab. That flag is per answer and recorded.
3. **Armed windows.** Credential-bearing answers default to `serve_mode = "armed"`: they are refused
   until you arm them for N minutes and/or N serves. One install, one arm. `"always"` is rejected for
   such answers unless `ALLOW_ALWAYS_SECRETS=true`. The serve count is spent atomically in D1 *before*
   anything is decrypted, so a burst of concurrent fetches against an answer armed for one serve gets
   exactly one answer; the rest are refused and recorded.
4. **Source restrictions.** Per-answer IP/CIDR allowlist, an optional deployment-wide `SERVE_TOKEN`,
   and a per-IP rate limit. The token can be sent in any of these ways, best first:
   - `Authorization: Bearer <name>:<token>`, which the installer sends when the ISO is built with
     `--answer-auth-token` (PVE 9.2+)
   - the `X-AutoPVE-Token` header
   - a path segment, `POST /answer/<token>`, for older installers that only take a URL. This puts the
     token in URLs and logs.

   The allowlist is the only per-answer access control: **filters are for routing, not security** (see
   [Answers](#answers)).
5. **HTTPS required.** Credentials are never served over plain HTTP (`REQUIRE_HTTPS`, default on).
6. **Nothing leaks into history.** Request history stores the response with credentials replaced by
   `REDACTED-BY-AUTOPVE`; the UI preview is redacted too. Revealing or downloading the real values is a
   deliberate action and lands in the audit log with the Access identity that did it.
7. **Denials are recorded.** A refused fetch is written to history with its reason, so probing is visible.
8. **Uploaded files are scanned.** A first-boot script containing something that looks like a password or
   a private key is flagged at upload, because `/files/*` is as public as `/answer`.
9. **No cross-site writes.** The configurator API is authenticated by the Access cookie, which a
   browser may attach to a request another site triggers. Every write must come from this origin
   (`Sec-Fetch-Site` / `Origin`), and a POST must carry a JSON or octet-stream body, which a plain HTML
   form or a no-CORS fetch cannot send. Scripts using an Access service token are unaffected: they send
   no fetch metadata and pass on the content type.

Prefer `root-password-hashed` over `root-password`. It is still offline-crackable, so it is still treated
as a secret here, but it is not a plaintext password on the wire. The configurator makes one for you:

- **Hash it** (next to `root-password`) replaces the typed password with `root-password-hashed`.
- **Set from password…** (next to `root-password-hashed`) asks for a password twice, without echoing it.

Both compute SHA-512-crypt (`$6$`, the same as `mkpasswd -m sha-512` and `openssl passwd -6`) in your
browser with a fresh random salt, so the plaintext is never sent, stored or served; only the hash is
saved, encrypted like any other credential. Because the installer writes `root-password-hashed`
verbatim into `/etc/shadow`, a value that is not a crypt(3) hash is refused on save rather than locking
root out.

## Deploy

```bash
npm ci                              # Node 22+ (see .nvmrc); installs exactly the lockfile

# 1. database
npx wrangler d1 create autopve                 # put the returned id in wrangler.toml
npx wrangler d1 migrations apply autopve --remote   # first time; `npm run deploy` does it from then on

# 2. encryption key (required before any credential can be stored)
openssl rand -base64 32 | npx wrangler secret put ANSWER_ENC_KEY

# 3. a token the installer must present (optional for /answer and /files, required for relays)
openssl rand -hex 24 | npx wrangler secret put SERVE_TOKEN

# 4. deploy: applies any pending migrations, then deploys
npm run deploy
```

**Migrations run on every deploy.** `npm run deploy` applies pending migrations in `migrations/` to the
production database, then deploys; when a migration fails, nothing is deployed. With Workers Builds, set
the deploy command (Settings → Build → Deploy command) to `npm run deploy`, and give the build's API
token **D1: Edit** in addition to Workers Scripts: Edit. Migrations run *before* the new code goes live,
so the old code runs against the new schema for a moment: keep migrations additive (new tables and
nullable columns), never rename or drop in the same release that stops using something.
To see what a deploy would apply: `npx wrangler d1 migrations list autopve --remote` (add `--preview`
for the preview database).
If a build of `main` logs `wrangler preview` rather than `wrangler deploy`, the two deploy commands are
swapped: production stays on its previous version even though the build reports success.

Then put **Cloudflare Access** in front of the configurator:

1. Zero Trust → Access → Applications → *Add a self-hosted application* for the configurator.
   Domain: your Worker's hostname, **path empty**. Policy: **Allow**, include your email or group
   (add device posture etc. as you like).
2. Add a **second** self-hosted application for the installer endpoints, with three destinations on the
   same hostname: paths `answer`, `hook` and `files` (each covers its sub-paths). Policy: **Bypass**,
   include your lab's public IP range (or Everyone if installs can come from anywhere).

   The second app is required: Access sits in front of the Worker, so with only the first app the
   installer gets a login page instead of its answer. It has to be a separate app because Access
   policies apply to every path in an app. Access picks the most specific app by path first, so these
   three paths land on the Bypass app and everything else on the login app. The Worker's own guards
   (arming, allowlists, token, rate limit) still apply behind the bypass.
3. Copy the **configurator** app's **Application Audience (AUD) tag** into `ACCESS_AUD` and your team
   domain into `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, then redeploy. The installer app's AUD is not
   used: bypassed requests carry no Access token.

The Worker verifies the Access JWT itself (signature against your team's JWKS, `iss`, `aud`, `exp`),
so a request that bypasses the Access hostname still gets nothing. Until those two vars are set, the
configurator refuses to load (fail closed); the installer endpoints keep working.

### PR previews (Workers Builds)

If the repository is connected to Workers Builds, every PR runs a preview build (by default
`npx wrangler preview`), which needs the `[previews]` block in `wrangler.toml`. Set the non-production
branch deploy command to `npm run deploy:preview` so the preview database is migrated first.

- Previews bind their own D1 database (`autopve-preview`), never production: a preview runs a PR's code
  before anyone has reviewed it. `preview_database_id` on the production binding names the same
  database, which is how `npm run db:migrate:preview` finds it; `npm test` checks the two agree. A PR
  that adds a migration applies it to the preview database only; production gets it on merge.
- `[previews.vars]` must repeat every key in `[vars]`, or the preview build fails. `npm test` checks this.
- The Access values are production's. The preview hostname isn't covered by the Access application, so
  the preview UI answers 401 and only the installer endpoints respond. Don't set `DEV_ALLOW_INSECURE_UI`
  there. Previews get no secrets unless you add them with `npx wrangler preview secret put`.

### Local development

```bash
cp .dev.vars.example .dev.vars     # sets DEV_ALLOW_INSECURE_UI=true and a throwaway ANSWER_ENC_KEY
npx wrangler d1 migrations apply autopve --local
npm run dev
npm test                           # logic tests, then the built Worker in workerd (Miniflare) against a
                                   # migrated D1: Access gate, serving, relays, files
```

`DEV_ALLOW_INSECURE_UI=true` bypasses Access **and says so in a red banner**. Never set it on a
deployment.

### Dependencies

Dev dependencies are pinned to exact versions (`.npmrc` sets `save-exact`) and the lockfile is the
source of truth, so use `npm ci`, not `npm install`, unless you are changing a dependency.
`engine-strict` refuses a Node older than wrangler supports.

[Renovate](https://docs.renovatebot.com/) keeps them current (`renovate.json`, `config:best-practices`):

- PRs open before 6am on Mondays (America/Toronto), at most five at a time, and only for releases at
  least 3 days old (7 for `@cloudflare/workers-types`, which publishes daily). Security fixes skip
  both waits.
- `wrangler`, `miniflare`, `@cloudflare/workers-types` and `esbuild` arrive as one PR: wrangler pins a
  minimum workers-types as a peer, so bumping them separately fails to install, and the integration
  tests import the same Miniflare wrangler bundles.
- Minor and patch dev-tool updates and GitHub Actions digest bumps automerge once CI passes. Majors
  wait for review; a Node major also needs approval on the Dependency Dashboard issue.
- The lockfile is refreshed on the first of each month.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm audit signatures`, typecheck, tests, a
`wrangler deploy --dry-run` bundle and shellcheck on every PR, which is what automerge waits on.

Security scanning runs alongside it:

| workflow | runs | checks |
| --- | --- | --- |
| `codeql.yml` | PRs, `main`, weekly | CodeQL `security-extended` over the TypeScript/JavaScript and over the workflows themselves |
| `security.yml` → dependency review | PRs | new or upgraded dependencies against GitHub's advisory database; fails on moderate or worse |
| `security.yml` → npm audit | PRs, `main`, daily | the lockfile: runtime dependencies (what the Worker ships) fail on moderate, build/test tooling on high |
| `security.yml` → zizmor | PRs, `main`, daily | the workflow files: template injection, over-broad permissions, persisted credentials, unpinned actions |

CodeQL and zizmor findings land in the repository's **Security → Code scanning** tab. Secret scanning
and push protection are repository settings rather than workflows: turn them on under
**Settings → Code security** (free for public repositories).

For a source audit beyond what the scanners catch, `.claude/skills/security-audit` vendors Cloudflare's
[security-audit skill](https://github.com/cloudflare/security-audit-skill) (MIT; pinned commit in its
`VENDORED.md`). In Claude Code on this repository, ask for "a security audit of this repo": it maps the
trust boundaries, hunts with isolated agents, has every candidate checked by a separate verifier, and
writes the report outside the repository. CodeQL skips that directory.

## Using it

### Answers

`Default` is the base; every other answer inherits from it and overrides key by key, exactly as upstream.
An answer is chosen by its **filters**. First match by `priority` (then name) wins; no match falls back
to `Default`. The Filters tab has a dry-run box: paste a `system_info` payload from History and see which
answer would win, which rules hit (and against which values), and whether it would actually be served.

**Match rules** test one field of the posted `system_info` against a glob:

| field | example pattern |
| --- | --- |
| `network_interfaces[].mac` | `24:8a:07:1e:05:bc` |
| `dmi.system.serial` | `9000*` |
| `dmi.system.uuid`, `dmi.system.name`, `dmi.system.sku` | `PowerEdge R6*` |
| `dmi.baseboard.serial`, `dmi.chassis.serial`, `dmi.chassis.asset_tag` | `ASSET-0[0-4]?` |
| `product.product`, `iso.release` | `pve`, `9.*` |

- A field is a dotted path; `[]` means "any element of this list", so the MAC rule matches if any NIC
  has that address. Any path works; the list above is what the editor suggests.
- Patterns are anchored, case-insensitive globs: `*` any run, `?` one character, `[abc]` / `[!a]` sets.
- *All rules* requires every rule to hit; *any rule* requires one.
- The older **text filter** is still there: *must not contain* vetoes an answer whenever one of its
  strings appears anywhere in the raw JSON. With no rules, *must contain* alone decides as before (any
  string present). With rules, a non-empty *must contain* must also hit.

> **Filters are for routing, not security.** They match against the JSON the client POSTs, and the
> client writes that JSON. Anyone who can reach `/answer` can claim any MAC address, serial number or
> product name and so pick which answer they are offered. What actually stops an answer being handed
> out is its serve mode, arm window and serve budget, its IP/CIDR allowlist, and the `SERVE_TOKEN`.
> If two nodes must not be able to get each other's credentials, give each answer an allowlist and arm
> it only while that node is installing.

#### Versions: what changed, and undo

Every save of an answer is kept as a version (the newest `ANSWER_VERSIONS_KEEP`, default 50, per
answer). The **Versions** tab lists them with who saved and why (*save*, *created*, *copy of X*,
*restore of #N*). Pick one to see the line diff of what it changed, or how the current state differs
from it, and **Restore** it.

- A restore goes through the same checks as a save and is recorded as a new version, so it can be
  undone too. It brings back the document, priority, serve mode, allowlist and notes; it does not arm
  the answer or acknowledge credentials for it.
- The diff covers the answer's keys and comments, its filters, and its serving settings. Credentials
  appear as `(stored credential 1a2b3c4d)`, a fingerprint of the ciphertext: you can see that a
  password changed, never what it is. Versions store credentials encrypted, like the answer itself.
- History follows renames and is removed with the answer. Answers saved before upgrading start their
  history at the next save, which also records the state they had until then.
- Versions need migration `0002`; without it answers still save, and the tab shows the error.

#### Machine tables: one answer for a rack of machines

Instead of one answer per node, give an answer a **machine table** (Filters tab) and use `{{ column }}`
placeholders in its values:

```csv
mac,hostname,ip
24:8a:07:1e:05:bc,pve1,10.0.0.11/24
24:8a:07:1e:05:bd,pve2,10.0.0.12/24
```

```toml
[global]
fqdn = "{{ hostname }}.lab.example"

[network]
source = "from-answer"
cidr = "{{ ip }}"
```

- The first column is the key, compared (as a glob, case-insensitive) with the **key field**, by default
  `network_interfaces[].mac`. `dmi.system.serial` works just as well. Paste CSV, edit it in place, or
  *Load CSV…*; comma, semicolon and tab delimited files all load.
- An answer with rows only claims machines that have a row, so the table is its routing as well.
  Match rules and text filters, if also set, must agree.
- When served, the machine's row fills the placeholders, including ones inherited from `Default`. An
  answer without a table uses `Default`'s. A placeholder that can't be filled (no row, no such column,
  an empty cell) refuses the request with the reason in History; a half-rendered answer is never served.
- On save every row is rendered and checked like a typed value, so `ip = not-an-ip` on row 7 is refused
  before any install starts. Columns must be names (`hostname`, `zfs_arc`), and integer or boolean keys
  are re-typed after filling in (`zfs.arc-max = "{{ zfs_arc }}"` serves as a number).
- Credentials can't use placeholders: the table is stored unencrypted. The table is configurator
  metadata and never appears in the answer file.

#### Importing and editing as TOML

- **import** (sidebar) creates a new answer from an existing `answer.toml`.
- **Edit TOML** (answer tab) shows the keys that answer sets as a plain `answer.toml`. Edit it, paste
  over it, or *Load file…*, then *Apply to editor* and Save as usual. Every check that applies to the
  form applies here too.

Either way, the file is parsed with a real TOML parser and mapped onto the editor:

- Deprecated `snake_case` keys (PVE 9.0+ warns about them) are renamed to kebab-case, for example
  `root_password` → `root-password` and `[disk_setup]` → `[disk-setup]`. udev property names under
  `filter.` keep their underscores.
- A `# comment` line directly above a key is kept as that key's comment and written back out.
- Sections and keys the installer doesn't understand are listed and dropped, not guessed at.
- Stored credentials show as `__autopve_secret_set__`. Leave the marker to keep the stored value, or
  replace it to set a new one; plaintext never comes back from the server.
- An imported answer that holds credentials is switched to `armed` and still needs the acknowledgement
  on the Serving tab before it saves.

Filters (`match`, `match_mode`, `must_contain`, `must_not_contain`) and the machine table are configurator metadata, not part of the file, and are
left as they are.

#### Answer file coverage

The key catalogue follows the current
[Proxmox Automated Installation](https://pve.proxmox.com/wiki/Automated_Installation) reference,
including `global.subscription-key` and `post-installation-webhook.auth-token` (PVE 9.2+, both treated
as credentials), NIC name pinning with or without a MAC mapping (PVE 9.1+), and the documented udev
filter properties for disks and NICs. Any other udev property also works as `filter.<NAME>`.

Combinations the installer rejects are refused on save, with the reason:

- `root-password` together with `root-password-hashed`
- `fqdn` together with `fqdn.source` / `fqdn.domain`
- `disk-list` together with a disk filter
- `network.source = "from-dhcp"` together with `cidr`, `dns`, `gateway` or a NIC filter

Across inheritance, whichever alternative an answer sets replaces Default's. For example, an answer
using `root-password-hashed` drops Default's `root-password`, and one switching to `from-dhcp` drops
Default's static addressing.

#### What the installer will actually receive

An answer can be valid on its own and still combine with Default into something the installer rejects.
For example, an answer that adds a static `cidr` while Default says `from-dhcp`. The merged answer is
checked against the installer's rules: required keys, exactly one root password, `from-answer`
addressing, a disk selection, `zfs.raid`/`btrfs.raid`, filesystem-specific options, and first-boot and
webhook URLs. Problems show on the **answer.toml** tab, after Save, and in the Filters dry run. A
served request that would fail is noted in History. The check never blocks saving or serving: it
tells you why an install would fail before you boot.

#### JSON or TOML

The installer advertises both in its `Accept` header and prefers JSON. `/answer` replies with JSON
when the request prefers it, with the same structure a TOML parser reads from the TOML answer, and with
TOML (as `text/plain`, as before) otherwise. Set `ANSWER_FORMAT = "toml"` to always send TOML.

Point the installer at it by building an ISO with `scripts/build-iso.sh`. It downloads the PVE release
(newest by default) from Proxmox, checks it against their `SHA256SUMS`, and runs
`proxmox-auto-install-assistant prepare-iso` with your answer URL. When the assistant and `xorriso`
aren't installed (any non-Debian jumpbox), it runs them in a throwaway `debian` container via docker or
podman instead:

```bash
scripts/build-iso.sh --url https://autopve.example.com              # prompts for SERVE_TOKEN, hidden
scripts/build-iso.sh --url https://autopve.example.com --version 9.2-1 --out /srv/iso
AUTOPVE_TOKEN=… scripts/build-iso.sh --url … --first-boot dns.sh    # bake a first-boot script in
```

One ISO serves every node; rebuild only for a new PVE release or a new token. When the assistant
supports `--answer-auth-token` (PVE 9.2+), the script uses it, so the token travels as an
`Authorization` header and stays out of the URL. With an older assistant, or with `--token-in-url`,
it goes in the URL path instead. Either way the token ends up inside the ISO, so treat the ISO as a
secret. The equivalent manual command is:

```bash
proxmox-auto-install-assistant prepare-iso pve.iso --fetch-from http \
  --url https://autopve.example.com/answer --answer-auth-token "autopve:<SERVE_TOKEN>"
# older assistants: --url https://autopve.example.com/answer/<SERVE_TOKEN>
```

#### Running build-iso.sh without cloning the repo

> **Don't pipe scripts from the internet into a shell, this one included, until you've read them.**
> `curl … | bash` runs whatever the server sends at that moment, as you, with no chance to look
> first. A compromised account, a hijacked DNS name or a man-in-the-middle all turn that one-liner into
> someone else's code running on your jumpbox. Download it, read it, verify it, then run the file.

The way to do it:

```bash
# 1. Pin a commit you (or someone you trust) reviewed, not a branch that can change under you.
COMMIT=<full commit sha from github.com/00o-sh/cf-autopve/commits/main>
curl -fsSLo build-iso.sh "https://raw.githubusercontent.com/00o-sh/cf-autopve/$COMMIT/scripts/build-iso.sh"

# 2. Read it. All of it: it downloads an ISO, may start docker/podman, and writes under --out.
less build-iso.sh

# 3. Optionally record what you reviewed, and check it before later runs.
sha256sum build-iso.sh

# 4. Run the file you read.
bash build-iso.sh --url https://autopve.example.com
```

The file is self-contained, including the `--bootstrap-range` hook (`--print-bootstrap-hook` prints it),
so nothing else is fetched from this repo at run time.

If you pipe it anyway (`curl -fsSL …/scripts/build-iso.sh | bash -s -- --url …`), the script stops
before doing anything:

- It explains that the code is unreviewed and asks `Run this unreviewed code now? [y/N]` on the
  terminal.
- Only `y` or `yes` continues. Enter, `n` or anything else stops it, with nothing downloaded or
  written.
- With no terminal to ask on (CI, cron, `ssh host 'curl … | bash'`), it refuses outright. Download
  the file, review it and run that instead.
- The whole script is one function called on its last line, so a download cut off part-way runs
  nothing.

The prompt is a speed bump, not a security control: by the time it shows, the code that prints it is
already running. Reviewing the file is the control.

### Networks without DHCP

The installer has to be online before it can fetch an answer. In HTTP mode it
gets online only through DHCP; Proxmox offers no setting for a static address
at that point. `build-iso.sh` can add one:

```bash
scripts/build-iso.sh --url https://autopve.example.com \
  --bootstrap-range 10.0.0.240-10.0.0.249/24 --bootstrap-gateway 10.0.0.1 [--bootstrap-dns 10.0.0.1,1.1.1.1]
```

What happens at boot:

1. The installer tries DHCP as usual, for about 10 seconds. If DHCP answers, nothing else changes, so
   the same ISO works on DHCP networks too.
2. If nothing answers, a `dhclient` exit hook added by the build takes an address from the bootstrap
   range:
   - It starts at a slot derived from the NIC's MAC address, so several machines booting at once
     spread across the range.
   - It skips any address that answers ARP.
   - It keeps the address only if the gateway answers on that NIC. A NIC cabled to some other
     network is left alone.
3. The installer fetches its answer over HTTP as normal and installs.
4. The installed system gets the network from **that machine's answer**, not the bootstrap address.
   Give each machine:

   ```toml
   [network]
   source = "from-answer"
   cidr = "10.0.0.21/24"
   gateway = "10.0.0.1"
   dns = "10.0.0.1"
   filter.ID_NET_NAME_MAC = "*248a071e05bc"   # which NIC, on multi-NIC machines
   ```

   `source = "from-dhcp"` would make the installer write the bootstrap address as the machine's
   permanent configuration.

How it is added: Proxmox's tooling has no hook for this. The build appends a small archive to the
ISO's initrd. The archive holds the hook, its config, and a copy of the initrd's `/init` with one
added line that copies them into the installer's root before it starts. The kernel unpacks appended
archives after the original, so the stock initrd is otherwise untouched. The ISO is updated in place
the same way `prepare-iso` does it, keeping its boot records and volume UUID. If a future Proxmox ISO
changes that part of `/init`, the build stops with an error rather than producing a broken ISO.

`test/iso-bootstrap.sh <iso>` (root, network namespaces) runs the hook with that ISO's own
`dhclient-script`, `dhclient.conf` and busybox, on a fake LAN with no DHCP server.

### Post-installation webhook relay

Relays need a `SERVE_TOKEN`. A relay fires real automation, and `/hook` has no arm window or allowlist,
so without a token anyone who guessed a relay name could trigger it with a payload of their choosing,
signed with your HMAC secret. While no token is configured, every `/hook` call is refused with
`403 relays are disabled until a SERVE_TOKEN is configured`.

Create a relay, then set it in the answer's **Post Install** section. Set `auth-token` to the
`SERVE_TOKEN` (PVE 9.2+). The installer sends it as a top-level `token` field in the JSON body, so it
stays out of the URL:

```toml
[post-installation-webhook]
url = "https://autopve.example.com/hook/deploy"
auth-token = "<SERVE_TOKEN>"
```

The Worker removes that `token` field before relaying the payload, so your automation never sees the
serve token. A different `auth-token` value is taken to be the receiver's own and is passed through,
but it is never written to history. Older installers can put the token in the URL instead:
`/hook/deploy/<SERVE_TOKEN>`. The `Authorization` and `X-AutoPVE-Token` headers work here too.

When the installer finishes, it POSTs its system information here; the Worker records it and forwards it
to the relay target in the background, with a delivery log per relay. The body is forwarded verbatim
unless you give a template (below).

**Retries.** How retries run depends on whether a Queue is bound:

- **With `RELAY_QUEUE` (recommended).** `/hook` puts the delivery on a Cloudflare Queue before it
  replies `202`, so an accepted payload survives even if the target is down for minutes. Each attempt
  runs in its own invocation. A failure backs off 10 s, 20 s, 40 s and so on (up to 5 minutes) until
  the relay's retry count is used up. History shows `queued`, then `retrying` (with the next delay),
  then `relayed` or `error`. The relay is looked up again on each attempt, so disabling or fixing it
  affects deliveries already waiting. To enable it, run `npx wrangler queues create autopve-relay` and
  uncomment the `[[queues.*]]` blocks in `wrangler.toml`.
- **Without a queue.** Delivery runs inside the request's background window, which Workers cap at about
  30 seconds. An attempt only starts if it can finish in time (25 s budget). When the budget runs out,
  the delivery log says how many attempts ran and that it stopped, instead of the retries vanishing.
  Payloads too large for a queue message (over about 100 KB) also take this path.

**Body template.** A relay with a body template sends the rendered template instead of the installer's
body. `{{ path }}` placeholders are filled from `system_info` (the installer's payload), `relay` and
`now`; strings are JSON-escaped, so a JSON template stays valid JSON:

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

The target must be reachable from Cloudflare's network; a LAN address is rejected with an explanation.
Put a Cloudflare Tunnel in front of an internal runner if that is where the work happens.

### Install tracking

The **Installs** dashboard (sidebar) shows one row per machine and how far its latest install got:

| status | meaning |
| --- | --- |
| installing | an answer was served; waiting for the post-installation webhook |
| installed | the webhook reported back (shows the installed `fqdn`) |
| no report | served more than `INSTALL_TIMEOUT_MINUTES` (120) ago and nothing came back |
| refused | the installer asked and was turned away; the reason is shown |

The installer has no failure callback, so a failed install shows up as *no report*. To get the
*installed* step, point the answer's webhook at the Worker. With no relay to run, plain `/hook` just
records the result:

```toml
[post-installation-webhook]
url = "https://autopve.example.com/hook"
auth-token = "<SERVE_TOKEN>"
```

A relay URL (`/hook/<name>`) records it too, before relaying. Both need the `SERVE_TOKEN`.

Machines are identified by DMI system UUID, then serial, then lowest MAC, skipping firmware filler
like `To Be Filled By O.E.M.` or all-zero UUIDs, so the answer request and the webhook land on the same
row. Refusals only create a row when the request carried the serve token: anyone can POST a made-up
machine to `/answer`, and that must not fill the dashboard. The table keeps the `INSTALLS_LIMIT` (2000)
most recently heard machines. Tracking needs migration `0003`; without it installs still work.

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
| `ACCESS_TEAM_DOMAIN` | none | `https://<team>.cloudflareaccess.com`; required |
| `ACCESS_AUD` | none | Access application AUD tag; required |
| `ARM_DEFAULT_MINUTES` | `30` | default length of an arm window |
| `REQUIRE_HTTPS` | `true` | refuse to serve credentials over plain HTTP |
| `ALLOW_ALWAYS_SECRETS` | `false` | permit `serve_mode = "always"` on credential-bearing answers |
| `RATE_LIMIT_PER_MIN` | `30` | per-IP limit on `/answer`, `/hook`, `/files` |
| `FILE_MAX_BYTES` | `1000000` | largest file stored in D1 (D1's hard row limit is 2 MB) |
| `HISTORY_MAX_BYTES` | `131072` | cap on stored `system_info` per history row |
| `HISTORY_LIMIT` | `1000` | history rows retained |
| `ANSWER_VERSIONS_KEEP` | `50` | saved versions kept per answer (Versions tab) |
| `INSTALL_TIMEOUT_MINUTES` | `120` | after this long without a webhook, a served machine shows as *no report* |
| `INSTALLS_LIMIT` | `2000` | machines kept on the Installs dashboard |
| `ANSWER_FORMAT` | `auto` | `auto`: JSON when the installer prefers it, else TOML; `toml`: always TOML |
| `DEV_ALLOW_INSECURE_UI` | unset | local only; bypasses Access |
| `ANSWER_ENC_KEY` | secret | base64 32-byte AES-256-GCM key; required to store any credential |
| `SERVE_TOKEN` | secret | token the installer must present; optional for `/answer` and `/files`, required for `/hook` (relays are refused without it) |

## Endpoints

| route | auth | purpose |
|---|---|---|
| `GET /` | Access | configurator UI |
| `/api/*` | Access | configurator API |
| `POST /answer[/<token>]` | guards | installer fetches its answer file (TOML, or JSON when preferred) |
| `POST /hook/<relay>[/<token>]` | `SERVE_TOKEN` (required: body `token`, header, or path) | post-installation webhook → relay |
| `POST /hook` | `SERVE_TOKEN` (required: body `token` or header) | post-installation webhook → Installs dashboard only |
| `GET /files/<name>[?t=<token>]` | guards | first-boot scripts and downloads |
| `GET /healthz` | none | liveness |

## Layout

```
src/
  index.ts     router; the three public endpoints
  api.ts       Access-gated JSON API for the UI
  access.ts    Cloudflare Access JWT verification (JWKS, iss/aud/exp)
  answers.ts   storage, inheritance, filter matching, masking
  match.ts     field paths and globs over the installer's system information
  fleet.ts     machine tables and {{ placeholder }} rendering
  guards.ts    serve decisions: mode, arm window, CIDR, token, HTTPS; atomic serve claim
  crypto.ts    AES-256-GCM envelope encryption, HMAC, token compare
  relay.ts     outbound webhook relay, templating, delivery log
  toml.ts      answer.toml writer + value coercion
  versions.ts  answer version history: snapshots, diff text, restore
  tomlimport.ts  answer.toml reader for import and the raw editor (snake_case migration, comments)
  schema.ts    the Proxmox key catalogue (ported from settings.py)
  files.ts     D1/R2 file hosting + credential scanning
  db.ts        history, audit, rate limiting, sysinfo key learning
  installs.ts  install tracking per machine (Installs dashboard)
public/        the configurator (no build step, no external assets, strict CSP)
migrations/    D1 schema
test/          logic.test.js (functions) and worker.test.js (the bundled Worker in workerd, real D1)
```

## Credits

Original project by [natankeddem](https://github.com/natankeddem/autopve) and
[00o-sh](https://github.com/00o-sh/autopve). This is an independent port; bugs here are this port's.
