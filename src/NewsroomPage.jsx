import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlane } from "./newsroom-plane.js";
import { decryptDoc, deriveSession, encryptDoc, openDay, openSession, sha256Hex } from "./newsroom-crypto.js";
import "./newsroom.css";

const DEFAULT_BASE = "/live/newsroom/";
const PUT_URL = "/api/newsroom/put";

function getBase() {
  let b = DEFAULT_BASE;
  try {
    const q = new URLSearchParams(window.location.search).get("base");
    // only same-origin absolute paths under /live; never an external URL
    if (q && /^\/live[A-Za-z0-9_\-/]*\/$/.test(q)) b = q;
  } catch { /* default */ }
  return b;
}
const BASE = getBase();
const FIXTURE = BASE !== DEFAULT_BASE;

// 404s on the site come back as HTML (the distribution rewrites them), so anything that is not
// JSON counts as "missing".
async function getJson(name) {
  const res = await fetch(`${BASE}${name}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

class WrongPassword extends Error {}

async function getEnc(key, name) {
  const env = await getJson(name);
  if (!env || typeof env !== "object" || !env.ct) return null;
  try { return await decryptDoc(key, env, name); } catch { throw new WrongPassword(); }
}

function newRid() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.getRandomValues(new Uint8Array(12));
  return "r-" + Array.from(b, (x) => a[x % 36]).join("");
}

const fmt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const fmtUntil = (epochS) => new Date(epochS * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const pfx = (session) => session.prefix || "";
const fmtDay = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
};

/** Run `fn` every `ms` while `enabled`; stops cleanly on unmount. fn gets an `alive()` check. */
function usePoll(fn, ms, enabled, deps) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false, t = 0;
    const loop = async () => {
      if (dead) return;
      if (!document.hidden) { try { await ref.current(() => !dead); } catch { /* shown by fn */ } }
      if (!dead) t = setTimeout(loop, ms);
    };
    loop();
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ms, ...deps]);
}

// ------------------------------------------------------------------ unlock
function Unlock({ onUnlock, onCancel }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr("");
    try {
      const cfg = await getJson("config.json");
      if (!cfg || !cfg.salt || !cfg.iter) throw new Error("The newsroom is not set up yet (no config.json).");
      // The 24 h day password (if one is live) unwraps the master key; otherwise it's the master password.
      const session = (await openDay(pw, cfg.day)) || await deriveSession(pw, cfg.salt, cfg.iter);
      const index = await getEnc(session.key, "out/index.json"); // throws WrongPassword if it can't decrypt
      onUnlock(session, index ? index.editions || [] : []);
      setPw("");
    } catch (x) {
      setErr(x instanceof WrongPassword ? "Wrong password." : x.message || "Could not unlock (network error?).");
    } finally { setBusy(false); }
  }

  return (
    <form className="np-card np-unlock" onSubmit={submit}>
      <h2>Unlock the newsroom</h2>
      <label htmlFor="np-pw">Password</label>
      <input id="np-pw" type="password" autoComplete="current-password" autoFocus value={pw}
        onChange={(e) => setPw(e.target.value)} disabled={busy} />
      <button className="np-btn np-primary" disabled={busy || !pw}>{busy ? "Deriving key…" : "Unlock"}</button>
      {err && <p className="np-err" role="alert">{err}</p>}
      <p className="np-fine">The password never leaves this device and is not stored. Everything on the server is ciphertext.</p>
      {onCancel && <button type="button" className="np-btn" onClick={onCancel}>← Back to the open newsroom</button>}
    </form>
  );
}

// ------------------------------------------------------------------ home status
function HomeStatus() {
  const [beat, setBeat] = useState(undefined);
  const [now, setNow] = useState(Date.now());
  usePoll(async (alive) => {
    let b = null;
    try { b = await getJson("beat.json"); } catch { b = null; }
    if (alive()) { setBeat(b); setNow(Date.now()); }
  }, 5000, true, []);
  let state = "offline", label = "Home offline";
  if (beat === undefined) { state = "unknown"; label = "Checking home…"; }
  else if (beat && typeof beat.beat === "number" && now - beat.beat < 60000) {
    state = beat.busy ? "busy" : "online"; label = beat.busy ? "Home busy" : "Home online";
  }
  return <span className={`np-pill np-${state}`} role="status"><i aria-hidden="true" />{label}</span>;
}

// ------------------------------------------------------------------ plane view
function PlaneView({ plane }) {
  const ref = useRef(null);
  const inst = useRef(null);
  useEffect(() => {
    inst.current = createPlane(ref.current);
    return () => inst.current.destroy();
  }, []);
  useEffect(() => { if (plane && inst.current) inst.current.setData(plane); }, [plane]);
  const agents = plane ? plane.nodes.filter((n) => n.kind === "agent").length : 0;
  return (
    <div className="np-plane">
      <canvas ref={ref} role="img" aria-label={`Agent plane with ${agents} agents`} />
      {!plane && <p className="np-fine np-center">Waiting for the agents to start…</p>}
    </div>
  );
}

// ------------------------------------------------------------------ edition
function FactSheet({ fact, sources, n, onClose }) {
  const btn = useRef(null);
  useEffect(() => {
    btn.current && btn.current.focus();
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="np-backdrop" onClick={onClose}>
      <div className="np-sheet" role="dialog" aria-modal="true" aria-label={`Fact ${n}`} onClick={(e) => e.stopPropagation()}>
        <div className="np-sheet-head">
          <span className="np-factno">Fact {n}</span>
          <span className={`np-scope np-${fact.scope}`}>{fact.scope}</span>
          {fact.reliability === "low" && <span className="np-low">less reliable</span>}
          <button ref={btn} className="np-btn np-close" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <p className="np-fact">{fact.statement}</p>
        <ul className="np-srcs">
          {fact.sources.map((s, i) => {
            const src = sources[s.source];
            return (
              <li key={i}>
                <blockquote>{s.quote}</blockquote>
                {src ? (
                  <p className="np-srcmeta">
                    <strong>{src.outlet || src.domain}</strong>
                    {" · "}
                    <a href={/^https?:\/\//i.test(src.url) ? src.url : undefined} target="_blank" rel="noopener noreferrer">{src.title || src.url}</a>
                    <br />
                    <span>{src.kind}{src.reliability === "low" ? " (less reliable)" : ""}{src.published ? ` · published ${fmt(src.published)}` : ""} · fetched {fmt(src.fetched)}</span>
                  </p>
                ) : <p className="np-srcmeta">Source {s.source} unavailable</p>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ArticleView({ art, big, num, onFact, isLow }) {
  return (
    <article className={big ? "np-art np-lead" : "np-art np-card"}>
      {(art.desk || art.reliability === "low") && (
        <p className="np-desk">
          {art.desk}
          {art.reliability === "low" && <span className="np-low" title="Relies partly on social media, forums, listings or other unverified sites">less reliable sources</span>}
        </p>
      )}
      {big ? <h2 className="np-hl">{art.headline}</h2> : <h3 className="np-hl">{art.headline}</h3>}
      {art.dek && <p className="np-dek">{art.dek}</p>}
      {(art.paragraphs || []).map((p, i) => (
        <p key={i} className="np-body">
          {p.sentences.map((s, j) => (
            <span key={j}>
              {s.text}
              {(s.facts || []).map((f) => (
                <sup key={f}><button className={isLow(f) ? "np-fn np-fn-low" : "np-fn"} onClick={() => onFact(f)} aria-label={`Fact ${num(f)}${isLow(f) ? ", less reliable" : ""}`}>{num(f)}</button></sup>
              ))}{" "}
            </span>
          ))}
        </p>
      ))}
    </article>
  );
}

function Edition({ ed }) {
  const [open, setOpen] = useState(null);
  const { factMap, srcMap, numOf } = useMemo(() => {
    const factMap = Object.fromEntries((ed.facts || []).map((f) => [f.id, f]));
    const srcMap = Object.fromEntries((ed.sources || []).map((s) => [s.id, s]));
    const order = {};
    let k = 0;
    for (const a of [ed.headline, ...(ed.articles || [])]) {
      for (const p of (a && a.paragraphs) || []) for (const s of p.sentences) for (const f of s.facts || []) if (!(f in order)) order[f] = ++k;
    }
    return { factMap, srcMap, numOf: order };
  }, [ed]);
  const num = (id) => numOf[id] ?? "?";
  const onFact = (id) => factMap[id] && setOpen(id);
  const isLow = (id) => factMap[id]?.reliability === "low";
  const st = ed.stats || {};
  return (
    <div className="np-paper">
      <header className="np-mast">
        <h1>Agent Report</h1>
        <p className="np-dateline">{fmtDay(ed.created)}</p>
      </header>
      <p className="np-edtitle">{ed.title}</p>
      <p className="np-req">Requested: “{ed.request}”</p>
      {ed.headline && <ArticleView art={ed.headline} big num={num} onFact={onFact} isLow={isLow} />}
      {(ed.articles || []).map((a) => <ArticleView key={a.id} art={a} num={num} onFact={onFact} isLow={isLow} />)}
      {(ed.articles || []).length === 0 && !ed.headline && <p className="np-fine">No stories passed verification.</p>}
      {(ed.notes || []).length > 0 && (
        <aside className="np-notes" aria-label="Editor's notes">
          <h4>Editor’s notes</h4>
          <ul>{ed.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </aside>
      )}
      <footer className="np-stats">
        {st.agents != null && <span>{st.agents} agents</span>}
        {st.minutes != null && <span>{st.minutes} min</span>}
        {st.billing && <span>billed: {st.billing}</span>}
        {st.cost_usd != null && <span>${Number(st.cost_usd).toFixed(2)}</span>}
        <span>{(ed.facts || []).length} facts · {(ed.sources || []).length} sources</span>
      </footer>
      {open && <FactSheet fact={factMap[open]} sources={srcMap} n={num(open)} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ run view
function RunView({ session, rid, onBack }) {
  const [status, setStatus] = useState(null);
  const [plane, setPlane] = useState(null);
  const [edition, setEdition] = useState(null);
  const [err, setErr] = useState("");
  const finished = !!edition || (status && status.state === "failed");

  usePoll(async (alive) => {
    try {
      const st = await getEnc(session.key, `${pfx(session)}out/${rid}/status.json`);
      if (!alive()) return;
      setErr(""); setStatus(st);
      if (st && st.state === "done") {
        const ed = await getEnc(session.key, `${pfx(session)}out/${rid}/edition.json`);
        if (alive()) { if (ed) setEdition(ed); else setErr("The edition is not available yet."); }
        return;
      }
      if (!st || st.state === "failed") return;
      const pl = await getEnc(session.key, `${pfx(session)}out/${rid}/plane.json`);
      if (alive() && pl) setPlane(pl);
    } catch (x) {
      if (alive()) setErr(x instanceof WrongPassword ? "Could not decrypt (wrong password?)." : "Network error; retrying…");
    }
  }, 1500, !finished, [rid, session]);

  const pct = Math.round(((status && status.progress) || 0) * 100);
  return (
    <section>
      <button className="np-btn" onClick={onBack}>← Back</button>
      {!edition && (
        <div className="np-card">
          <h2>{status ? (status.state === "failed" ? "Run failed" : "Working on it") : "Waiting for home…"}</h2>
          {status && (
            <>
              <p className="np-phase">{status.phase}{status.state === "queued" ? " (queued)" : ""}</p>
              <div className="np-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
              <p className="np-msg">{status.message}</p>
            </>
          )}
          {!status && <p className="np-fine">Your request is in the inbox. Home picks it up when it is online.</p>}
          {(plane || (status && status.state !== "failed")) && <PlaneView plane={plane} />}
        </div>
      )}
      {err && <p className="np-err" role="alert">{err}</p>}
      {edition && <Edition ed={edition} />}
    </section>
  );
}

// ------------------------------------------------------------------ home
function Compose({ session, onSent, left }) {
  const [text, setText] = useState("");
  const [win, setWin] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function send(e) {
    e.preventDefault();
    if (FIXTURE || busy || !text.trim()) return;
    setBusy(true); setErr("");
    try {
      const rid = newRid();
      const name = `${pfx(session)}inbox/${rid}.json`;
      const req = { rid, text: text.trim(), created: new Date().toISOString(), opts: { window_hours: win } };
      const doc = await encryptDoc(session.key, name, Date.now(), req);
      const body = JSON.stringify({ name, doc });
      const res = await fetch(PUT_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-newsroom-key": session.token, "x-amz-content-sha256": await sha256Hex(body) },
        body,
      });
      let j = null;
      try { j = await res.json(); } catch { /* not json */ }
      if (res.status === 401 && session.day) throw new Error("This day password has expired.");
      if (res.status === 401 && session.open) throw new Error("Open access has ended.");
      if (res.status === 429) throw new Error("No requests left in this open period.");
      if (!res.ok || !j || j.status !== "ok") {
        throw new Error(`Send failed (HTTP ${res.status})${j && (j.error || j.message) ? `: ${j.error || j.message}` : ""}`);
      }
      setText("");
      onSent(rid, req);
    } catch (x) {
      setErr(x.message || "Network error.");
    } finally { setBusy(false); }
  }

  return (
    <form className="np-card" onSubmit={send}>
      <h2>Ask for a story</h2>
      <label htmlFor="np-req" className="np-sr">Request</label>
      <textarea id="np-req" rows={4} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Find me news in Oakland about SF Tech Week…" disabled={busy} />
      <div className="np-row">
        <label htmlFor="np-win">Window</label>
        <select id="np-win" value={win} onChange={(e) => setWin(Number(e.target.value))} disabled={busy}>
          <option value={24}>Last 24 hours</option>
          <option value={72}>Last 3 days</option>
          <option value={168}>Last 7 days</option>
        </select>
      </div>
      <button className="np-btn np-primary" disabled={FIXTURE || busy || !text.trim() || left === 0}>{busy ? "Sending…" : "Send"}</button>
      {session.open && <p className="np-fine">{left == null ? `Up to ${session.limit} requests while open.` : `${left} of ${session.limit} requests left while open.`} Anyone with this page can read what is asked here.</p>}
      {FIXTURE && <p className="np-fine">Preview mode: this is a read-only fixture, so Send is disabled.</p>}
      {err && <p className="np-err" role="alert">{err}</p>}
    </form>
  );
}

function History({ items, onOpen, onRefresh, refreshing }) {
  return (
    <section>
      <div className="np-row np-between">
        <h2>Editions</h2>
        <button className="np-btn" onClick={onRefresh} disabled={refreshing}>{refreshing ? "…" : "Refresh"}</button>
      </div>
      {items.length === 0 && <p className="np-fine">No editions yet.</p>}
      <ul className="np-hist">
        {items.map((e) => (
          <li key={e.rid}>
            <button className="np-histbtn" onClick={() => onOpen(e.rid)}>
              <strong>{e.title || e.request}</strong>
              <span className="np-histreq">{e.request}</span>
              <span className="np-fine">{e.open ? "open · " : ""}{fmt(e.created)} · {e.state}{e.state === "done" ? ` · ${e.stories} ${e.stories === 1 ? "story" : "stories"}` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ page
export default function NewsroomPage() {
  const [owner, setOwner] = useState(null);         // master or day password session
  const [openS, setOpenS] = useState(null);         // open-mode session (no password), if open
  const [unlocking, setUnlocking] = useState(false); // owner asked for the password form while open
  const [history, setHistory] = useState([]);
  const [openInfo, setOpenInfo] = useState(null);   // { expires, limit, used } from open/out/index.json
  const [rid, setRid] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const session = owner || (unlocking ? null : openS);

  // Open mode: config.json carries a public key while the owner has the newsroom open.
  usePoll(async (alive) => {
    let s = null;
    try { s = await openSession((await getJson("config.json") || {}).open); } catch { s = null; }
    if (!alive()) return;
    setOpenS((cur) => (cur && s && cur.open === s.open ? cur : s));
  }, 60000, true, []);

  const refresh = useCallback(async (s = session) => {
    if (!s) return;
    setRefreshing(true);
    try {
      const idx = await getEnc(s.key, `${pfx(s)}out/index.json`);
      setHistory(idx ? idx.editions || [] : []); setErr("");
      if (s.open) setOpenInfo(idx && idx.open ? idx.open : null);
    } catch (x) { setErr(x instanceof WrongPassword ? "Could not decrypt the history." : "Network error loading history."); }
    setRefreshing(false);
  }, [session]);

  // History refreshes on its own while the list is showing.
  usePoll(() => refresh(), 20000, !!session && !rid, [session, rid]);
  useEffect(() => { setHistory([]); setOpenInfo(null); setRid(null); setErr(""); }, [session]);

  function lock() { setOwner(null); setUnlocking(false); }
  const left = openInfo && openInfo.expires === (session && session.open)
    ? Math.max(0, openInfo.limit - openInfo.used) : null;

  return (
    <div className="np-wrap">
      <div className="np-bar-top">
        <a href="/" className="np-home">patelpb.com</a>
        <HomeStatus />
        {owner && <button className="np-btn np-lock" onClick={lock}>Lock</button>}
        {!owner && session && session.open && <button className="np-btn np-lock" onClick={() => setUnlocking(true)}>Owner</button>}
      </div>
      {!session && (
        <>
          <header className="np-mast"><h1>Agent Report</h1><p className="np-dateline">Private newsroom</p></header>
          <Unlock onUnlock={(s) => { setOwner(s); setUnlocking(false); }}
            onCancel={openS ? () => setUnlocking(false) : undefined} />
        </>
      )}
      {session && session.open && !rid && (
        <p className="np-open-banner" role="status">Open, no password needed, until {fmtUntil(session.open)}.</p>
      )}
      {session && rid && <RunView key={rid} session={session} rid={rid} onBack={() => { setRid(null); refresh(); }} />}
      {session && !rid && (
        <>
          <header className="np-mast"><h1>Agent Report</h1><p className="np-dateline">{fmtDay()}</p></header>
          <Compose session={session} left={left} onSent={(r, req) => {
            setHistory((h) => [{ rid: r, title: req.text, request: req.text, created: req.created, state: "queued", stories: 0 }, ...h]);
            setRid(r);
            if (session.open) setOpenInfo((o) => (o ? { ...o, used: o.used + 1 } : o));
          }} />
          {err && <p className="np-err" role="alert">{err}</p>}
          <History items={history} onOpen={setRid} onRefresh={() => refresh()} refreshing={refreshing} />
        </>
      )}
    </div>
  );
}
