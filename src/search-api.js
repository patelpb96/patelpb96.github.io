import { deriveToken, sha256Hex } from "./search-crypto.js";

// Shared by both search pages (/search/ simple, /search/advanced/ full). The browser never sees
// the Exa API key: every call goes through POST /api/search/{whoami,search,agent,run}
// (lambdas/search/handler.py) with x-search-key. Keys: a device key enrolled once via
// /search/#device=<token> (infra/search_setup.py device), or the shared password turned into a
// token with live/search/config.json's salt.
const API = "/api/search/";
const CONFIG_URL = "/live/search/config.json";
const DEVICE_KEY = "search-device-key";
const REMEMBER_KEY = "search-key";

const store = {
  get: (s, k) => { try { return s.getItem(k); } catch { return null; } },
  set: (s, k, v) => { try { s.setItem(k, v); } catch { /* private mode: this tab only */ } },
  del: (s, k) => { try { s.removeItem(k); } catch { /* ignore */ } },
};
const local = typeof localStorage !== "undefined" ? localStorage : null;
const session = typeof sessionStorage !== "undefined" ? sessionStorage : null;

export async function api(action, body, key) {
  const text = JSON.stringify(body || {});
  let r;
  try {
    r = await fetch(API + action, {
      method: "POST",
      headers: { "content-type": "application/json", "x-search-key": key, "x-amz-content-sha256": await sha256Hex(text) },
      body: text,
    });
  } catch {
    return { code: 0, doc: { status: "error", error: "Network error: couldn't reach patelpb.com." } };
  }
  let doc;
  try { doc = await r.json(); } catch { doc = { status: "error", error: `HTTP ${r.status} (not JSON; is /api/search/ attached?)` }; }
  return { code: r.status, doc };
}

// Device enrolment (#device=<token>), then the stored keys in order.
// -> { key, who } on success, or { notice } (possibly "") when the lock screen is needed.
export async function restoreAccess() {
  const m = /[#&]device=([0-9a-f]{64})\b/.exec(location.hash);
  if (m) {
    store.set(local, DEVICE_KEY, m[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  let notice = "";
  for (const [s, k] of [[local, DEVICE_KEY], [local, REMEMBER_KEY], [session, REMEMBER_KEY]]) {
    const token = store.get(s, k);
    if (!token) continue;
    const { code, doc } = await api("whoami", {}, token);
    if (code === 200) return { key: token, who: doc };
    if (code === 401) {
      store.del(s, k);
      if (k === DEVICE_KEY) notice = "This device's key isn't accepted any more; re-enrol it with infra/search_setup.py device.";
    }
  }
  return { notice };
}

// Throws an Error with a user-facing message; -> { key, who }.
export async function unlockWithPassword(pw, remember) {
  const cfg = await fetch(CONFIG_URL, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!cfg || !cfg.salt || !cfg.iter) throw new Error("Password access isn't set up yet.");
  const token = await deriveToken(pw, cfg.salt, cfg.iter);
  const { code, doc } = await api("whoami", {}, token);
  if (code === 401) throw new Error("Wrong password.");
  if (code !== 200) throw new Error(doc.error || `HTTP ${code}`);
  store.set(remember ? local : session, REMEMBER_KEY, token);
  return { key: token, who: doc };
}

// Forgets the password (a device key stays: it only exists on the owner's PC).
export function forgetPassword() {
  for (const [s, k] of [[local, REMEMBER_KEY], [session, REMEMBER_KEY]]) store.del(s, k);
}

export const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
