#!/usr/bin/env node
// Local writer for the Scratch "gateway" page (https://patelpb.com/#/projects/scratch/gateway).
//
//   npm run gateway            # serve the editor on http://127.0.0.1:8737/ and open it
//   npm run gateway -- --no-open
//   npm run gateway -- --print-hash   # print the writer key's SHA-256 (for SSM) and exit
//
// The browser editor encrypts the markdown (src/gateway-crypto.js) and posts ciphertext
// here; this process relays it to https://patelpb.com/api/gateway/* adding the writer key
// (~/.patelpb-gateway-key, never sent to the browser). It also owns liveness: while an
// editor tab holds the /events stream and Live is on, it writes a heartbeat every 10 s
// (Node timers aren't throttled like background tabs); when the last tab goes away (5 s
// grace, so a reload survives), on Stop, and on Ctrl+C it sends `end`, which wipes the
// ciphertext from S3. Upstream writes are serialized: one in flight, a queued publish is
// replaced by a newer one, and `end` only goes out after the in-flight write finishes.
//
// Hardening against other pages in your own browser: Host must be exactly 127.0.0.1:PORT
// (defeats DNS rebinding); POSTs need Origin http://127.0.0.1:PORT, Content-Type
// application/json and the per-run token embedded in the editor page; /events needs the
// token too; static files come from a fixed whitelist, never from the URL path.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.GATEWAY_PORT || 8737);
const HOST = "127.0.0.1";
const SELF = `${HOST}:${PORT}`;
const ORIGIN = `http://${SELF}`;
const API = (process.env.GATEWAY_API || "https://patelpb.com/api/gateway").replace(/\/$/, "");
const KEY_FILE = process.env.GATEWAY_KEY_FILE || join(homedir(), ".patelpb-gateway-key");
const BEAT_MS = 10_000;
const GRACE_MS = 5_000;
const MAX_BODY = 300 * 1024;
const ARGS = new Set(process.argv.slice(2));

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------ writer key
function loadKey() {
  if (existsSync(KEY_FILE)) return { key: readFileSync(KEY_FILE, "utf8").trim(), created: false };
  const key = randomBytes(32).toString("base64url");
  writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
  return { key, created: true };
}
const { key: KEY, created } = loadKey();
const KEY_HASH = sha256(KEY);
const setupHelp = [
  "Store its hash in SSM, then (re)attach the edge check:",
  `  MSYS_NO_PATHCONV=1 aws ssm put-parameter --region us-east-1 --name /patelpb/gateway/writer-key-sha256 --type String --overwrite --value ${KEY_HASH}`,
  "  python infra/cloudfront_api.py attach",
].join("\n");
if (ARGS.has("--print-hash")) {
  console.log(KEY_HASH);
  process.exit(0);
}
if (created) console.log(`Created a new writer key in ${KEY_FILE}.\n${setupHelp}\n`);

