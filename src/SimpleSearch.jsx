import { useEffect, useId, useRef, useState } from "react";
import { api, forgetPassword, host, restoreAccess, unlockWithPassword } from "./search-api.js";
import "./search.css";
import "./search-simple.css";

// Simple Exa search (/search/), laid out like the old Google home page: logo, one box, two buttons.
// "Search" is an Exa auto search with highlights; "Get an answer" is deep-lite with a plain-text
// answer. Everything else lives on /search/advanced/. The query sits in the URL hash (#q=…), so the
// back button and bookmarks work and the query never reaches the server's access logs.
const TABS = [["", "All"], ["news", "News"], ["publication", "Papers"], ["company", "Companies"], ["people", "People"]];

function buildRequest({ q, cat, answer }) {
  const req = { query: q, type: answer ? "deep-lite" : "auto", numResults: 10, contents: { highlights: true } };
  if (cat) req.category = cat;
  if (answer) {
    req.outputSchema = { type: "text" };
    req.systemPrompt = "Answer in a few plain sentences a non-expert can follow. Lead with the direct answer.";
  }
  return req;
}

const readHash = () => {
  const p = new URLSearchParams(location.hash.slice(1));
  return { q: (p.get("q") || "").trim(), cat: p.get("cat") || "", answer: p.get("a") === "1" };
};
const hashFor = ({ q, cat, answer }) => {
  const p = new URLSearchParams({ q });
  if (cat) p.set("cat", cat);
  if (answer) p.set("a", "1");
  return "#" + p.toString();
};

