// Scratch "gateway" viewer (#/projects/scratch/gateway): live, password-gated markdown written
// from the local editor (scripts/gateway/). Read-only: it polls two small files that CloudFront
// serves from S3 and decrypts in the browser (src/gateway-crypto.js).
//
//   live/gateway/beat.json   {v, live, seq, beat, updated}   rewritten every ~10 s + on edits
//   live/gateway/state.json  {v, live, seq, kid, salt, iv, ct} rewritten on edits/re-keys only
//
// "Live" means beat.json says live and its `beat` value changed within the last 30 s of local
// performance.now() (so the viewer's wall clock never matters); a newly seen beat is aged with
// the response's Date + Age headers against `updated`, both server clocks. Anything that isn't
// a JSON 2xx (the disguised 404 page, GitHub Pages, network errors) reads as "Not live".
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { decrypt, deriveKey } from "./gateway-crypto.js";

const BASE = `${import.meta.env.BASE_URL}live/gateway/`;
const POLL_MS = 1000;
const STALE_MS = 30000;

// The derived key (non-extractable CryptoKey) for the latest kid, kept across reloads.
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("gateway-viewer", 1);
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
const idbGet = () => { try { return idb("readonly", (s) => s.get("key")).catch(() => null); } catch { return Promise.resolve(null); } };
const idbPut = (v) => { try { return idb("readwrite", (s) => s.put(v, "key")).catch(() => {}); } catch { return Promise.resolve(); } };
const idbClear = () => { try { return idb("readwrite", (s) => s.delete("key")).catch(() => {}); } catch { return Promise.resolve(); } };

async function getJson(name) {
  try {
    const r = await fetch(BASE + name, { cache: "no-cache" });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j !== "object" || j.v !== 1) return null;
    const serverNow = Date.parse(r.headers.get("date") || "") + (Number(r.headers.get("age")) || 0) * 1000;
    return { j, serverNow };
  } catch {
    return null;
  }
}

const render = (md) => DOMPurify.sanitize(marked.parse(md));

// Clipboard HTML for Word, Docs and mail apps: the document's structure (headings, bold, lists,
// tables, links, code) without the page's computed dark-theme styles, which a browser copy
// carries along and which paste as pale text. Tables get borders so they survive as tables.
function clipHtml(frag) {
  const box = document.createElement("div");
  box.append(frag);
  for (const t of box.querySelectorAll("table")) {
    t.setAttribute("border", "1");
    t.setAttribute("cellpadding", "4");
    t.style.borderCollapse = "collapse";
  }
  return `<html><body>${box.innerHTML}</body></html>`;
}

