"use strict";
/* autopve configurator — vanilla JS, no external dependencies (strict CSP). */

const MASK = "__autopve_secret_set__";
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) node.append(kid);
  return node;
};

const S = {
  boot: null, answers: [], answer: null, relays: [], relay: null, files: [],
  sysinfoKeys: [], tab: "global", dirty: false, history: [], live: false, timer: null,
};

/* ----------------------------- transport ----------------------------- */

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body instanceof Uint8Array
      ? { "X-File-Type": opts.contentType || "application/octet-stream" }
      : opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body instanceof Uint8Array ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = "ok", ms = 6000) {
  const node = el("div", { class: `toast ${kind}`, text: message });
  $("#toasts").append(node);
  setTimeout(() => node.remove(), ms);
}

function ask(title, text, value = "", okLabel = "OK") {
  return new Promise((resolve) => {
    const dlg = $("#prompt-dialog");
    $("#prompt-title").textContent = title;
    $("#prompt-text").textContent = text || "";
    $("#prompt-ok").textContent = okLabel;
    const input = $("#prompt-input");
    input.value = value;
    dlg.returnValue = "";
    const done = () => {
      dlg.removeEventListener("close", done);
      resolve(dlg.returnValue === "ok" ? input.value.trim() : null);
    };
    dlg.addEventListener("close", done);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

/* ------------------------------ bootstrap ---------------------------- */

async function boot() {
  try {
    S.boot = await api("/bootstrap");
  } catch (err) {
    document.body.innerHTML = "";
    document.body.append(el("div", { class: "banner bad", text: "Could not load the configurator: " + err.message }));
    return;
  }
  S.answers = S.boot.answers;
  S.relays = S.boot.relays;
  S.files = S.boot.files;
  $("#identity").textContent = S.boot.identity.email + (S.boot.identity.dev ? " (dev mode)" : "");
  renderBanners();
  renderSidebar();
  wireGlobalButtons();
  api("/sysinfo-keys").then((d) => { S.sysinfoKeys = d.keys || []; }).catch(() => {});
}

function renderBanners() {
  const box = $("#banners");
  box.innerHTML = "";
  const c = S.boot.config;
  if (!c.access_enforced) {
    box.append(el("div", { class: "banner bad", text:
      "Cloudflare Access is NOT being enforced (DEV_ALLOW_INSECURE_UI=true). Anyone who can reach this URL can edit and reveal answers. Never run a deployment like this." }));
  }
  if (!c.encryption_configured) {
    box.append(el("div", { class: "banner warn", text:
      "ANSWER_ENC_KEY is not set. Credential fields cannot be saved at all until it is — run: openssl rand -base64 32 | wrangler secret put ANSWER_ENC_KEY" }));
  }
  if (!c.serve_token_configured) {
    box.append(el("div", { class: "banner info", text:
      "No SERVE_TOKEN is set, so /answer is reachable by anyone who knows the hostname. Answers holding credentials still require arming, but a token narrows the exposure further." }));
  }
}

/* ------------------------------- sidebar ----------------------------- */

function answerDot(a) {
  if (a.has_secrets && !a.armed) return "secret";
  return a.armed ? "armed" : "off";
}

function renderSidebar() {
  const list = $("#answer-list");
  list.innerHTML = "";
  for (const a of S.answers) {
    list.append(el("li", {
      class: S.answer && S.answer.name === a.name ? "active" : "",
      onclick: () => openAnswer(a.name),
      title: a.has_secrets ? "holds credentials: " + a.secret_keys.join(", ") : "",
    }, [
      el("span", { text: a.name }),
      el("span", { class: "dot " + answerDot(a) }),
    ]));
  }
  const rlist = $("#relay-list");
  rlist.innerHTML = "";
  for (const r of S.relays) {
    rlist.append(el("li", {
      class: S.relay && S.relay.name === r.name ? "active" : "",
      onclick: () => openRelay(r.name),
    }, [el("span", { text: r.name }), el("span", { class: "dot " + (r.enabled ? "armed" : "off") })]));
  }
  const flist = $("#file-list");
  flist.innerHTML = "";
  for (const f of S.files) {
    flist.append(el("li", { onclick: () => openFiles(), text: f.name }));
  }
  if (S.files.length) flist.append(el("li", { class: "muted", text: "manage files…", onclick: () => openFiles() }));
}

function showPane(id) {
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.id !== id;
}

/* ------------------------------- answers ----------------------------- */

async function openAnswer(name) {
  if (S.dirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/answers/" + encodeURIComponent(name));
  S.answer = data.answer;
  S.relay = null;
  S.dirty = false;
  S.tab = S.tab === "history" || S.tab === "preview" || S.tab === "serving" || S.tab === "filters" ? S.tab : "global";
  if (S.answer.name === "Default" && S.tab === "filters") S.tab = "global";
  renderSidebar();
  renderAnswer();
  showPane("answer-pane");
}

function markDirty() {
  S.dirty = true;
  $("#answer-save").textContent = "Save •";
}

function renderAnswer() {
  const a = S.answer;
  $("#answer-title").textContent = a.name;
  const state = $("#answer-state");
  if (a.serve_mode === "off") { state.className = "pill off"; state.textContent = "not served"; }
  else if (a.armed) {
    state.className = "pill armed";
    state.textContent = a.serve_mode === "always" ? "serving (always)"
      : "armed until " + new Date(a.armed_until).toLocaleTimeString() + (a.serves_remaining !== null ? ` · ${a.serves_remaining} left` : "");
  } else { state.className = "pill secret"; state.textContent = "disarmed"; }
  $("#answer-save").textContent = S.dirty ? "Save •" : "Save";

  const tabs = $("#answer-tabs");
  tabs.innerHTML = "";
  const defs = S.boot.schema.sections.map((s) => [s.id, s.label]);
  if (a.name !== "Default") defs.push(["filters", "Filters"]);
  defs.push(["serving", "Serving & risk"], ["preview", "answer.toml"], ["history", "History"]);
  for (const [id, label] of defs) {
    tabs.append(el("button", {
      class: S.tab === id ? "active" : "",
      text: label + (id === "serving" && a.has_secrets ? " ⚠" : ""),
      onclick: () => { S.tab = id; renderAnswer(); },
    }));
  }
  const body = $("#answer-body");
  body.innerHTML = "";
  const section = S.boot.schema.sections.find((s) => s.id === S.tab);
  if (section) body.append(renderSection(section));
  else if (S.tab === "filters") body.append(renderFilters());
  else if (S.tab === "serving") body.append(renderServing());
  else if (S.tab === "preview") body.append(renderPreview());
  else if (S.tab === "history") body.append(renderHistory());
}

function sectionTable(id) {
  if (!S.answer.doc[id]) S.answer.doc[id] = {};
  return S.answer.doc[id];
}

function renderSection(section) {
  const table = sectionTable(section.id);
  const wrap = el("div");
  const catalogue = Object.entries(section.keys);

  const listId = "keys-" + section.id.replace(/\W/g, "-");
  const datalist = el("datalist", { id: listId });
  for (const [k] of catalogue) datalist.append(el("option", { value: k }));

  const input = el("input", {
    list: listId,
    placeholder: section.freeform ? "MAC address, e.g. aa:bb:cc:dd:ee:ff" : "pick a key, or type a new one",
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } },
    oninput: () => { hint.textContent = section.keys[input.value]?.description || ""; },
  });
  const hint = el("div", { class: "muted", style: "font-size:12px;margin-top:4px" });
  const add = () => {
    const key = input.value.trim();
    if (!key) return;
    if (key in table) { toast(`${key} is already set.`, "warn"); return; }
    if (section.id === "disk-setup") {
      const keys = Object.keys(table);
      if (key.startsWith("filter") && keys.includes("disk-list")) return toast("Cannot add a filter while disk-list is used.", "bad");
      if (key === "disk-list" && keys.some((k) => k.startsWith("filter"))) return toast("Cannot add disk-list while a filter is used.", "bad");
    }
    table[key] = section.keys[key]?.options?.[0] ?? "";
    input.value = ""; hint.textContent = "";
    markDirty(); renderAnswer();
  };

  wrap.append(el("div", { class: "card" }, [
    el("h3", { text: section.label + "  " }),
    section.help ? el("p", { class: "muted", text: section.help, style: "margin-top:0" }) : null,
    el("div", { class: "adder" }, [el("div", {}, [input, datalist, hint]), el("button", { text: "Add key", onclick: add })]),
  ]));

  const rows = el("div", { class: "card" });
  const entries = Object.entries(table);
  if (!entries.length) rows.append(el("p", { class: "muted", text: "Nothing set in this section." }));
  for (const [key, value] of entries) {
    const def = section.keys[key] || {};
    const isSecret = !!def.secret || /(^|[-_.])(password|passwd|secret|token|api[-_]?key|private[-_]?key)([-_.]|$)/i.test(key);
    const stored = value === MASK;
    const err = el("div", { class: "fielderr" });
    const showProblem = (v) => {
      const problem = checkField(section.id, key, v);
      err.textContent = problem ? `${key} ${problem}` : "";
      vwrap.classList.toggle("invalid", !!problem);
    };

    let vwrap;
    if (def.options && def.type !== "bool" && !isSecret) {
      vwrap = el("div", { class: "vwrap" }, [
        combo(def, String(value), (picked) => { table[key] = picked; markDirty(); showProblem(picked); }),
      ]);
    } else {
      const control = el("input", {
        value: stored ? "" : Array.isArray(value) ? "[" + value.join(", ") + "]" : String(value),
        placeholder: stored ? "stored, encrypted — type to replace" : def.options ? def.options[0] : def.format ? formatHint(def.format) : "",
        type: isSecret && !stored ? "password" : "text",
        list: def.options ? listId + "-" + key.replace(/\W/g, "-") : false,
        oninput: (e) => { table[key] = e.target.value; markDirty(); showProblem(e.target.value); },
      });
      let optionList = null;
      if (def.options) {
        optionList = el("datalist", { id: listId + "-" + key.replace(/\W/g, "-") });
        for (const o of def.options) optionList.append(el("option", { value: o }));
      }
      vwrap = el("div", { class: "vwrap" }, [control, optionList]);
      if (isSecret) {
        vwrap.append(el("button", {
          text: "👁", title: "show/hide while typing",
          onclick: () => { control.type = control.type === "password" ? "text" : "password"; },
        }));
      }
    }
    if (!stored) showProblem(value);

    const helpText = def.description ? el("div", { class: "helptext", text: def.description, hidden: true }) : null;
    const helpBtn = def.description ? el("button", {
      class: "help", type: "button", text: "?", title: "What is this?", "aria-expanded": "false",
      onclick: () => {
        helpText.hidden = !helpText.hidden;
        helpBtn.setAttribute("aria-expanded", String(!helpText.hidden));
        helpBtn.classList.toggle("open", !helpText.hidden);
      },
    }) : null;

    rows.append(el("div", { class: "keyrow" }, [
      el("div", { class: "kname" }, [
        el("span", { text: key }),
        helpBtn,
        isSecret ? el("span", { class: "tag", text: "secret" }) : null,
      ]),
      el("div", { class: "vcol" }, [vwrap, err, helpText]),
      el("button", { text: "−", title: "remove", onclick: () => { delete table[key]; markDirty(); renderAnswer(); } }),
    ]));
  }
  wrap.append(rows);
  return wrap;
}

/* ----------------------------- validation ---------------------------- */

const formatRegex = {};
function formatHint(format) { return S.boot.schema.formats?.[format]?.hint || ""; }

/**
 * Mirrors checkValue() in src/validate.ts so problems show while typing; the
 * server re-checks on save and is the authority. Regexes come from the server.
 */
function checkField(sectionId, key, value) {
  const def = S.boot.schema.sections.find((s) => s.id === sectionId)?.keys[key];
  if (!def || def.type === "list" || value === MASK || value === "" || value == null) return null;
  const text = String(value).trim();
  if (def.type === "bool") return /^(true|false|yes|no|1|0)$/i.test(text) ? null : "must be true or false";
  if (def.type === "int") { const n = Number(text); return text !== "" && Number.isFinite(n) && n >= 0 ? null : "must be a non-negative number"; }
  if (def.options && !def.options.includes(text)) {
    return def.options.length > 12 ? "is not a recognised value" : "must be one of " + def.options.join(", ");
  }
  if (def.format) {
    const f = S.boot.schema.formats?.[def.format];
    if (f) {
      formatRegex[def.format] ??= new RegExp(f.pattern);
      if (!formatRegex[def.format].test(text)) return "must be " + f.hint;
    }
  }
  return null;
}

/** Every problem in the open answer, as "section.key …" strings. */
function answerProblems() {
  const out = [];
  for (const section of S.boot.schema.sections) {
    for (const [key, value] of Object.entries(S.answer.doc[section.id] || {})) {
      const p = checkField(section.id, key, value);
      if (p) out.push(`${section.label}: ${key} ${p}`);
    }
  }
  return out;
}

/* ------------------------------ combobox ----------------------------- */

let tzOffsets = null;
function optionLabel(def, option) {
  if (def.labels?.[option]) return def.labels[option];
  if (def.options.includes("Europe/Vienna")) {
    if (!tzOffsets) {
      tzOffsets = {};
      const now = new Date();
      for (const tz of def.options) {
        try {
          const part = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" })
            .formatToParts(now).find((p) => p.type === "timeZoneName");
          tzOffsets[tz] = part ? part.value.replace("GMT", "UTC").replace(/^UTC$/, "UTC±0") : "";
        } catch { tzOffsets[tz] = ""; }
      }
    }
    return tzOffsets[option] || "";
  }
  return "";
}

/** A dropdown with a search box over def.options; calls onPick(value). */
function combo(def, current, onPick) {
  let value = current;
  const btnValue = el("span", { class: "combo-value" });
  const btnLabel = el("span", { class: "opt-label" });
  const button = el("button", { type: "button", class: "combo-btn", "aria-haspopup": "listbox" }, [
    el("span", { class: "combo-main" }, [btnValue, btnLabel]), el("span", { class: "combo-caret", text: "▾" }),
  ]);
  const search = el("input", { type: "search", placeholder: "Search…", autocomplete: "off", spellcheck: "false" });
  const list = el("ul", { class: "combo-list", role: "listbox" });
  const pop = el("div", { class: "combo-pop", hidden: true }, [search, list]);
  const root = el("div", { class: "combo" }, [button, pop]);
  let shown = [];
  let active = 0;

  const paintButton = () => {
    btnValue.textContent = value || "choose…";
    btnLabel.textContent = value ? optionLabel(def, value) : "";
  };
  const paintList = () => {
    const q = search.value.trim().toLowerCase();
    shown = def.options.filter((o) => !q || o.toLowerCase().includes(q) || optionLabel(def, o).toLowerCase().includes(q));
    active = Math.max(0, Math.min(active, shown.length - 1));
    list.innerHTML = "";
    if (!shown.length) list.append(el("li", { class: "empty", text: "No matches" }));
    shown.forEach((o, i) => {
      list.append(el("li", {
        role: "option", class: (i === active ? "active " : "") + (o === value ? "sel" : ""),
        onmousedown: (e) => { e.preventDefault(); pick(o); },
        onmousemove: () => { if (active !== i) { active = i; mark(); } },
      }, [el("span", { text: o }), el("span", { class: "opt-label", text: optionLabel(def, o) })]));
    });
  };
  const mark = () => {
    [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  const close = () => { pop.hidden = true; document.removeEventListener("mousedown", outside); };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  const open = () => {
    search.value = "";
    active = Math.max(0, def.options.indexOf(value));
    paintList();
    pop.hidden = false;
    search.focus();
    mark();
    document.addEventListener("mousedown", outside);
  };
  const pick = (o) => { value = o; paintButton(); close(); button.focus(); onPick(o); };

  button.addEventListener("click", () => (pop.hidden ? open() : close()));
  search.addEventListener("input", () => { active = 0; paintList(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) pick(shown[active]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); button.focus(); }
  });
  paintButton();
  return root;
}

/* ------------------------------- filters ----------------------------- */

function renderFilters() {
  const wrap = el("div", { class: "split" });
  const mk = (field, title, note) => {
    const values = (S.answer.doc[field] = S.answer.doc[field] || []);
    const card = el("div", { class: "card" }, [el("h3", { text: title }), el("p", { class: "muted", text: note })]);
    const dl = el("datalist", { id: "sysinfo-" + field });
    for (const k of S.sysinfoKeys) dl.append(el("option", { value: k }));
    const input = el("input", { list: "sysinfo-" + field, placeholder: '"name":"PowerEdge R620"' });
    const add = () => {
      const v = input.value.trim();
      if (!v || values.includes(v)) return;
      values.push(v); input.value = ""; markDirty(); renderAnswer();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    card.append(el("div", { class: "adder" }, [el("div", {}, [input, dl]), el("button", { text: "Add", onclick: add })]));
    for (const [i, v] of values.entries()) {
      card.append(el("div", { class: "keyrow" }, [
        el("div", { class: "mono", style: "grid-column: span 2; word-break: break-all", text: v }),
        el("button", { text: "−", onclick: () => { values.splice(i, 1); markDirty(); renderAnswer(); } }),
      ]));
    }
    return card;
  };
  wrap.append(mk("must_contain", "Must contain", "The system information must contain at least one of these strings for this answer to be used."));
  wrap.append(mk("must_not_contain", "Must not contain", "If any of these strings is present, this answer is skipped."));
  const tester = el("div", { class: "card" }, [
    el("h3", { text: "Dry run" }),
    el("p", { class: "muted", text: "Paste a system_info payload (copy one from History) to see which answer would win." }),
  ]);
  const ta = el("textarea", { placeholder: '{"dmi": {"system": {"name": "PowerEdge R620"}}}' });
  const out = el("pre", { class: "toml", style: "margin-top:10px" });
  tester.append(ta, el("div", { style: "margin-top:8px" }, [el("button", {
    text: "Test match",
    onclick: async () => {
      let parsed;
      try { parsed = JSON.parse(ta.value || "{}"); } catch { return toast("That is not valid JSON.", "bad"); }
      const r = await api("/match", { method: "POST", body: { system_info: parsed } });
      out.textContent = `matched: ${r.matched}\nwould serve: ${r.would_serve}${r.reason ? " — " + r.reason : ""}\n\n${r.toml || ""}`;
    },
  })]), out);
  const col = el("div", { style: "grid-column: 1 / -1" }, [tester]);
  wrap.append(col);
  return wrap;
}

/* ------------------------------- serving ----------------------------- */

function renderServing() {
  const a = S.answer;
  const c = S.boot.config;
  const wrap = el("div");

  if (a.has_secrets) {
    wrap.append(el("div", { class: "card", style: "border-color: var(--warn)" }, [
      el("h3", {}, [el("span", { text: "This answer hosts credentials" }), el("span", { class: "tag", text: "risk" })]),
      el("p", { text: "These fields are stored encrypted, but the installer has no way to authenticate: while this answer is being served, anything that can reach the answer endpoint can read them in plaintext." }),
      el("ul", { html: a.secret_keys.map((k) => `<li><code>${k}</code></li>`).join("") }),
      el("p", { class: "muted", text: "Safer patterns: use root-password-hashed instead of root-password; keep the answer disarmed except during an install; restrict by source IP; or skip hosting entirely and bake the downloaded answer.toml into the ISO with proxmox-auto-install-assistant." }),
    ]));
  }

  const ack = el("input", { type: "checkbox", ...(a.secrets_ack ? { checked: true } : {}) });
  ack.addEventListener("change", async () => {
    if (ack.checked) {
      const typed = await ask("Acknowledge credential hosting",
        'Type HOST SECRETS to confirm that this deployment may serve the credentials in this answer over the network.', "", "Acknowledge");
      if (typed !== "HOST SECRETS") { ack.checked = false; toast("Not acknowledged.", "warn"); return; }
    }
    a.secrets_ack = ack.checked;
    markDirty();
  });

  const modeSel = el("select", {}, ["off", "armed", "always"].map((m) =>
    el("option", { value: m, ...(a.serve_mode === m ? { selected: true } : {}), text:
      m === "off" ? "off — never serve this answer"
      : m === "armed" ? "armed — serve only during an explicit window (recommended)"
      : "always — serve to any request that matches" })));
  modeSel.addEventListener("change", () => {
    if (modeSel.value === "always" && a.has_secrets && !c.allow_always_secrets) {
      toast('This deployment refuses "always" for answers holding credentials.', "bad");
      modeSel.value = a.serve_mode;
      return;
    }
    a.serve_mode = modeSel.value; markDirty();
  });

  const minutes = el("input", { type: "number", value: c.arm_default_minutes, min: "1", max: "1440", style: "width:90px" });
  const serves = el("input", { type: "number", value: "1", min: "1", max: "100", style: "width:90px" });

  wrap.append(el("div", { class: "card" }, [
    el("h3", { text: "Serving" }),
    el("label", { class: "field" }, [el("span", { text: "Mode" }), modeSel]),
    el("div", { class: "checkline" }, [ack, el("label", { text: "I accept that serving this answer exposes any credential it contains to whoever can reach the endpoint." })]),
    el("div", { class: "inline", style: "margin-top:10px" }, [
      el("span", { class: "muted", text: "Arm for" }), minutes, el("span", { class: "muted", text: "minutes, max" }), serves, el("span", { class: "muted", text: "serves" }),
      el("button", { class: "primary", text: "Arm now", onclick: async () => {
        const r = await api(`/answers/${encodeURIComponent(a.name)}/arm`, { method: "POST", body: { minutes: Number(minutes.value), serves: Number(serves.value) } });
        S.answer = r.answer; refreshAnswerList(); renderAnswer(); toast(`Armed until ${new Date(r.answer.armed_until).toLocaleTimeString()}.`);
      } }),
      el("button", { text: "Disarm", onclick: async () => {
        const r = await api(`/answers/${encodeURIComponent(a.name)}/disarm`, { method: "POST", body: {} });
        S.answer = r.answer; refreshAnswerList(); renderAnswer(); toast("Disarmed.");
      } }),
    ]),
    el("p", { class: "muted", style: "margin-bottom:0", text: a.armed_until && a.armed_until > Date.now()
      ? `Currently armed until ${new Date(a.armed_until).toLocaleString()}${a.serves_remaining !== null ? `, ${a.serves_remaining} serve(s) left` : ""}.`
      : "Currently disarmed." }),
  ]));

  const cidrs = el("textarea", { value: (a.allow_cidrs || []).join("\n"), placeholder: "203.0.113.0/24\n2001:db8::/32" });
  cidrs.addEventListener("input", () => { a.allow_cidrs = cidrs.value.split("\n").map((s) => s.trim()).filter(Boolean); markDirty(); });
  const notes = el("textarea", { value: a.notes || "", placeholder: "Why this answer exists, which hosts it targets…" });
  notes.addEventListener("input", () => { a.notes = notes.value; markDirty(); });
  const priority = el("input", { type: "number", value: a.priority, min: "1", max: "9999" });
  priority.addEventListener("input", () => { a.priority = Number(priority.value); markDirty(); });

  wrap.append(el("div", { class: "card" }, [
    el("h3", { text: "Restrictions" }),
    el("label", { class: "field" }, [el("span", { text: "Allowed source IPs / CIDRs (one per line; empty means anywhere)" }), cidrs]),
    el("label", { class: "field" }, [el("span", { text: "Match priority (lower wins when several answers match)" }), priority]),
    el("label", { class: "field" }, [el("span", { text: "Notes" }), notes]),
  ]));

  const base = c.origin;
  wrap.append(el("div", { class: "card" }, [
    el("h3", { text: "Installer endpoints" }),
    el("p", { class: "muted", text: "Point the installer's answer fetch at this URL" + (c.serve_token_configured ? ", appending your SERVE_TOKEN as the last path segment." : ".") }),
    el("div", { class: "url", text: `${base}/answer` + (c.serve_token_configured ? "/<SERVE_TOKEN>" : "") }),
    el("p", { class: "muted", style: "margin-bottom:4px", text: "Build a matching ISO with:" }),
    el("div", { class: "url", text: `proxmox-auto-install-assistant prepare-iso pve.iso --fetch-from http --url ${base}/answer` }),
  ]));
  return wrap;
}

/* ------------------------------- preview ----------------------------- */

function renderPreview() {
  const a = S.answer;
  const pre = el("pre", { class: "toml", text: "loading…" });
  const load = async (reveal) => {
    const r = await api(`/answers/${encodeURIComponent(a.name)}/preview` + (reveal ? "?reveal=1" : ""));
    pre.textContent = r.toml;
    if (reveal) toast("Credentials revealed — this is recorded in the audit log.", "warn");
  };
  load(false);
  const wrap = el("div", { class: "card" }, [
    el("h3", { text: "answer.toml" }),
    el("p", { class: "muted", text: a.name === "Default" ? "This is the base every other answer inherits from." : "Default merged with this answer, exactly as the installer would receive it." }),
    el("div", { class: "inline", style: "margin-bottom:10px" }, [
      el("button", { text: "Refresh", onclick: () => load(false) }),
      a.has_secrets ? el("button", { text: "Reveal credentials", onclick: () => load(true) }) : null,
      el("button", { text: "Copy", onclick: async () => { await navigator.clipboard.writeText(pre.textContent); toast("Copied."); } }),
      el("a", { class: "btn", href: `/api/answers/${encodeURIComponent(a.name)}/download?reveal=1`, download: "", text: "Download answer.toml" }),
    ]),
    pre,
    el("p", { class: "muted", style: "margin-bottom:0", text: "Downloading includes real credentials so the file works offline. Treat it like a secret; the download is recorded in the audit log." }),
  ]);
  return wrap;
}

/* ------------------------------- history ----------------------------- */

function renderHistory() {
  const wrap = el("div");
  const detail = el("div", { class: "card", hidden: true });
  const table = el("table");
  const tbody = el("tbody");
  table.append(el("thead", {}, [el("tr", {}, [
    el("th", { text: "When" }), el("th", { text: "System" }), el("th", { text: "Answer" }),
    el("th", { text: "Outcome" }), el("th", { text: "Client" }),
  ])]), tbody);

  const draw = (rows) => {
    tbody.innerHTML = "";
    if (!rows.length) tbody.append(el("tr", {}, [el("td", { colspan: "5", class: "muted", text: "No requests yet." })]));
    for (const row of rows) {
      tbody.append(el("tr", { onclick: () => {
        detail.hidden = false;
        detail.innerHTML = "";
        detail.append(
          el("h3", { text: `${new Date(row.ts).toLocaleString()} — ${row.outcome}${row.detail ? " (" + row.detail + ")" : ""}` }),
          el("div", { class: "split" }, [
            el("div", {}, [el("h3", { text: "system_info" }), el("pre", { class: "toml", text: pretty(row.system_info) })]),
            el("div", {}, [el("h3", { text: "response (credentials redacted)" }), el("pre", { class: "toml", text: row.response || "—" })]),
          ]),
        );
      } }, [
        el("td", { text: new Date(row.ts).toLocaleString() }),
        el("td", { text: row.system_name || "—" }),
        el("td", { text: row.answer || row.detail || "—" }),
        el("td", { class: row.outcome === "served" || row.outcome === "relayed" ? "ok" : "deny", text: row.outcome }),
        el("td", { class: "mono", text: row.ip || "—" }),
      ]));
    }
  };

  const refresh = async () => {
    const r = await api("/history?limit=200" + (S.answer ? "&answer=" + encodeURIComponent(S.answer.name) : ""));
    S.history = r.history;
    draw(S.history);
  };
  const liveBtn = el("button", { text: S.live ? "Live ●" : "Live ○", onclick: () => {
    S.live = !S.live;
    liveBtn.textContent = S.live ? "Live ●" : "Live ○";
    if (S.live) startPolling(); else stopPolling();
  } });

  wrap.append(el("div", { class: "card" }, [
    el("h3", { text: "Requests" }),
    el("div", { class: "inline", style: "margin-bottom:10px" }, [
      el("button", { text: "Refresh", onclick: refresh }), liveBtn,
      el("button", { class: "danger", text: "Clear all history", onclick: async () => {
        if (!confirm("Delete all history rows?")) return;
        await api("/history", { method: "DELETE", body: { all: true } });
        refresh();
      } }),
    ]),
    table,
  ]), detail);
  refresh();
  return wrap;
}

function pretty(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw || "—"; }
}

function startPolling() {
  stopPolling();
  let since = S.history.length ? S.history[0].ts : Date.now();
  S.timer = setInterval(async () => {
    try {
      const r = await api("/history?limit=20&since=" + since);
      for (const row of (r.history || []).slice().reverse()) {
        since = Math.max(since, row.ts);
        toast(`${row.outcome === "served" ? "Answer served" : row.outcome === "relayed" ? "Webhook relayed" : "Request " + row.outcome}: ${row.system_name || row.ip || "unknown"} → ${row.answer || row.detail}`,
          row.outcome === "denied" || row.outcome === "error" ? "bad" : "ok");
      }
      if (r.history && r.history.length && S.tab === "history") renderAnswer();
    } catch { /* keep polling */ }
  }, 5000);
}
function stopPolling() { if (S.timer) clearInterval(S.timer); S.timer = null; }

/* -------------------------------- relays ----------------------------- */

async function openRelay(name) {
  const r = S.relays.find((x) => x.name === name);
  if (!r) return;
  S.relay = JSON.parse(JSON.stringify(r));
  S.answer = null;
  renderSidebar();
  renderRelay();
  showPane("relay-pane");
}

function renderRelay() {
  const r = S.relay;
  $("#relay-title").textContent = r.name;
  const body = $("#relay-body");
  body.innerHTML = "";

  const field = (label, node) => el("label", { class: "field" }, [el("span", { text: label }), node]);
  const url = el("input", { value: r.url, placeholder: "https://automation.example.com/hooks/proxmox" });
  url.addEventListener("input", () => { r.url = url.value; });
  const method = el("select", {}, ["POST", "PUT", "PATCH"].map((m) => el("option", { value: m, ...(r.method === m ? { selected: true } : {}), text: m })));
  method.addEventListener("change", () => { r.method = method.value; });
  const enabled = el("input", { type: "checkbox", ...(r.enabled ? { checked: true } : {}) });
  enabled.addEventListener("change", () => { r.enabled = enabled.checked; });
  const hmac = el("input", { type: "password", value: r.hmac_secret === MASK ? "" : r.hmac_secret || "",
    placeholder: r.has_hmac ? "stored, encrypted — type to replace" : "optional shared secret for X-AutoPVE-Signature" });
  hmac.addEventListener("input", () => { r.hmac_secret = hmac.value; });
  const tmpl = el("textarea", { value: r.body_template || "", placeholder:
    'Leave empty to forward the installer payload verbatim, or build your own JSON, e.g.\n{"ref":"main","inputs":{"host":"{{ system_info.dmi.system.name }}","version":"{{ system_info.product.version }}"}}' });
  tmpl.addEventListener("input", () => { r.body_template = tmpl.value; });

  const headerBox = el("div");
  const drawHeaders = () => {
    headerBox.innerHTML = "";
    for (const [k, v] of Object.entries(r.headers || {})) {
      const value = el("input", { type: "password", value: v === MASK ? "" : v, placeholder: v === MASK ? "stored, encrypted" : "value" });
      value.addEventListener("input", () => { r.headers[k] = value.value; });
      headerBox.append(el("div", { class: "keyrow" }, [
        el("div", { class: "kname", text: k }), value,
        el("button", { text: "−", onclick: () => { delete r.headers[k]; drawHeaders(); } }),
      ]));
    }
    const nk = el("input", { placeholder: "Authorization" });
    const nv = el("input", { placeholder: "Bearer …", type: "password" });
    headerBox.append(el("div", { class: "keyrow" }, [nk, nv, el("button", { text: "+", onclick: () => {
      if (!nk.value.trim()) return;
      r.headers = r.headers || {};
      r.headers[nk.value.trim()] = nv.value;
      drawHeaders();
    } })]));
  };
  drawHeaders();

  body.append(
    el("div", { class: "card" }, [
      el("h3", { text: "Target" }),
      el("p", { class: "muted", text: "A Worker has no shell, so instead of running ansible-playbook this forwards the installer's post-installation payload to something that can. The target must be reachable from Cloudflare's network — public, or behind a Cloudflare Tunnel." }),
      field("URL", url), field("Method", method),
      el("div", { class: "checkline" }, [enabled, el("label", { text: "Enabled" })]),
    ]),
    el("div", { class: "card" }, [
      el("h3", {}, [el("span", { text: "Credentials" }), el("span", { class: "tag", text: "encrypted at rest" })]),
      el("h3", { text: "Headers", style: "font-size:13px;margin-top:6px" }), headerBox,
      field("HMAC signing secret", hmac),
      el("p", { class: "muted", text: "When set, deliveries carry X-AutoPVE-Timestamp and X-AutoPVE-Signature: sha256=HMAC(secret, timestamp + \".\" + body), so the receiver can verify the payload really came from here." }),
    ]),
    el("div", { class: "card" }, [el("h3", { text: "Body template" }), tmpl]),
    el("div", { class: "card" }, [
      el("h3", { text: "Installer configuration" }),
      el("p", { class: "muted", text: "Set this as the post-installation-webhook URL in your answer:" }),
      el("div", { class: "url", text: `${S.boot.config.origin}/hook/${r.name}` + (S.boot.config.serve_token_configured ? "/<SERVE_TOKEN>" : "") }),
    ]),
    el("div", { class: "card", id: "relay-log" }, [el("h3", { text: "Delivery log" }), el("button", { text: "Refresh", onclick: loadRelayLog })]),
  );
  loadRelayLog();
}

async function loadRelayLog() {
  const box = $("#relay-log");
  if (!box || !S.relay) return;
  const r = await api("/relay-log?relay=" + encodeURIComponent(S.relay.name));
  for (const old of box.querySelectorAll("table")) old.remove();
  const tbody = el("tbody");
  for (const row of r.log || []) {
    tbody.append(el("tr", {}, [
      el("td", { text: new Date(row.ts).toLocaleString() }),
      el("td", { text: "#" + row.attempt }),
      el("td", { class: row.ok ? "ok" : "deny", text: row.ok ? "HTTP " + row.status : row.error || "failed" }),
      el("td", { class: "mono", text: (row.response || "").slice(0, 120) }),
    ]));
  }
  if (!(r.log || []).length) tbody.append(el("tr", {}, [el("td", { colspan: "4", class: "muted", text: "No deliveries yet." })]));
  box.append(el("table", {}, [el("thead", {}, [el("tr", {}, [
    el("th", { text: "When" }), el("th", { text: "Attempt" }), el("th", { text: "Result" }), el("th", { text: "Response" }),
  ])]), tbody]));
}

/* -------------------------------- files ------------------------------ */

function openFiles() {
  S.answer = null; S.relay = null;
  renderSidebar();
  const body = $("#files-body");
  body.innerHTML = "";
  const tbody = el("tbody");
  for (const f of S.files) {
    const url = `${S.boot.config.origin}/files/${encodeURIComponent(f.name)}` + (S.boot.config.serve_token_configured ? "?t=<SERVE_TOKEN>" : "");
    tbody.append(el("tr", {}, [
      el("td", { text: f.name }),
      el("td", { text: (f.size / 1024).toFixed(1) + " KiB" }),
      el("td", { text: f.storage.toUpperCase() }),
      el("td", { class: "mono", style: "word-break:break-all", text: url }),
      el("td", {}, [el("button", { class: "danger", text: "delete", onclick: async () => {
        if (!confirm(`Delete ${f.name}?`)) return;
        await api("/files/" + encodeURIComponent(f.name), { method: "DELETE" });
        S.files = (await api("/files")).files; renderSidebar(); openFiles();
      } })]),
    ]));
  }
  if (!S.files.length) tbody.append(el("tr", {}, [el("td", { colspan: "5", class: "muted", text: "No files hosted." })]));
  body.append(el("div", { class: "card" }, [
    el("h3", { text: "First-boot scripts and other downloads" }),
    el("p", { class: "muted", text: "Anything here is downloadable by whoever can reach the URL — the installer cannot authenticate. Never put a credential in a hosted script; fetch it at first boot from something that can check identity." }),
    el("table", {}, [el("thead", {}, [el("tr", {}, [
      el("th", { text: "Name" }), el("th", { text: "Size" }), el("th", { text: "Store" }), el("th", { text: "URL" }), el("th", {}),
    ])]), tbody]),
  ]));
  showPane("files-pane");
}

/* ----------------------------- global wiring -------------------------- */

async function refreshAnswerList() {
  S.answers = (await api("/answers")).answers;
  renderSidebar();
}

function wireGlobalButtons() {
  $("#answer-add").onclick = async () => {
    const name = await ask("New answer", "Answers inherit from Default; only the keys you set here override it.", "", "Create");
    if (!name) return;
    const r = await api("/answers", { method: "POST", body: { name } });
    await refreshAnswerList();
    openAnswer(r.answer.name);
  };
  $("#answer-copy").onclick = async () => {
    if (!S.answer) return toast("Select an answer first.", "warn");
    const name = await ask("Copy answer", `Copy "${S.answer.name}" to a new name.`, S.answer.name + " copy", "Copy");
    if (!name) return;
    const r = await api("/answers", { method: "POST", body: { name, copy_from: S.answer.name } });
    await refreshAnswerList();
    openAnswer(r.answer.name);
  };
  $("#answer-rename").onclick = async () => {
    if (!S.answer) return toast("Select an answer first.", "warn");
    const name = await ask("Rename answer", "", S.answer.name, "Rename");
    if (!name || name === S.answer.name) return;
    await api(`/answers/${encodeURIComponent(S.answer.name)}/rename`, { method: "POST", body: { to: name } });
    await refreshAnswerList();
    openAnswer(name);
  };
  $("#answer-delete").onclick = async () => {
    if (!S.answer) return toast("Select an answer first.", "warn");
    if (!confirm(`Delete answer "${S.answer.name}"?`)) return;
    await api("/answers/" + encodeURIComponent(S.answer.name), { method: "DELETE" });
    S.answer = null; S.dirty = false;
    await refreshAnswerList();
    showPane("empty");
  };
  $("#answer-save").onclick = async () => {
    if (!S.answer) return;
    const problems = answerProblems();
    if (problems.length) {
      toast("Not saved — fix these first: " + problems.join("; "), "bad", 12000);
      return;
    }
    try {
      const r = await api("/answers/" + encodeURIComponent(S.answer.name), {
        method: "PUT",
        body: {
          doc: S.answer.doc,
          settings: {
            priority: S.answer.priority, serve_mode: S.answer.serve_mode,
            allow_cidrs: S.answer.allow_cidrs, secrets_ack: S.answer.secrets_ack, notes: S.answer.notes,
          },
        },
      });
      S.answer = r.answer;
      S.dirty = false;
      await refreshAnswerList();
      renderAnswer();
      toast("Saved.");
    } catch (err) {
      toast(err.message, "bad", 12000);
    }
  };

  $("#relay-add").onclick = async () => {
    const name = await ask("New relay", "Gives you a /hook/<name> endpoint that forwards the installer's post-installation payload.", "", "Create");
    if (!name) return;
    const url = await ask("Relay target", "Where should the payload be forwarded?", "https://", "Save");
    if (!url) return;
    try {
      await api("/relays/" + encodeURIComponent(name), { method: "PUT", body: { url, enabled: true } });
      S.relays = (await api("/relays")).relays;
      renderSidebar();
      openRelay(name);
    } catch (err) { toast(err.message, "bad", 10000); }
  };
  $("#relay-delete").onclick = async () => {
    if (!S.relay) return toast("Select a relay first.", "warn");
    if (!confirm(`Delete relay "${S.relay.name}"?`)) return;
    await api("/relays/" + encodeURIComponent(S.relay.name), { method: "DELETE" });
    S.relay = null;
    S.relays = (await api("/relays")).relays;
    renderSidebar();
    showPane("empty");
  };
  $("#relay-save").onclick = async () => {
    if (!S.relay) return;
    try {
      const r = await api("/relays/" + encodeURIComponent(S.relay.name), {
        method: "PUT",
        body: {
          url: S.relay.url, method: S.relay.method, headers: S.relay.headers || {},
          hmac_secret: S.relay.hmac_secret, body_template: S.relay.body_template, enabled: S.relay.enabled,
        },
      });
      S.relay = r.relay;
      S.relays = (await api("/relays")).relays;
      renderSidebar(); renderRelay();
      toast("Relay saved.");
    } catch (err) { toast(err.message, "bad", 10000); }
  };
  $("#relay-test").onclick = async () => {
    if (!S.relay) return;
    const r = await api(`/relays/${encodeURIComponent(S.relay.name)}/test`, { method: "POST", body: {} });
    toast(r.result.ok ? `Target answered HTTP ${r.result.status}.` : `Delivery failed: ${r.result.error}`, r.result.ok ? "ok" : "bad", 10000);
    loadRelayLog();
  };

  $("#file-add").onclick = () => $("#file-input").click();
  $("#file-input").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const r = await api("/files/" + encodeURIComponent(file.name), { method: "POST", body: bytes, contentType: file.type || "application/octet-stream" });
      S.files = (await api("/files")).files;
      renderSidebar(); openFiles();
      if (r.warnings && r.warnings.length) toast(`Uploaded, but ${file.name} looks like it contains a credential (${r.warnings.join(", ")}). Anyone who can reach the URL can read it.`, "bad", 15000);
      else toast("Uploaded.");
    } catch (err) { toast(err.message, "bad", 10000); }
    e.target.value = "";
  };

  window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
}

boot();
