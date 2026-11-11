// Vite plugin for the model tracker's local Run panel. Dev server only (`apply: "serve"`): `vite build` never
// loads it, so patelpb.com has no such endpoints. Two POST routes, both run on this machine with its own tools:
//
//   POST /__models/refresh  re-read the Artificial Analysis leaderboard and rebuild the page's data file (free)
//   POST /__models/scan     invoke the scheduled news-scan Lambda once with the local AWS sign-in (~$0.31)
//
// Guards: the dev server listens on localhost; requests must come from a localhost origin and carry the
// X-Models-Dev header (a page on another site cannot add that header without a preflight, which is never
// answered); only one job runs at a time. Nothing here deploys: publishing stays `npm run deploy:aws`.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER = path.join(ROOT, "projects", "model-tracker");
const LAMBDA = "patelpb-model-scrape";

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const tail = (s, n = 1200) => (s.length > n ? `…${s.slice(-n)}` : s);
const firstJson = (s) => {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
};

async function refresh() {
  const aa = await run("python", ["-m", "scraper.aa_source", "refresh"], TRACKER, 120_000);
  if (aa.code !== 0) return { ok: false, step: "reference rescan", detail: tail(aa.err || aa.out) };
  const build = await run("python", ["build_snapshot.py"], TRACKER, 120_000);
  if (build.code !== 0) return { ok: false, step: "rebuild data file", detail: tail(build.err || build.out) };
  const summary = firstJson(aa.out) || {};
  const counts = firstJson(build.out.replace(/'/g, '"')) || {};      // build_snapshot prints a Python dict
  return { ok: true, records: summary.records, tracked: summary.tracked, added: summary.added || {}, snapshot: counts };
}

async function scan() {
  const dir = mkdtempSync(path.join(tmpdir(), "models-scan-"));
  const outFile = path.join(dir, "result.json");
  try {
    const r = await run("aws", ["lambda", "invoke", "--function-name", LAMBDA, "--cli-read-timeout", "330", "--output", "json", outFile], ROOT, 340_000);
    if (r.code !== 0) {
      const msg = r.err || r.out;
      const expired = /expired|aws login|ExpiredToken|reauthenticate/i.test(msg);
      return { ok: false, step: "invoke Lambda", detail: expired ? "Your AWS sign-in has expired: run `aws login` in a terminal, then try again." : tail(msg) };
    }
    const meta = firstJson(r.out) || {};
    const body = JSON.parse(readFileSync(outFile, "utf-8"));
    if (meta.FunctionError) return { ok: false, step: "Lambda error", detail: tail(JSON.stringify(body)) };
    const keep = ["status", "reason", "slot", "exa_calls", "cost_usd", "new_hits", "duplicates", "candidates", "stale_suspects", "fetched", "errors", "stopped"];
    const out = Object.fromEntries(keep.filter((k) => body[k] !== undefined && body[k] !== null).map((k) => [k, body[k]]));
    if (body.aa) out.reference = body.aa.status;
    return { ok: true, ...out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export default function modelsDevRunner() {
  let busy = null;
  return {
    name: "models-dev-runner",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const route = req.url === "/__models/refresh" ? refresh : req.url === "/__models/scan" ? scan : null;
        if (!route) return next();
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        const origin = req.headers.origin || "";
        if (req.method !== "POST" || req.headers["x-models-dev"] !== "1" || (origin && !LOCAL.test(origin))) {
          return send(403, { ok: false, detail: "local Run panel requests only" });
        }
        if (busy) return send(409, { ok: false, detail: `already running: ${busy}` });
        busy = req.url;
        try {
          send(200, await route());
        } catch (e) {
          send(500, { ok: false, detail: String(e && e.message ? e.message : e) });
        } finally {
          busy = null;
        }
      });
    },
  };
}