// Exa's logo (exa.ai/images/logo/exa-logo-blue.svg), recoloured to this site's palette.
function ExaLogo({ className }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="0 0 413 129" role="img" aria-label="Exa">
      <defs>
        <linearGradient id={`m${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe2c2" />
          <stop offset="1" stopColor="#ff9a4d" />
        </linearGradient>
      </defs>
      <path fill={`url(#m${id})`} fillRule="evenodd" d="M106.417 9.30741C106.417 9.57392 106.324 9.83227 106.155 10.0388L61.5395 64.5L106.155 118.96C106.324 119.166 106.417 119.425 106.417 119.691V127.843C106.417 128.482 105.897 129 105.255 129H1.16175C0.520132 129 0 128.482 0 127.843V1.15695C0 0.517982 0.520131 0 1.16174 0H105.255C105.897 0 106.417 0.517984 106.417 1.15695V9.30741ZM19.0364 116.382H87.6921L53.363 74.4795L19.0364 116.382ZM12.6699 104.192L40.1426 70.6585H12.6699V104.192ZM12.6699 58.0409H39.8964L12.6699 24.8064V58.0409ZM53.363 54.5193L87.6921 12.6176H19.0364L53.363 54.5193Z" />
      <path fill="#fff2e6" d="M176.198 117.65C166.094 117.65 157.323 115.553 149.886 111.36C142.589 107.167 136.905 101.017 132.835 92.9109C128.906 84.8045 126.941 75.0208 126.941 63.5599C126.941 53.3569 128.976 44.2022 133.046 36.0957C137.256 27.9892 143.01 21.6298 150.307 17.0175C157.744 12.4052 166.024 10.099 175.146 10.099C185.109 10.099 193.599 12.3353 200.616 16.8078C207.633 21.1406 212.965 27.3602 216.614 35.4667C220.263 43.4334 222.087 52.8677 222.087 63.7695V66.1766C222.087 66.8156 221.567 67.3336 220.925 67.3336H145.044C145.185 74.881 146.588 81.3802 149.254 86.8311C152.061 92.282 155.78 96.475 160.411 99.4101C165.182 102.205 170.515 103.603 176.409 103.603C183.285 103.603 189.179 102.066 194.091 98.9908C198.779 95.9225 201.741 91.008 202.977 84.2471C203.08 83.6853 203.565 83.267 204.139 83.267H219.737C220.429 83.267 220.969 83.8669 220.871 84.5494C220.038 90.3376 217.988 95.6406 214.72 100.458C211.211 105.63 206.159 109.823 199.564 113.037C193.108 116.112 185.32 117.65 176.198 117.65ZM202.721 54.5449C202.721 45.3203 200.265 37.9825 195.354 32.5316C190.582 27.0807 183.846 24.3552 175.146 24.3552C166.866 24.3552 160.06 27.2205 154.727 32.9509C149.395 38.6814 146.377 45.8794 145.676 54.5449H202.721Z" />
      <path fill="#ffb36b" d="M285.673 62.9573L325.127 112.948C325.726 113.707 325.183 114.82 324.213 114.82H305.929C305.572 114.82 305.235 114.657 305.015 114.378L275.053 76.414L245.093 114.378C244.872 114.657 244.536 114.82 244.179 114.82H225.893C224.924 114.82 224.381 113.707 224.98 112.948L264.433 62.9573L227.177 15.7512C226.578 14.9921 227.121 13.8793 228.091 13.8793H246.375C246.732 13.8793 247.068 14.0423 247.289 14.3214L275.053 49.5006L302.818 14.3214C303.038 14.0423 303.375 13.8793 303.731 13.8793H322.016C322.985 13.8793 323.528 14.9921 322.929 15.7512L285.673 62.9573Z" />
      <path fill="#fff2e6" d="M364.585 117.65C358.13 117.65 352.236 116.392 346.903 113.876C341.571 111.36 337.361 107.796 334.273 103.184C331.186 98.4317 329.642 92.9808 329.642 86.8311C329.642 77.7462 332.73 70.688 338.904 65.6564C345.219 60.485 353.359 57.0607 363.322 55.3835L385.004 52.0291C387.67 51.6098 389.705 51.0507 391.108 50.3519C392.652 49.5133 393.704 48.465 394.266 47.2071C394.967 45.8095 395.318 44.0624 395.318 41.9659C395.318 36.515 393.424 32.2521 389.635 29.1772C385.846 25.9626 380.934 24.3552 374.9 24.3552C367.322 24.3552 361.498 26.2421 357.428 30.0158C353.595 33.4387 351.443 38.1016 350.971 44.0046C350.922 44.622 350.412 45.1106 349.79 45.1106H334.014C333.353 45.1106 332.823 44.5605 332.872 43.9032C333.312 38.0771 335.042 32.6792 338.062 27.7096C341.29 22.3985 345.921 18.1356 351.955 14.921C358.13 11.7063 365.287 10.099 373.426 10.099C381.706 10.099 388.793 11.6364 394.687 14.7113C400.721 17.7862 405.282 22.1888 408.369 27.9193C411.456 33.6497 413 40.4284 413 48.2554V113.348C413 113.987 412.48 114.505 411.838 114.505H396.901C396.259 114.505 395.739 113.987 395.739 113.348V109.473C395.739 108.076 395.739 106.678 395.739 105.28C395.739 103.743 395.739 102.275 395.739 100.878C393.213 106.189 389.214 110.312 383.741 113.247C378.408 116.182 372.023 117.65 364.585 117.65ZM367.111 103.603C372.444 103.603 377.215 102.485 381.425 100.249C385.775 97.8727 389.143 94.6581 391.529 90.6048C394.055 86.4118 395.318 81.6597 395.318 76.3486V61.4634C394.757 62.302 393.564 63.0707 391.74 63.7695C389.915 64.4684 387.389 65.1672 384.162 65.866L369.427 68.5915C362.971 69.8494 357.849 71.9459 354.06 74.881C350.271 77.8161 348.377 81.7995 348.377 86.8311C348.377 91.8627 350.131 95.916 353.639 98.9908C357.288 102.066 361.779 103.603 367.111 103.603Z" />
    </svg>
  );
}

function Tabs({ cat, onPick }) {
  return (
    <nav className="ss-tabs" aria-label="What to search">
      {TABS.map(([v, label]) => (
        <button key={v} type="button" className={cat === v ? "on" : ""} aria-pressed={cat === v} onClick={() => onPick(v)}>{label}</button>
      ))}
    </nav>
  );
}

function Lock({ notice, onUnlock }) {
  const [pw, setPw] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await unlockWithPassword(pw, remember);
      setPw("");
      onUnlock(r);
    } catch (x) {
      setErr(x.message || "Couldn't unlock.");
    } finally { setBusy(false); }
  }
  return (
    <form className="ss-home" onSubmit={submit}>
      <ExaLogo className="ss-logo" />
      <p className="ss-sub">Enter the password to search.</p>
      {notice && <p className="ss-note">{notice}</p>}
      <input className="ss-box" type="password" autoFocus autoComplete="current-password" placeholder="Password"
        aria-label="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <label className="ss-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me on this device</label>
      <div className="ss-buttons"><button type="submit" disabled={busy || !pw}>{busy ? "Checking…" : "Unlock"}</button></div>
      {err && <p className="ss-err" role="alert">{err}</p>}
    </form>
  );
}

