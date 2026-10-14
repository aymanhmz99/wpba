// On-device storage (IndexedDB). Every write that matters goes through audited(): the data change and its
// hash-chained audit entry commit in ONE transaction, so a power cut can't leave one without the other.
import * as core from "./core.js";

let db;
let chain = Promise.resolve();
const lock = (fn) => { const r = chain.then(() => fn()); chain = r.catch(() => {}); return r; };
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("aborted")); });

export function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("wpba", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("users", { keyPath: "id" });
      d.createObjectStore("assessments", { keyPath: "uuid" }).createIndex("resident", "resident_id");
      d.createObjectStore("audit", { keyPath: "seq", autoIncrement: true });
      d.createObjectStore("meta", { keyPath: "key" });
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}

export const getAll = (store) => req(db.transaction(store).objectStore(store).getAll());
export const getMeta = async (key) => (await req(db.transaction("meta").objectStore("meta").get(key)))?.value;
export const setMeta = (key, value) => { const t = db.transaction("meta", "readwrite"); t.objectStore("meta").put({ key, value }); return done(t); };

async function lastAuditHash() {
  const c = await req(db.transaction("audit").objectStore("audit").openCursor(null, "prev"));
  return c ? c.value.hash : null;
}

// fn(tx) queues puts synchronously; audit row is appended in the same transaction.
export function audited(actor, action, detail, stores, fn) {
  return lock(async () => {
    const entry = await core.makeAudit(await lastAuditHash(), actor, action, detail);
    const tx = db.transaction([...stores, "audit"], "readwrite");
    const out = fn(tx);
    tx.objectStore("audit").add(entry);
    await done(tx);
    return out;
  });
}

export const addUser = (actor, user) => audited(actor, "user_add", `${user.name}:${user.role}`, ["users"], (tx) => tx.objectStore("users").put(user));
export const updateUser = (actor, user, action = "user_update") => audited(actor, action, user.id, ["users"], (tx) => tx.objectStore("users").put(user));
export const addUsers = (actor, users) => audited(actor, "user_bulk_add", String(users.length), ["users"], (tx) => users.forEach((u) => tx.objectStore("users").put(u)));
export const saveAssessment = (actor, a) => audited(actor, "assessment_add", a.uuid, ["assessments"], (tx) => tx.objectStore("assessments").add(a));

export async function verifyAudit() { return core.verifyChain(await getAll("audit")); }

export async function exportAll() {
  return { format: "wpba-v1", exported: Date.now(), users: await getAll("users"), assessments: await getAll("assessments") };
}

// Merge a file from another phone: users by id (local wins), assessments by uuid (immutable, add-only).
export async function importAll(actor, data) {
  if (!data || data.format !== "wpba-v1" || !Array.isArray(data.users) || !Array.isArray(data.assessments)) throw new Error("Not a WPBA backup file");
  const haveU = new Set((await getAll("users")).map((u) => u.id));
  const haveA = new Set((await getAll("assessments")).map((a) => a.uuid));
  const nu = data.users.filter((u) => u.id && !haveU.has(u.id));
  const na = data.assessments.filter((a) => a.uuid && a.scores && !haveA.has(a.uuid));
  await audited(actor, "import", `users+${nu.length} assessments+${na.length}`, ["users", "assessments"], (tx) => {
    nu.forEach((u) => tx.objectStore("users").put(u));
    na.forEach((a) => tx.objectStore("assessments").put(a));
  });
  return { users: nu.length, assessments: na.length };
}
