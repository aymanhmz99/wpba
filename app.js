import * as core from "./core.js";
import * as store from "./db.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtD = (ts) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const VERSION = "0.1.0";

const S = { user: null, users: [], as: [], tab: "new", sub: null, search: "", installEv: null, fails: 0, lockUntil: 0, hiddenAt: 0 };
let F = null; // in-progress assessment form (survives tab switches)

const uname = (id) => S.users.find((u) => u.id === id)?.name || "?";
const residents = () => S.users.filter((u) => u.role === "resident" && u.active !== false).sort((a, b) => a.name.localeCompare(b.name));
const mine = (rid) => S.as.filter((a) => a.resident_id === rid);
const isFac = () => S.user && S.user.role !== "resident";
const reload = async () => { S.users = await store.getAll("users"); S.as = await store.getAll("assessments"); };

let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); }

// ------------------------------------------------------------ dialog helper
function ask(title, fields = [], { ok = "OK", message = "", danger = false } = {}) {
  return new Promise((res) => {
    const d = $("#dlg");
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${message ? `<p class="mut">${esc(message)}</p>` : ""}${fields.map((f) =>
      `<label>${esc(f.label)}</label>${f.type === "textarea" ? `<textarea name="${f.id}" rows="6" placeholder="${esc(f.ph || "")}"></textarea>` :
        `<input name="${f.id}" type="${f.type || "text"}" ${f.type === "password" ? 'inputmode="numeric"' : ""} value="${esc(f.value || "")}" placeholder="${esc(f.ph || "")}">`}`).join("")}
      <button value="ok" class="${danger ? "danger" : ""}">${esc(ok)}</button><button value="cancel" class="alt" formnovalidate>Cancel</button></form>`;
    d.onclose = () => {
      if (d.returnValue !== "ok") return res(null);
      res(Object.fromEntries([...new FormData(d.querySelector("form"))]));
    };
    d.returnValue = "cancel";
    d.showModal();
  });
}

async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return "shared"; } catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}

const newUser = async (name, role, pin) => { const salt = core.randHex(16); return { id: core.uuid(), name: name.trim(), role, active: true, salt, hash: await core.hashPin(pin, salt) }; };

// ------------------------------------------------------------ views: setup & login
function setupView() {
  $("#nav").hidden = true; $("#who").textContent = "";
  $("#app").innerHTML = `<div class="card"><h2>Set up this device</h2>
    <p class="mut">All data stays on this phone. No internet is needed, now or later.</p>
    <label>Administrator name</label><input id="s-name" autocomplete="off">
    <label>PIN (at least 4 digits)</label><input id="s-pin" type="password" inputmode="numeric" autocomplete="off">
    <button data-act="setup">Create administrator</button></div>
    <div class="card"><h3>Restore from a backup file</h3><input id="s-file" type="file" accept=".json,.wpba,application/json">
    <h3>Or try it with demo data</h3><p class="mut">Creates synthetic faculty, residents and assessments (all PINs 1234).</p>
    <button class="alt" data-act="demo">Load demo cohort</button></div>`;
  $("#s-file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; importFile(f, true); };
}

function loginView() {
  S.user = null; $("#nav").hidden = true; $("#who").textContent = "";
  const us = S.users.filter((u) => u.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  $("#app").innerHTML = `<div class="card"><h2>Sign in</h2>
    <label>Name</label><select id="l-user">${us.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${u.role})</option>`).join("")}</select>
    <label>PIN</label><input id="l-pin" type="password" inputmode="numeric" autocomplete="off">
    <button data-act="login">Sign in</button><p id="l-err" class="bad"></p></div>
    <p class="mut" style="text-align:center;font-size:13px">Works fully offline - v${VERSION}</p>`;
}

// ------------------------------------------------------------ shell
function shell() {
  if (!S.user) return loginView();
  $("#who").innerHTML = `${esc(S.user.name)} <button data-act="lock">Lock</button>`;
  const tabs = isFac() ? [["new", "New"], ["people", "Residents"], ["summary", "Summary"], ["data", "Data"]] : [["me", "My progress"]];
  const nav = $("#nav"); nav.hidden = false;
  nav.innerHTML = tabs.map(([t, l]) => `<button data-act="tab" data-t="${t}" class="${S.tab === t ? "on" : ""}">${l}</button>`).join("");
  const v = { new: newView, people: peopleView, summary: summaryView, data: dataView, me: () => progressView(S.user.id, false) }[S.tab];
  v();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------ new assessment
const blankForm = () => ({ tool: Object.keys(core.TOOLS)[0], resident: "", rotation: "", when: "", notes: "", narrative: "", src: "faculty",
  scores: {}, ai: {}, manual: {}, ev: {}, t0: Date.now() });

function critHTML() {
  return Object.entries(core.TOOLS[F.tool].criteria).map(([k, d]) => `<div class="crit"><div class="cl">${esc(d.label)}<div class="ev">${esc(F.ev[k] || "")}</div></div>
    <div class="seg">${[1, 2, 3, 4, 5].map((i) => `<button data-act="score" data-k="${k}" data-v="${i}" class="${F.scores[k] === i ? "on" : ""} ${F.ai[k] && F.scores[k] === i ? "ai" : ""}">${i}</button>`).join("")}</div></div>`).join("")
    + `<div class="legend">1 observer only · 2 direct supervision · 3 indirect · 4 distant · 5 independent. Purple = AI suggestion, please confirm.</div>`;
}

function newView() {
  F ||= blankForm();
  const rs = residents();
  if (!rs.length) { $("#app").innerHTML = `<div class="card"><h2>No residents yet</h2><p class="mut">Ask an administrator to add residents in the Data tab.</p></div>`; return; }
  if (!F.resident) F.resident = rs[0].id;
  $("#app").innerHTML = `<div class="card"><h2>New assessment</h2>
    <label>Resident</label><select data-f="resident">${rs.map((r) => `<option value="${esc(r.id)}" ${F.resident === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
    <label>Tool</label><select data-f="tool" id="f-tool">${Object.entries(core.TOOLS).map(([k, t]) => `<option value="${k}" ${F.tool === k ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
    <div class="row2"><div><label>Rotation</label><input data-f="rotation" value="${esc(F.rotation)}"></div>
    <div><label>Encounter date/time (blank = now)</label><input data-f="when" type="datetime-local" value="${esc(F.when)}"></div></div>
    <label>Observations (type, or use your keyboard's microphone key - works offline on most Android phones)</label>
    <textarea data-f="notes" rows="4" placeholder="e.g. Intubated independently. Needed some prompting on positioning. Capnography confirmed promptly.">${esc(F.notes)}</textarea>
    <button class="alt" data-act="extract">Suggest scores from notes</button></div>
    <div class="card"><h2>Rubric</h2><div id="crit">${critHTML()}</div></div>
    <div class="card"><h2>Feedback to resident</h2><button class="alt" data-act="draft" style="margin-top:0">Draft feedback</button>
    <label>Edit before saving - you are the author</label><textarea data-f="narrative" id="f-nar" rows="7">${esc(F.narrative)}</textarea>
    <button data-act="save">Save assessment</button><button class="alt" data-act="clear">Clear</button></div>`;
}

// ------------------------------------------------------------ progress
function progressHTML(rid) {
  const as = mine(rid), prog = core.domainProgress(core.flattenScores(as)), fl = core.flags(prog);
  const alerts = fl.filter((f) => !f.startsWith("No evidence yet")), gaps = fl.length - alerts.length;
  const bars = Object.entries(core.DOMAINS).map(([d, label]) => {
    const p = prog[d];
    return `<div class="dom"><div class="t"><span>${esc(label)}</span><span>${p ? `<b>${p.recent}</b> <span class="mut">(avg ${p.mean}, n=${p.n}, ${p.delta > 0 ? "+" : ""}${p.delta})</span>` : '<span class="mut">no evidence</span>'}</span></div>
      <div class="bar"><i style="width:${p ? p.recent * 20 : 0}%"></i></div></div>`;
  }).join("");
  const recent = [...as].sort((a, b) => b.encounter_ts - a.encounter_ts).slice(0, 10).map((a) => `<div class="fb"><span class="pill">${fmtD(a.encounter_ts)} · ${esc(core.TOOLS[a.tool]?.name || a.tool)}</span>
    ${a.narrative_source?.startsWith("ai") ? '<span class="pill ai">AI-drafted</span>' : ""} <span class="mut">by ${esc(uname(a.assessor_id))}</span><br>${esc(a.narrative || "(no written feedback)")}</div>`).join("");
  return `<div class="card"><h2>${esc(uname(rid))}</h2><p class="mut">${as.length} assessments · level 1-5 (recent 3 scores)</p>${bars}
    ${alerts.length ? `<h3>Attention</h3>${alerts.map((f) => `<div class="bad">• ${esc(f)}</div>`).join("")}` : ""}
    ${gaps ? `<p class="mut" style="font-size:13px">No evidence yet in ${gaps} of ${Object.keys(core.DOMAINS).length} domains.</p>` : ""}</div>
    <div class="card"><h2>Recent feedback</h2>${recent || '<p class="mut">None yet.</p>'}</div>`;
}
function progressView(rid, back) {
  $("#app").innerHTML = (back ? `<button class="alt" data-act="back" style="margin-top:0">← Residents</button>` : "") + progressHTML(rid);
}

function peopleView() {
  if (S.sub) return progressView(S.sub, true);
  const q = S.search.toLowerCase();
  const rows = residents().filter((r) => r.name.toLowerCase().includes(q)).map((r) => {
    const fl = core.flags(core.domainProgress(core.flattenScores(mine(r.id)))).filter((f) => !f.startsWith("No evidence yet")).length;
    return `<div data-act="open" data-id="${esc(r.id)}"><span>${esc(r.name)}<br><span class="mut" style="font-size:12px">${mine(r.id).length} assessments</span></span><span class="pill ${fl ? "bad" : ""}">${fl} alerts</span></div>`;
  }).join("");
  $("#app").innerHTML = `<div class="card"><input id="search" placeholder="Search residents" value="${esc(S.search)}" autocomplete="off"><div class="list" id="plist">${rows || '<p class="mut">No residents.</p>'}</div></div>`;
  $("#search").oninput = (e) => { S.search = e.target.value; const pos = e.target.selectionStart; peopleView(); const el = $("#search"); el.focus(); el.setSelectionRange(pos, pos); };
}

async function summaryView() {
  const s = core.facultySummary(S.users, S.as);
  const base = await store.getMeta("paperBaselineSeconds");
  const red = base && s.doc.median_s ? core.reductionPct(base, s.doc.median_s) : null;
  $("#app").innerHTML = `<div class="card"><h2>Programme summary</h2><div class="kpis">
    <div class="kpi"><b>${s.residents}</b><span>residents</span></div><div class="kpi"><b>${s.withFlags}</b><span>with alerts</span></div>
    <div class="kpi"><b>${s.turnaround.n ? s.turnaround.median_h + " h" : "-"}</b><span>median feedback delay${s.turnaround.n ? ` (${s.turnaround.within_48h_pct}% within 48 h)` : ""}</span></div>
    <div class="kpi"><b>${s.doc.median_s ?? "-"}${s.doc.median_s ? " s" : ""}</b><span>median time to document</span></div></div>
    <h3>Documentation time vs paper</h3><label>Paper baseline, median seconds per assessment</label>
    <input id="base" type="number" min="1" inputmode="numeric" value="${base || ""}" placeholder="e.g. 180">
    <p>${red === null ? '<span class="mut">Enter your measured paper baseline to compute the reduction.</span>' : `<b>${red}%</b> less time per assessment than paper`}</p></div>
    <div class="card"><h2>Who needs attention</h2><div class="list">${s.detail.filter((d) => d.flags.length).slice(0, 30).map((d) =>
      `<div data-act="open" data-id="${esc(d.id)}"><span>${esc(d.name)}<br><span class="bad" style="font-size:12px">${esc(d.flags[0])}${d.flags.length > 1 ? ` (+${d.flags.length - 1})` : ""}</span></span><span class="pill bad">${d.flags.length}</span></div>`).join("") || '<p class="mut">No alerts.</p>'}</div></div>`;
  $("#base").onchange = async (e) => { await store.setMeta("paperBaselineSeconds", Number(e.target.value) || null); summaryView(); };
}

// ------------------------------------------------------------ data tab
async function dataView() {
  const last = await store.getMeta("lastBackup");
  const stale = S.as.length && (!last || Date.now() - last > 7 * core.DAY);
  const persisted = (await navigator.storage?.persisted?.()) ?? null;
  const admin = S.user.role === "admin";
  $("#app").innerHTML = `<div class="card"><h2>Backup & sharing</h2>
    <p class="${stale ? "warn" : "mut"}">${last ? `Last backup: ${fmtD(last)}` : "No backup yet."}${stale ? " - please back up now (phones get lost)." : ""}</p>
    <p class="mut" style="font-size:13px">Send the backup file to yourself or a colleague (WhatsApp, Bluetooth, USB, email). Open it on another phone with Import to merge records - no internet needed.</p>
    <button data-act="export">Export backup</button><button class="alt" data-act="csv">Export CSV (analysis)</button>
    <h3>Import a backup</h3><input id="d-file" type="file" accept=".json,.wpba,application/json"></div>
    <div class="card"><h2>Integrity & storage</h2><button class="alt" data-act="verify" style="margin-top:0">Verify audit log</button>
    <p class="mut" style="font-size:13px">${S.as.length} assessments, ${S.users.length} users on this device. Storage protected from auto-clearing: ${persisted === null ? "unknown" : persisted ? "yes" : "no (install the app to the home screen)"}.</p>
    ${S.installEv ? '<button data-act="install">Install app on this phone</button>' : ""}</div>
    ${admin ? `<div class="card"><h2>People</h2><button data-act="adduser" style="margin-top:0">Add person</button><button class="alt" data-act="bulk">Add many residents</button>
    <div class="list">${[...S.users].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)).map((u) =>
      `<div data-act="manage" data-id="${esc(u.id)}"><span>${esc(u.name)}</span><span class="pill ${u.active === false ? "bad" : ""}">${u.active === false ? "inactive" : u.role}</span></div>`).join("")}</div></div>` : ""}
    <p class="mut" style="text-align:center;font-size:12px">v${VERSION}</p>`;
  $("#d-file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; importFile(f, false); };
}

async function exportBackup() {
  const pass = await ask("Protect this backup?", [{ id: "p", label: "Passphrase (leave empty for no encryption)", type: "password" }],
    { ok: "Export", message: "The file contains resident performance data. A passphrase is strongly recommended if it will be sent by chat or email." });
  if (!pass) return;
  const json = JSON.stringify(await store.exportAll());
  const enc = pass.p ? await core.encryptText(json, pass.p) : json;
  const r = await saveFile(`wpba-backup-${new Date().toISOString().slice(0, 10)}.wpba`, enc, "application/json");
  if (r !== "cancelled") { await store.setMeta("lastBackup", Date.now()); toast(pass.p ? "Encrypted backup saved" : "Backup saved"); dataView(); }
}

async function importFile(file, firstRun) {
  if (!file) return;
  try {
    let text = await file.text();
    if (JSON.parse(text).format === "wpba-enc-v1") {
      const p = await ask("Backup passphrase", [{ id: "p", label: "Passphrase", type: "password" }], { ok: "Decrypt" });
      if (!p) return;
      text = await core.decryptText(text, p.p);
    }
    const data = JSON.parse(text);
    const r = await store.importAll(S.user?.id || null, data);
    await reload(); toast(`Imported ${r.users} people, ${r.assessments} assessments`);
    firstRun ? loginView() : shell();
  } catch (e) { toast(e.message || "Import failed"); }
}

// ------------------------------------------------------------ demo cohort (synthetic)
async function loadDemo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mk = (n, r) => newUser(n, r, "1234");
  const admin = await mk("Admin", "admin"), fac = await Promise.all(["Dr. Faculty A", "Dr. Faculty B", "Dr. Faculty C"].map((n) => mk(n, "faculty")));
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => mk(`Resident ${String(i + 1).padStart(2, "0")}`, "resident")));
  await store.addUsers(null, [admin, ...fac, ...res]);
  const now = Date.now(), as = [];
  res.forEach((r, ri) => { const base = 1.8 + rnd() * 1.2;
    for (let k = 0; k < (ri < 6 ? 8 : 0); k++) {
      const tool = Object.keys(core.TOOLS)[Math.floor(rnd() * 4)], crit = core.TOOLS[tool].criteria, enc = now - (8 - k) * 9 * core.DAY;
      const scores = {}; for (const [c, d] of Object.entries(crit)) scores[c] = { domain: d.domain, ai: false, score: Math.max(1, Math.min(5, Math.round(base + k * 0.25 + (rnd() - 0.5) * 1.6))) };
      as.push({ uuid: core.uuid(), resident_id: r.id, assessor_id: fac[Math.floor(rnd() * 3)].id, tool, rotation: "Theatre", encounter_ts: enc, submitted_ts: enc + 36e5 * (1 + rnd() * 5),
        feedback_ts: enc + 36e5 * (1 + rnd() * 5), narrative: "Synthetic demo feedback.", narrative_source: "faculty", transcript: "", doc_seconds: 60 + rnd() * 80, scores });
    } });
  await store.audited(null, "demo_seed", String(as.length), ["assessments"], (tx) => as.forEach((a) => tx.objectStore("assessments").add(a)));
  await reload(); toast("Demo cohort loaded"); loginView();
}

// ------------------------------------------------------------ actions
const acts = {
  async setup() {
    const name = $("#s-name").value.trim(), pin = $("#s-pin").value;
    if (!name || !/^\d{4,}$/.test(pin)) return toast("Enter a name and a PIN of 4+ digits");
    await store.addUser(null, await newUser(name, "admin", pin)); await reload(); toast("Administrator created"); loginView();
  },
  demo: loadDemo,
  async login() {
    const now = Date.now(); if (now < S.lockUntil) return ($("#l-err").textContent = `Too many attempts. Wait ${Math.ceil((S.lockUntil - now) / 1000)} s.`);
    const u = S.users.find((x) => x.id === $("#l-user").value);
    if (u && (await core.hashPin($("#l-pin").value, u.salt)) === u.hash) {
      S.user = u; S.fails = 0; S.tab = u.role === "resident" ? "me" : "new"; S.sub = null; shell();
    } else { if (++S.fails >= 5) { S.lockUntil = now + 30000; S.fails = 0; } $("#l-err").textContent = "Wrong PIN."; }
  },
  lock() { S.user = null; loginView(); },
  tab(el) { S.tab = el.dataset.t; S.sub = null; shell(); },
  open(el) { S.tab = "people"; S.sub = el.dataset.id; shell(); },
  back() { S.sub = null; shell(); },
  score(el) {
    const k = el.dataset.k, v = Number(el.dataset.v);
    F.scores[k] = F.scores[k] === v ? undefined : v; if (F.scores[k] === undefined) delete F.scores[k];
    F.manual[k] = true; delete F.ai[k]; $("#crit").innerHTML = critHTML();
  },
  extract() {
    const r = core.extractEntries(F.tool, F.notes); let n = 0;
    for (const [k, e] of Object.entries(r)) {
      F.ev[k] = `"${e.evidence.slice(0, 90)}"${e.suggested ? "" : " - no supervision cue, you decide"}`;
      if (e.suggested && !F.manual[k]) { F.scores[k] = e.suggested; F.ai[k] = true; n++; }
    }
    $("#crit").innerHTML = critHTML(); toast(n ? `${n} suggestion${n > 1 ? "s" : ""} - please confirm` : "No clear supervision cues found");
  },
  draft() {
    let sc; try { sc = core.validateScores(F.tool, F.scores); } catch (e) { return toast(e.message); }
    const prior = Object.fromEntries(Object.entries(core.domainProgress(core.flattenScores(mine(F.resident)))).map(([d, p]) => [d, p.mean]));
    F.narrative = core.draftFeedback(F.tool, sc, F.notes, prior); F.src = "ai_draft_accepted"; $("#f-nar").value = F.narrative;
  },
  clear() { F = blankForm(); newView(); },
  async save() {
    let sc; try { sc = core.validateScores(F.tool, F.scores); } catch (e) { return toast(e.message); }
    const now = Date.now(), enc = F.when ? new Date(F.when).getTime() : now;
    if (enc > now + 6e4) return toast("Encounter time is in the future");
    const narrative = F.narrative.trim();
    const a = { uuid: core.uuid(), resident_id: F.resident, assessor_id: S.user.id, tool: F.tool, rotation: F.rotation.trim(), encounter_ts: enc, submitted_ts: now,
      feedback_ts: narrative ? now : null, narrative, narrative_source: narrative ? F.src : "faculty", transcript: F.notes,
      doc_seconds: Math.min(1800, (now - F.t0) / 1000),
      scores: Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, { domain: core.TOOLS[F.tool].criteria[k].domain, score: v, ai: !!F.ai[k] }])) };
    try { await store.saveAssessment(S.user.id, a); } catch (e) { return toast("Could not save: " + e.message); }
    await reload(); const keep = F.resident; F = blankForm(); F.resident = keep; toast("Saved"); newView(); window.scrollTo(0, 0);
  },
  export: exportBackup,
  async csv() { const r = await saveFile(`wpba-data-${new Date().toISOString().slice(0, 10)}.csv`, core.toCSV(S.users, S.as), "text/csv"); if (r !== "cancelled") toast("CSV saved"); },
  async verify() { toast((await store.verifyAudit()) ? "Audit log intact" : "AUDIT LOG HAS BEEN ALTERED"); },
  async install() { S.installEv?.prompt(); S.installEv = null; },
  async adduser() {
    const r = await ask("Add person", [{ id: "n", label: "Full name" }, { id: "r", label: "Role (resident / faculty / admin)", value: "resident" }, { id: "p", label: "Initial PIN (4+ digits)", type: "password" }], { ok: "Add" });
    if (!r) return;
    if (!r.n.trim() || !["resident", "faculty", "admin"].includes(r.r.trim()) || !/^\d{4,}$/.test(r.p)) return toast("Check name, role and PIN");
    await store.addUser(S.user.id, await newUser(r.n, r.r.trim(), r.p)); await reload(); dataView();
  },
  async bulk() {
    const r = await ask("Add many residents", [{ id: "names", label: "One full name per line", type: "textarea" }, { id: "p", label: "Initial PIN for all (they can be reset later)", type: "password" }], { ok: "Add" });
    if (!r) return;
    const names = [...new Set(r.names.split("\n").map((x) => x.trim()).filter(Boolean))];
    if (!names.length || !/^\d{4,}$/.test(r.p)) return toast("Enter names and a PIN of 4+ digits");
    await store.addUsers(S.user.id, await Promise.all(names.map((n) => newUser(n, "resident", r.p)))); await reload(); toast(`${names.length} residents added`); dataView();
  },
  async manage(el) {
    const u = S.users.find((x) => x.id === el.dataset.id);
    const r = await ask(u.name, [{ id: "p", label: "New PIN (leave empty to keep)", type: "password" }, { id: "a", label: "Active? (yes / no)", value: u.active === false ? "no" : "yes" }], { ok: "Save" });
    if (!r) return;
    const next = { ...u, active: r.a.trim().toLowerCase() !== "no" };
    if (r.p) { if (!/^\d{4,}$/.test(r.p)) return toast("PIN must be 4+ digits"); next.salt = core.randHex(16); next.hash = await core.hashPin(r.p, next.salt); }
    if (u.id === S.user.id && !next.active) return toast("You cannot deactivate yourself");
    await store.updateUser(S.user.id, next); await reload(); dataView();
  },
};

document.addEventListener("click", (e) => { const el = e.target.closest("[data-act]"); if (el) acts[el.dataset.act]?.(el); });
document.addEventListener("input", (e) => {
  const f = e.target.dataset?.f; if (!f || !F) return;
  F[f] = e.target.value;
  if (f === "narrative" && F.src === "ai_draft_accepted") F.src = "ai_draft_edited";
  if (f === "tool") { F.scores = {}; F.ai = {}; F.manual = {}; F.ev = {}; $("#crit").innerHTML = critHTML(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "l-pin") acts.login(); });
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEv = e; });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) S.hiddenAt = Date.now();
  else if (S.user && S.hiddenAt && Date.now() - S.hiddenAt > 120000) loginView(); // auto-lock after 2 min away
});

(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.storage?.persist?.();
  await store.open(); await reload();
  S.users.length ? loginView() : setupView();
  window.__wpba = { S, core, store }; // test hook
})();
