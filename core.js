// Pure logic (no DOM, no storage): rubrics, validation, note->score extraction, feedback drafting,
// longitudinal analytics, tamper-evident audit hashing, PIN hashing, CSV export.
// Runs identically in the phone's browser/WebView and in Node (for tests).

export const SCALE = {
  1: "Observer only / needs to be done for them",
  2: "Direct, proactive supervision (supervisor in the room)",
  3: "Indirect supervision (supervisor immediately available)",
  4: "Distant supervision (supervisor available on request)",
  5: "Independent / could supervise others",
};

export const DOMAINS = {
  PRE: "Pre-operative assessment & planning",
  AIR: "Airway management",
  GA: "General anaesthesia conduct & monitoring",
  REG: "Regional & neuraxial anaesthesia",
  CRIT: "Crisis management & resuscitation",
  POST: "Post-operative care & pain management",
  COM: "Communication & professionalism",
};

// EDIT THIS to mirror the exact criteria printed in the Dire Dawa paper folders.
const C = (domain, label, kw) => ({ domain, label, kw });
export const TOOLS = {
  MINICEX: {
    name: "Mini-CEX (pre-operative evaluation)",
    criteria: {
      history: C("PRE", "Focused history & risk identification", ["history", "allergy", "comorbid", "asa", "fasting", "npo"]),
      exam: C("PRE", "Airway & systems examination", ["mallampati", "examination", "airway exam", "neck", "auscultat"]),
      plan: C("PRE", "Anaesthetic plan & consent", ["plan", "consent", "options", "risk discussion"]),
      comm: C("COM", "Communication with patient & team", ["communicat", "explained", "rapport", "team", "handover"]),
    },
  },
  DOPS_AIRWAY: {
    name: "DOPS - Airway management & intubation",
    criteria: {
      prep: C("AIR", "Preparation, equipment & positioning", ["prepar", "equipment", "position", "suction", "checklist", "preoxyg"]),
      technique: C("AIR", "Laryngoscopy / intubation technique", ["laryngoscop", "intubat", "technique", "bougie", "view", "cormack"]),
      confirm: C("AIR", "Confirmation (capnography) & securing tube", ["capnograph", "etco2", "confirm", "secured", "auscultat"]),
      failed: C("CRIT", "Recognition of difficulty / failed airway plan", ["difficult", "failed", "plan b", "lma", "front of neck", "rescue"]),
    },
  },
  DOPS_REGIONAL: {
    name: "DOPS - Spinal / regional anaesthesia",
    criteria: {
      asepsis: C("REG", "Asepsis & patient positioning", ["aseptic", "asepsis", "sterile", "position", "gloves"]),
      technique: C("REG", "Block technique & landmark/ultrasound use", ["spinal", "epidural", "block", "ultrasound", "landmark", "needle"]),
      safety: C("REG", "Dose selection & complication awareness", ["dose", "toxicity", "hypotension", "aspirat", "test dose", "complication"]),
    },
  },
  CBD: {
    name: "Case-based discussion (intra-/post-operative)",
    criteria: {
      monitor: C("GA", "Intra-operative monitoring & drug management", ["monitor", "induction", "maintenance", "vasopressor", "fluid", "drug"]),
      crisis: C("CRIT", "Crisis recognition & management", ["anaphylaxis", "arrest", "bleeding", "crisis", "hypoxi", "laryngospasm", "resuscit"]),
      post: C("POST", "Recovery & analgesia planning", ["recovery", "analgesi", "pain", "pacu", "nausea", "multimodal"]),
      reason: C("GA", "Clinical reasoning & evidence use", ["reasoning", "rationale", "evidence", "guideline", "justif"]),
    },
  },
};

export function validateScores(tool, scores) {
  const t = TOOLS[tool];
  if (!t) throw new Error(`unknown tool ${tool}`);
  const out = {};
  for (const [k, v] of Object.entries(scores || {})) {
    if (!t.criteria[k]) throw new Error(`unknown criterion ${k} for ${tool}`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`score for ${k} must be 1-5`);
    out[k] = n;
  }
  if (!Object.keys(out).length) throw new Error("score at least one criterion");
  return out;
}