// The document body. Its DOM is only touched when the rendered HTML actually changes, so
// heartbeats, the "updated Xs ago" chip and re-sent identical text never wipe a selection.
const LiveDoc = memo(function LiveDoc({ html }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html;
  }, [html]);
  // Ctrl+C on a selection inside the document copies the clean version too.
  useEffect(() => {
    const onCopy = (e) => {
      const sel = getSelection();
      if (!sel.rangeCount || sel.isCollapsed || !ref.current?.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
      e.clipboardData.setData("text/html", clipHtml(sel.getRangeAt(0).cloneContents()));
      e.clipboardData.setData("text/plain", sel.toString());
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);
  return <article ref={ref} className="scratch-doc prose gateway-doc" aria-live="polite" />;
});

export default function GatewayView() {
  const [phase, setPhase] = useState("loading"); // loading|offline|locked|wrong|changed|unlocking|live
  const [html, setHtml] = useState("");
  const [updatedAgo, setUpdatedAgo] = useState(null);
  const [pw, setPw] = useState("");
  const [copied, setCopied] = useState(false);
  const s = useRef({ beatVal: undefined, beatAt: 0, state: null, key: null, hadKey: false, askKid: null, contentAt: 0, busy: false });

  const offline = useCallback(() => {
    s.current.state = null;
    setHtml("");
    setPhase("offline");
  }, []);

  // Decrypt and show s.current.state with whatever key we hold; otherwise ask for one.
  const show = useCallback(async () => {
    const cur = s.current;
    const st = cur.state;
    if (!st) return;
    if (!cur.key || cur.key.kid !== st.kid) {
      const stored = await idbGet();
      if (stored?.kid === st.kid && stored.key) cur.key = stored;
    }
    if (cur.key?.kid === st.kid) {
      try {
        setHtml(render(await decrypt(cur.key.key, st)));
        setPhase("live");
        return;
      } catch {
        cur.key = null;
      }
    }
    setHtml("");
    const sameAsk = cur.askKid === st.kid; // still asking for the same password: keep "wrong"/"unlocking"
    cur.askKid = st.kid;
    setPhase((p) => (sameAsk && (p === "wrong" || p === "unlocking") ? p : cur.hadKey ? "changed" : "locked"));
  }, []);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const tick = async () => {
      const cur = s.current;
      if (cur.busy || document.hidden) return;
      cur.busy = true;
      try {
        const b = await getJson("beat.json");
        if (!alive) return;
        if (!b || b.j.live !== true) return offline();
        const now = performance.now();
        if (b.j.beat !== cur.beatVal) {
          cur.beatVal = b.j.beat;
          const age = b.j.updated ? b.serverNow - Date.parse(b.j.updated) : NaN;
          cur.beatAt = now - (Number.isFinite(age) ? Math.min(Math.max(age, 0), 2 * STALE_MS) : 0);
        }
        if (now - cur.beatAt > STALE_MS) return offline();
        if (!cur.state || b.j.seq > cur.state.seq) {
          const st = await getJson("state.json");
          if (!alive) return;
          if (st?.j.live === true && typeof st.j.ct === "string" && st.j.seq > (cur.state?.seq || 0)) {
            cur.state = st.j;
            cur.contentAt = Date.now();
            await show();
          } else if (st?.j.live === false && st.j.seq >= b.j.seq) {
            return offline();
          } // else: the edge still has an older state.json; retry next tick
        }
        if (cur.contentAt) setUpdatedAgo(Math.round((Date.now() - cur.contentAt) / 1000));
      } finally {
        cur.busy = false;
      }
    };
    const loop = async () => {
      try { await tick(); } catch { /* keep polling */ }
      if (alive) timer = setTimeout(loop, POLL_MS);
    };
    const onVisible = () => { if (!document.hidden) tick(); };
    loop();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [offline, show]);

  const unlock = async (e) => {
    e.preventDefault();
    const st = s.current.state;
    if (!st || !pw) return;
    setPhase("unlocking");
    try {
      const key = await deriveKey(pw, st.salt);
      const text = await decrypt(key, st);
      s.current.key = { kid: st.kid, key };
      s.current.hadKey = true;
      idbPut(s.current.key);
      setPw("");
      setHtml(render(text));
      setPhase("live");
    } catch {
      setPhase("wrong");
    }
  };

  // Copies the document formatted (HTML, for Word and the like) with plain text alongside for
  // places that only take text; neither carries markdown syntax.
  const copyAll = async () => {
    const doc = document.querySelector(".gateway-doc");
    if (!doc) return;
    const range = document.createRange();
    range.selectNodeContents(doc);
    const blob = (text, type) => new Blob([text], { type });
    try {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": blob(clipHtml(range.cloneContents()), "text/html"),
          "text/plain": blob(doc.innerText, "text/plain"),
        })]);
      } catch {
        await navigator.clipboard.writeText(doc.innerText); // no rich clipboard here: text at least
      }
    } catch {
      getSelection().removeAllRanges(); // no clipboard access: select it for Ctrl+C instead
      getSelection().addRange(range);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const lock = () => {
    s.current.key = null;
    s.current.hadKey = false;
    idbClear();
    setHtml("");
    setPhase(s.current.state ? "locked" : "offline");
  };

  if (phase === "loading") return <p className="prose">Connecting…</p>;
  if (phase === "offline") {
    return (
      <div className="gateway-offline">
        <span className="gateway-dot off" aria-hidden="true" />
        <div>
          <p className="gateway-title">Not live right now</p>
          <p className="prose scratch-hint">Page offline. Check back later.</p>
        </div>
      </div>
    );
  }
  if (phase === "live") {
    return (
      <>
        <div className="gateway-bar">
          <span className="gateway-chip"><span className="gateway-dot on" aria-hidden="true" />Live{updatedAgo != null ? ` · updated ${updatedAgo < 2 ? "just now" : `${updatedAgo}s ago`}` : ""}</span>
          <span className="gateway-actions">
            <button type="button" className="gateway-lock" onClick={copyAll}>{copied ? "Copied" : "Copy all"}</button>
            <button type="button" className="gateway-lock" onClick={lock}>Lock</button>
          </span>
        </div>
        <LiveDoc html={html} />
      </>
    );
  }
  const note = {
    locked: "This page is password protected.",
    unlocking: "Unlocking…",
    wrong: "That password didn't work. Try again.",
    changed: "The password has changed. Enter the new one to keep reading.",
  }[phase];
  return (
    <form className="gateway-unlock" onSubmit={unlock}>
      <span className="gateway-chip"><span className="gateway-dot on" aria-hidden="true" />Live</span>
      <p className={`prose${phase === "wrong" ? " gateway-err" : ""}`}>{note}</p>
      <div className="gateway-row">
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-label="Password"
          autoComplete="off" spellCheck={false} disabled={phase === "unlocking"} />
        <button type="submit" className="gateway-go" disabled={phase === "unlocking" || !pw}>Unlock</button>
      </div>
    </form>
  );
}