// ------------------------------------------------------------------ static files
const TOKEN = randomBytes(24).toString("base64url");
const STATIC = new Map([
  ["/", { file: join(HERE, "editor.html"), type: "text/html; charset=utf-8", inject: true }],
  ["/editor.js", { file: join(HERE, "editor.js"), type: "text/javascript; charset=utf-8" }],
  ["/gateway-crypto.js", { file: join(ROOT, "src", "gateway-crypto.js"), type: "text/javascript; charset=utf-8" }],
  ["/marked.js", { file: join(ROOT, "node_modules", "marked", "lib", "marked.esm.js"), type: "text/javascript; charset=utf-8" }],
  ["/purify.js", { file: join(ROOT, "node_modules", "dompurify", "dist", "purify.es.mjs"), type: "text/javascript; charset=utf-8" }],
  ["/wordlist.txt", { file: join(HERE, "eff_large_wordlist.txt"), type: "text/plain; charset=utf-8" }],
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; "
  + "img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ------------------------------------------------------------------ state
const clients = new Set();
const st = {
  live: false,        // the writer wants to be live
  published: false,   // a publish succeeded since going live (heartbeats only after that)
  lastSeq: 0,         // highest seq accepted (publishes) or used (end)
  last: null,         // {action, ok, code, at, error}
  inflight: null,     // action name
};
let next = null;      // the single queued upstream job: {action, body?}
const drainWaiters = [];

function status() {
  return { type: "status", live: st.live, published: st.published, seqFloor: st.lastSeq,
           clients: clients.size, last: st.last, inflight: st.inflight, queued: next?.action || null };
}
function broadcast() {
  const msg = `data: ${JSON.stringify(status())}\n\n`;
  for (const res of clients) res.write(msg);
}

// ------------------------------------------------------------------ upstream queue
function enqueue(job) {
  if (job.action === "beat" && next) return; // anything queued already refreshes beat.json
  next = job;                                 // publish/end replace whatever was queued
  broadcast();
  pump();
}

function drained() {
  if (!st.inflight && !next) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.push(resolve));
}

async function pump() {
  if (st.inflight || !next) return;
  const job = next;
  next = null;
  st.inflight = job.action;
  const body = job.action === "beat" ? { seq: Math.max(st.lastSeq, 1) } : job.body;
  try {
    const text = JSON.stringify(body);
    const r = await fetch(`${API}/${job.action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-key": KEY,
        "x-amz-content-sha256": sha256(text), // required by the Lambda OAC for bodies
      },
      body: text,
      signal: AbortSignal.timeout(10_000),
    });
    const reply = await r.json().catch(() => ({}));
    st.last = { action: job.action, ok: r.ok, code: r.status, at: Date.now(),
                error: r.ok ? null : reply.error || reply.status || r.statusText };
    if (r.ok && job.action === "publish") st.published = true;
    if (r.status === 409 && Number.isSafeInteger(reply.last_seq)) {
      st.lastSeq = Math.max(st.lastSeq, reply.last_seq); // the editor re-publishes above this floor
    }
    if (!r.ok) console.warn(`${job.action}: HTTP ${r.status} ${st.last.error || ""}`);
  } catch (e) {
    st.last = { action: job.action, ok: false, code: 0, at: Date.now(), error: String(e.message || e) };
    console.warn(`${job.action}: ${st.last.error}`);
  } finally {
    st.inflight = null;
    broadcast();
    if (next) pump();
    else drainWaiters.splice(0).forEach((resolve) => resolve());
  }
}

function goOffline() {
  const wasActive = st.live || st.published;
  st.live = false;
  st.published = false;
  if (!wasActive) return broadcast();
  st.lastSeq = Math.max(Date.now(), st.lastSeq + 1);
  enqueue({ action: "end", body: { seq: st.lastSeq } });
}

setInterval(() => {
  if (st.live && st.published && clients.size > 0) enqueue({ action: "beat" });
}, BEAT_MS);

let graceTimer = null;
function onClientsChanged() {
  clearTimeout(graceTimer);
  if (clients.size === 0) {
    graceTimer = setTimeout(() => {
      if (clients.size === 0 && (st.live || st.published)) {
        console.log("editor closed: ending the live session");
        goOffline();
      }
    }, GRACE_MS);
  }
  broadcast();
}

// ------------------------------------------------------------------ http
function tokenOk(got) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

const isB64 = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

async function handle(req, res) {
  if (req.headers.host !== SELF) return send(res, 421, { error: "bad host" });
  const url = new URL(req.url, ORIGIN);

  if (req.method === "GET" && url.pathname === "/events") {
    if (!tokenOk(url.searchParams.get("token"))) return send(res, 401, { error: "bad token" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`retry: 1000\ndata: ${JSON.stringify(status())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); onClientsChanged(); });
    onClientsChanged();
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const entry = STATIC.get(url.pathname);
    if (!entry) return send(res, 404, { error: "not found" });
    let body = readFileSync(entry.file);
    if (entry.inject) body = body.toString("utf8").replace("__GATEWAY_TOKEN__", TOKEN);
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store",
                         "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff",
                         "Referrer-Policy": "no-referrer" });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (req.headers.origin !== ORIGIN) return send(res, 403, { error: "bad origin" });
  if (!(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "json only" });
  if (!tokenOk(req.headers["x-gateway-token"])) return send(res, 401, { error: "bad token" });
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }

  if (url.pathname === "/live") {
    if (body.on === true) {
      st.live = true;
      broadcast();
    } else {
      goOffline();
    }
    return send(res, 200, status());
  }

  if (url.pathname === "/publish") {
    if (!st.live) return send(res, 409, { error: "not live" });
    const { v, seq, kid, salt, iv, ct } = body;
    if (v !== 1 || !Number.isSafeInteger(seq) || typeof kid !== "string" || !/^[0-9a-f]{8,64}$/.test(kid)
        || !isB64(salt, 64) || !isB64(iv, 32) || !isB64(ct, 256 * 1024)) {
      return send(res, 400, { error: "bad publish body" });
    }
    if (seq <= st.lastSeq) return send(res, 409, { error: "stale seq", seqFloor: st.lastSeq });
    st.lastSeq = seq;
    enqueue({ action: "publish", body: { v, seq, kid, salt, iv, ct } });
    return send(res, 202, { ok: true, seq });
  }

  return send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: "internal" }); });
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `port ${PORT} is in use; set GATEWAY_PORT to another port` : e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`gateway editor: ${ORIGIN}/   (relay -> ${API})`);
  console.log(`writer key: ${KEY_FILE} (sha256 ${KEY_HASH.slice(0, 12)}...). Ctrl+C ends the live session.`);
  if (!ARGS.has("--no-open")) {
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", `${ORIGIN}/`]]
      : process.platform === "darwin" ? ["open", [`${ORIGIN}/`]] : ["xdg-open", [`${ORIGIN}/`]];
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
});

let stopping = false;
async function shutdown(sig) {
  if (stopping) process.exit(1); // second Ctrl+C: give up immediately
  stopping = true;
  console.log(`\n${sig}: ending the live session ...`);
  goOffline();
  const timeout = new Promise((resolve) => setTimeout(resolve, 8_000));
  await Promise.race([drained(), timeout]);
  if (st.last?.action === "end") console.log(st.last.ok ? "ended." : `end failed (${st.last.error}); viewers go offline within 30 s anyway.`);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => shutdown(sig));