// ---------------------------------------------------------------- note -> suggested rubric entries
const CUES = [
  [/\b(could supervise|teach(es|ing)? others|fully independent|independent(ly)?)\b/i, 5],
  [/\b(minimal (help|input|guidance)|only (minor|small) (prompt|correction)|distant supervision)\b/i, 4],
  [/\b(occasional(ly)? prompt|some (help|guidance|prompting)|prompted|needed reminding|indirect supervision)\b/i, 3],
  [/\b(needed (a lot|much|significant) (of )?(help|guidance)|constant(ly)? (prompt|guid)|direct supervision|hands[- ]on)\b/i, 2],
  [/\b(took over|had to take over|unable|could not|observed only|performed by (me|supervisor))\b/i, 1],
];

export function extractEntries(tool, text) {
  const out = {};
  const sentences = String(text || "").split(/(?<=[.!?;\n])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const [crit, def] of Object.entries(TOOLS[tool].criteria)) {
    const hits = sentences.filter((s) => def.kw.some((k) => s.toLowerCase().includes(k)));
    if (!hits.length) continue;
    let suggested = null, evidence = hits[0];
    outer: for (const s of hits) {
      for (const [rx, val] of CUES) if (rx.test(s)) { suggested = val; evidence = s; break outer; }
    }
    out[crit] = { suggested, evidence };
  }
  return out;
}

// ---------------------------------------------------------------- analytics
export const DAY = 864e5;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => Math.round(x * 100) / 100;

export function flattenScores(assessments) {
  const rows = [];
  for (const a of assessments)
    for (const s of Object.values(a.scores)) rows.push({ domain: s.domain, score: s.score, ts: a.encounter_ts });
  return rows;
}

export function domainProgress(rows) {
  const by = {};
  for (const r of rows) (by[r.domain] ||= []).push(r);
  const out = {};
  for (const [d, list] of Object.entries(by)) {
    list.sort((a, b) => a.ts - b.ts);
    const sc = list.map((x) => x.score), recent = sc.slice(-3), early = sc.slice(0, -3).length ? sc.slice(0, -3) : sc.slice(0, 1);
    out[d] = { label: DOMAINS[d], n: sc.length, mean: r2(mean(sc)), recent: r2(mean(recent)),
      delta: sc.length > 1 ? r2(mean(recent) - mean(early)) : 0, last_ts: list[list.length - 1].ts };
  }
  return out;
}

export function flags(progress, now = Date.now(), minLevel = 3, staleDays = 60) {
  const fl = [];
  for (const d of Object.keys(DOMAINS)) {
    const p = progress[d];
    if (!p) { fl.push(`No evidence yet: ${DOMAINS[d]}`); continue; }
    if (p.n >= 3 && p.recent < minLevel) fl.push(`Below expected level in ${p.label} (recent ${p.recent})`);
    if (p.n >= 4 && p.delta <= 0) fl.push(`Not progressing in ${p.label} (${p.delta >= 0 ? "+" : ""}${p.delta})`);
    if (now - p.last_ts > staleDays * DAY) fl.push(`No assessment in ${p.label} for over ${staleDays} days`);
  }
  return fl;
}

export function turnaround(assessments) {
  const h = assessments.filter((a) => a.feedback_ts).map((a) => (a.feedback_ts - a.encounter_ts) / 36e5);
  return h.length ? { n: h.length, median_h: Math.round(median(h) * 10) / 10, within_48h_pct: Math.round(100 * h.filter((x) => x <= 48).length / h.length) } : { n: 0 };
}
export function docOverhead(assessments) {
  const s = assessments.map((a) => a.doc_seconds).filter(Boolean);
  return { n: s.length, median_s: s.length ? Math.round(median(s) * 10) / 10 : null };
}
export const reductionPct = (base, now) => (base ? Math.round(1000 * (base - now) / base) / 10 : null);

export function facultySummary(users, assessments, now = Date.now()) {
  const residents = users.filter((u) => u.role === "resident" && u.active !== false);
  const detail = residents.map((r) => {
    const mine = assessments.filter((a) => a.resident_id === r.id);
    const all = flags(domainProgress(flattenScores(mine)), now);
    // coverage gaps ("no evidence yet") are reported separately so real performance alerts stand out
    return { id: r.id, name: r.name, assessments: mine.length, flags: all.filter((f) => !f.startsWith("No evidence yet")), gaps: all.length - all.filter((f) => !f.startsWith("No evidence yet")).length };
  }).sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name));
  return { residents: residents.length, withFlags: detail.filter((d) => d.flags.length).length,
    turnaround: turnaround(assessments), doc: docOverhead(assessments), detail };
}

