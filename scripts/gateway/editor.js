// Gateway editor (served by scripts/gateway/server.mjs on http://127.0.0.1:8737/).
// Encrypts in the browser and posts ciphertext to the local relay; the relay owns
// liveness (heartbeats + end) and the writer key.
import { marked } from "/marked.js";
import DOMPurify from "/purify.js";
import { MIN_BITS, VERSION, deriveKey, encrypt, estimateEntropy, newKid, newSalt } from "/gateway-crypto.js";

const TOKEN = document.querySelector('meta[name="gateway-token"]').content;
const $ = (id) => document.getElementById(id);
const src = $("src"), preview = $("preview"), pw = $("pw"), applyBtn = $("apply"), liveBtn = $("live");
const light = $("light"), badge = $("badge"), bits = $("bits"), meterbar = $("meterbar"), keynote = $("keynote");

let applied = null;   // {kid, salt, key}
let server = null;    // last status from /events
let lastSeq = 0;
let connected = false;

// ------------------------------------------------------------- draft + key persistence
// Local to this editor origin only. The derived key is a non-extractable CryptoKey.
const DRAFT = "gateway-draft";
try { src.value = localStorage.getItem(DRAFT) || ""; } catch { /* storage unavailable */ }

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("gateway-editor", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveKey = (k) => idb("readwrite", (s) => s.put(k, "key")).catch(() => {});
const loadKey = () => idb("readonly", (s) => s.get("key")).catch(() => null);

// ------------------------------------------------------------- preview
let previewQueued = false;
function renderPreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    preview.innerHTML = DOMPurify.sanitize(marked.parse(src.value));
  });
}

// ------------------------------------------------------------- password field
const pwDirty = () => pw.value.length > 0;

function updatePwUi() {
  const b = estimateEntropy(pw.value);
  const strong = b >= MIN_BITS;
  bits.textContent = pw.value ? `~${Math.round(b)} bits${strong ? "" : ` (need ${MIN_BITS})`}` : "";
  meterbar.style.width = `${Math.min(100, (b / 80) * 100)}%`;
  meterbar.style.background = strong ? "var(--ok)" : b >= 40 ? "var(--warn)" : "var(--bad)";
  applyBtn.disabled = !strong;
  updateStatus();
}

async function applyPassword() {
  const value = pw.value;
  if (estimateEntropy(value) < MIN_BITS) {
    keynote.textContent = `Refused: that password is too weak (about ${Math.round(estimateEntropy(value))} bits, need ${MIN_BITS}). Try Generate.`;
    return;
  }
  applyBtn.disabled = true;
  const salt = newSalt();
  const k = { kid: newKid(), salt, key: await deriveKey(value, salt) };
  applied = k;
  await saveKey(k);
  pw.value = "";
  pw.type = "password";
  $("show").textContent = "Show";
  keynote.textContent = `Password applied (key ${k.kid.slice(0, 6)}). Viewers on the old password are asked for the new one.`;
  updatePwUi();
  publishNow();
}

$("show").addEventListener("click", () => {
  pw.type = pw.type === "password" ? "text" : "password";
  $("show").textContent = pw.type === "password" ? "Show" : "Hide";
});
pw.addEventListener("input", updatePwUi);
pw.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); applyPassword(); }
  if (e.key === "Escape") { pw.value = ""; updatePwUi(); }
});
applyBtn.addEventListener("click", applyPassword);

let words = null;
$("gen").addEventListener("click", async () => {
  if (!words) {
    const text = await (await fetch("/wordlist.txt")).text();
    words = text.split(/\r?\n/).map((l) => l.split("\t")[1]).filter(Boolean);
  }
  const limit = Math.floor(2 ** 32 / words.length) * words.length; // rejection sampling: no modulo bias
  const out = [];
  const buf = new Uint32Array(1);
  while (out.length < 5) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(words[buf[0] % words.length]);
  }
  pw.value = out.join("-");
  pw.type = "text";
  $("show").textContent = "Hide";
  keynote.textContent = "Generated. Copy it somewhere for your viewers, then press Apply.";
  updatePwUi();
});

// ------------------------------------------------------------- publishing
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gateway-token": TOKEN },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

let publishing = false, again = false;
async function publishNow() {
  if (!server?.live || !applied || pwDirty()) return updateStatus();
  if (publishing) { again = true; return; }
  publishing = true;
  try {
    const k = applied;
    const seq = Math.max(Date.now(), lastSeq + 1, (server?.seqFloor || 0) + 1);
    lastSeq = seq;
    const { iv, ct } = await encrypt(k.key, { kid: k.kid, seq }, src.value);
    const r = await post("/publish", { v: VERSION, seq, kid: k.kid, salt: k.salt, iv, ct });
    if (r.status === 409 && Number.isSafeInteger(r.body.seqFloor)) {
      lastSeq = Math.max(lastSeq, r.body.seqFloor);
      again = true;
    }
  } finally {
    publishing = false;
    if (again) { again = false; publishNow(); }
  }
}

// 300 ms debounce, but never more than 1 s between publishes while typing.
let debounce = null, firstPending = 0;
function schedulePublish() {
  const now = performance.now();
  if (!firstPending) firstPending = now;
  clearTimeout(debounce);
  const wait = Math.max(0, Math.min(300, 1000 - (now - firstPending)));
  debounce = setTimeout(() => { firstPending = 0; publishNow(); }, wait);
}

src.addEventListener("input", () => {
  try { localStorage.setItem(DRAFT, src.value); } catch { /* storage unavailable */ }
  renderPreview();
  schedulePublish();
});

liveBtn.addEventListener("click", async () => {
  liveBtn.disabled = true;
  await post("/live", { on: !server?.live }).catch(() => {});
});

// ------------------------------------------------------------- status from the relay
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 2 ? "just now" : `${s}s ago`;
}

function updateStatus() {
  badge.hidden = !(pwDirty() && applied);
  liveBtn.disabled = !connected || (!server?.live && !applied);
  liveBtn.textContent = server?.live ? "Stop" : "Go live";
  liveBtn.className = server?.live ? "stop" : "primary";
  let cls = "", text;
  const last = server?.last;
  if (!connected) { cls = "bad"; text = "Relay not running"; }
  else if (!server.live) { text = applied ? "Offline" : "Offline (apply a password first)"; }
  else if (pwDirty() && applied) { cls = "warn"; text = "Live, paused"; }
  else if (!applied) { cls = "warn"; text = "Live, no password"; }
  else if (last && !last.ok) { cls = "bad"; text = `Live, ${last.action} failed (${last.code || "network"}${last.error ? `: ${last.error}` : ""})`; }
  else if (server.published) { cls = "ok"; text = `Live, saved ${last ? ago(last.at) : ""}`; }
  else { cls = "warn"; text = "Going live…"; }
  light.className = `light ${cls}`;
  light.textContent = text;
}
setInterval(updateStatus, 1000);

function connect() {
  const es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    const prev = server;
    server = JSON.parse(e.data);
    connected = true;
    // Publish on going live, and again if the relay raised the seq floor (a 409 upstream).
    if (server.live && (!prev?.live || (server.seqFloor > lastSeq && !server.inflight && !server.queued))) publishNow();
    updateStatus();
  };
  es.onerror = () => { connected = false; updateStatus(); };
}

// ------------------------------------------------------------- boot
(async () => {
  const k = await loadKey();
  if (k?.key && k.kid && k.salt) {
    applied = k;
    keynote.textContent = `Using the last applied password (key ${k.kid.slice(0, 6)}). Apply a new one to change it.`;
  }
  renderPreview();
  updatePwUi();
  connect();
})();