function snippet(r) {
  const parts = (r.highlights || []).map((h) => h.replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = parts.length ? parts.join(" … ") : (r.text || r.summary || "").toString().replace(/\s+/g, " ").slice(0, 300);
  return text.length > 340 ? text.slice(0, 337).replace(/\s+\S*$/, "") + " …" : text;
}

function Result({ r }) {
  return (
    <article className="ss-result">
      <a className="ss-title" href={r.url} target="_blank" rel="noreferrer">{r.title || host(r.url)}</a>
      <div className="ss-url">
        {r.favicon && <img src={r.favicon} alt="" width="16" height="16" loading="lazy" referrerPolicy="no-referrer" />}
        <span>{r.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
      </div>
      <p className="ss-snippet">
        {r.publishedDate && <span className="ss-date">{new Date(r.publishedDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} — </span>}
        {snippet(r)}
      </p>
    </article>
  );
}

function Answer({ output }) {
  const text = typeof output?.content === "string" ? output.content : typeof output?.text === "string" ? output.text : null;
  if (!text) return null;
  const seen = new Set();
  const cites = (output.grounding || []).flatMap((g) => g.citations || []).filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
  return (
    <section className="ss-answer">
      <h2>Answer</h2>
      <p>{text}</p>
      {cites.length > 0 && (
        <p className="ss-cites">Sources: {cites.slice(0, 6).map((c, i) => (
          <span key={c.url}>{i ? ", " : ""}<a href={c.url} target="_blank" rel="noreferrer">{c.title || host(c.url)}</a></span>
        ))}</p>
      )}
    </section>
  );
}

export default function SimpleSearch() {
  const [checking, setChecking] = useState(true);
  const [key, setKey] = useState(null);
  const [who, setWho] = useState(null);
  const [notice, setNotice] = useState("");
  const [q, setQ] = useState(() => readHash().q);
  const [cat, setCat] = useState(() => readHash().cat);
  const [shown, setShown] = useState(null); // { q, cat, answer } of the results on screen
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState(null); // { doc, ms }
  const cache = useRef(new Map()); // hash -> { doc, ms }, so Back doesn't pay for the same search twice
  const seq = useRef(0);

  async function run(want, k = key) {
    if (!want.q || !k) return;
    const h = hashFor(want);
    setShown(want); setQ(want.q); setCat(want.cat); setError("");
    if (cache.current.has(h)) { setRes(cache.current.get(h)); setBusy(false); return; }
    const mine = ++seq.current;
    setBusy(true); setRes(null);
    const t0 = Date.now();
    const { code, doc } = await api("search", { request: buildRequest(want) }, k);
    if (mine !== seq.current) return;
    setBusy(false);
    if (code === 401) { forgetPassword(); setKey(null); setNotice("Your access was revoked or the password changed."); return; }
    if (code !== 200) { setError(doc.error || `Something went wrong (HTTP ${code}).`); return; }
    const got = { doc: doc.exa, ms: Date.now() - t0 };
    cache.current.set(h, got);
    setRes(got);
    api("whoami", {}, k).then((r) => r.code === 200 && setWho(r.doc));
  }

  function submit(want) {
    if (!want.q) return;
    const h = hashFor(want);
    if (location.hash !== h) history.pushState(null, "", location.pathname + location.search + h);
    run(want);
  }

  useEffect(() => {
    restoreAccess().then((r) => {
      setChecking(false);
      if (!r.key) { setNotice(r.notice); return; }
      setKey(r.key); setWho(r.who);
      const want = readHash();
      if (want.q) run(want, r.key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPop = () => {
      const want = readHash();
      if (!want.q) { setShown(null); setRes(null); setError(""); setQ(""); setCat(want.cat); return; }
      run(want);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  const footer = (
    <footer className="ss-foot">
      <a href="/search/advanced/">Advanced search</a>
      <span>·</span>
      <a href="/">Preet Patel</a>
      <span>·</span>
      <span>Powered by <a href="https://exa.ai" target="_blank" rel="noreferrer">Exa</a></span>
      {who && who.role !== "device" && who.limits?.dailyCapUsd != null && who.spent_today != null && (
        <><span>·</span><span>${who.spent_today.toFixed(2)} of ${who.limits.dailyCapUsd} used today</span></>
      )}
      {key && who?.role !== "device" && (
        <><span>·</span><button type="button" className="ss-link" onClick={() => { forgetPassword(); setKey(null); setWho(null); }}>Lock</button></>
      )}
    </footer>
  );

  if (checking) return <main className="ss-page"><p className="ss-sub ss-checking">Checking access…</p></main>;
  if (!key) return <main className="ss-page"><Lock notice={notice} onUnlock={(r) => { setKey(r.key); setWho(r.who); setNotice(""); }} />{footer}</main>;

  const notReady = who && who.exa_ready === false && (
    <p className="ss-note">Searching isn't switched on yet: the Exa API key still needs to be added.</p>
  );

  if (!shown) {
    return (
      <main className="ss-page">
        <form className="ss-home" onSubmit={(e) => { e.preventDefault(); submit({ q: q.trim(), cat, answer: false }); }}>
          <ExaLogo className="ss-logo" />
          <Tabs cat={cat} onPick={setCat} />
          <input className="ss-box" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Search the web" placeholder="Search the web" enterKeyHint="search" />
          <div className="ss-buttons">
            <button type="submit">Exa Search</button>
            <button type="button" onClick={() => submit({ q: q.trim(), cat, answer: true })}>Get an answer</button>
          </div>
          <p className="ss-sub"><b>Exa Search</b> lists pages. <b>Get an answer</b> reads them and writes a short answer with sources.</p>
          {notReady}
        </form>
        {footer}
      </main>
    );
  }

  const doc = res?.doc;
  const results = doc?.results || [];
  return (
    <main className="ss-page ss-results-page">
      <form className="ss-top" onSubmit={(e) => { e.preventDefault(); submit({ q: q.trim(), cat, answer: false }); }}>
        <a href="#" className="ss-home-link" aria-label="New search" onClick={(e) => {
          e.preventDefault(); history.pushState(null, "", location.pathname + location.search); setShown(null); setRes(null); setError(""); setQ("");
        }}><ExaLogo className="ss-logo small" /></a>
        <div className="ss-topbox">
          <input className="ss-box" type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the web" enterKeyHint="search" />
          <button type="submit">Search</button>
          <button type="button" onClick={() => submit({ q: q.trim(), cat, answer: true })}>Answer</button>
        </div>
      </form>
      <Tabs cat={cat} onPick={(v) => submit({ q: q.trim() || shown.q, cat: v, answer: shown.answer })} />
      <div className="ss-body">
        {notReady}
        {busy && <p className="ss-status"><span className="sx-spin" aria-hidden="true" /> {shown.answer ? "Reading pages and writing an answer…" : "Searching…"}</p>}
        {error && <p className="ss-err" role="alert">{error}</p>}
        {doc && <p className="ss-status">{results.length} {results.length === 1 ? "result" : "results"} ({(res.ms / 1000).toFixed(2)} seconds)</p>}
        {doc && <Answer output={doc.output} />}
        {results.map((r, i) => <Result key={r.id || r.url || i} r={r} />)}
        {doc && !results.length && <p className="ss-sub">No pages matched <b>{shown.q}</b>. Try fewer or different words.</p>}
      </div>
      {footer}
    </main>
  );
}