// ---------------------------------------------------------------- feedback drafting (on-device, deterministic)
export function draftFeedback(tool, scores, notes = "", prior = {}) {
  const crit = TOOLS[tool].criteria;
  const strong = [], mid = [], weak = [], trend = new Set();
  for (const [k, v] of Object.entries(scores)) {
    if (v >= 4) strong.push(crit[k].label); else if (v === 3) mid.push(crit[k].label); else weak.push(crit[k].label);
    const p = prior[crit[k].domain];
    if (p !== undefined && Math.abs(v - p) >= 0.75) trend.add(`${DOMAINS[crit[k].domain]} ${v > p ? "improved" : "dipped"} versus your earlier average`);
  }
  const p = [];
  p.push(strong.length ? `What went well: ${strong.join("; ")}.` : "What went well: you completed the encounter safely under supervision.");
  if (weak.length) p.push(`Priority areas: ${weak.join("; ")}. Rehearse these steps in simulation or with a supervisor before the next case.`);
  else if (mid.length) p.push(`To progress: build consistency in ${mid.join("; ")} so less prompting is needed.`);
  if (trend.size) p.push(`Trend: ${[...trend].sort().join("; ")}.`);
  if (notes.trim()) p.push(`Assessor note: ${notes.trim()}`);
  p.push(`Next step: agree one learning goal on '${weak[0] || mid[0] || "a more complex case in the same domain"}' and request a repeat assessment within two weeks.`);
  return p.join("\n");
}

// ---------------------------------------------------------------- crypto helpers
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randHex = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer);
export const uuid = () => { const h = randHex(16); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
export async function hashPin(pin, saltHex, iterations = 100000) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

// hash-chained audit log: editing or deleting any past entry breaks verification
export async function makeAudit(prevHash, actor, action, detail, ts = Date.now()) {
  const prev = prevHash || "GENESIS";
  return { ts, actor, action, detail, prev, hash: await sha256(prev + JSON.stringify([ts, actor, action, detail])) };
}
export async function verifyChain(entries) {
  let prev = "GENESIS";
  for (const e of entries) {
    const h = await sha256(prev + JSON.stringify([e.ts, e.actor, e.action, e.detail]));
    if (e.prev !== prev || e.hash !== h) return false;
    prev = e.hash;
  }
  return true;
}

// ---------------------------------------------------------------- CSV export for the study analysis
export function toCSV(users, assessments) {
  const name = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [["assessment_id", "encounter", "resident", "assessor", "tool", "rotation", "criterion", "domain", "score", "ai_suggested",
    "feedback_delay_h", "doc_seconds", "narrative_source"]];
  for (const a of assessments)
    for (const [k, s] of Object.entries(a.scores))
      rows.push([a.uuid, new Date(a.encounter_ts).toISOString(), name[a.resident_id], name[a.assessor_id], a.tool, a.rotation, k, s.domain,
        s.score, s.ai ? 1 : 0, a.feedback_ts ? r2((a.feedback_ts - a.encounter_ts) / 36e5) : "", a.doc_seconds ? r2(a.doc_seconds) : "", a.narrative_source]);
  return rows.map((r) => r.map(q).join(",")).join("\n");
}

// ---------------------------------------------------------------- optional passphrase encryption for backup files
// (backups travel by WhatsApp/USB/Bluetooth and contain resident performance data)
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey(pass, salt, iterations) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptText(text, pass, iterations = 150000) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(pass, salt, iterations), new TextEncoder().encode(text)));
  return JSON.stringify({ format: "wpba-enc-v1", iterations, salt: b64(salt), iv: b64(iv), data: b64(ct) });
}
export async function decryptText(envelope, pass) {
  const e = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv) }, await aesKey(pass, unb64(e.salt), e.iterations), unb64(e.data));
    return new TextDecoder().decode(pt);
  } catch { throw new Error("Wrong passphrase or damaged file"); }
}
