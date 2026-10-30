import { useEffect, useMemo, useRef, useState } from "react";
import { api, forgetPassword, host, restoreAccess, unlockWithPassword } from "./search-api.js";
import "./search.css";

// Advanced Exa search (/search/advanced/): every option Exa's search and Agent APIs take, plus
// the exact request JSON. The simple Google-style page is /search/ (SimpleSearch.jsx); both share
// access and the API wrapper in search-api.js.

const TYPES = [
  { id: "lite", label: "Lite", note: "Fastest and cheapest, straight from Exa's index. No live fetch or synthesis." },
  { id: "auto", label: "Auto", note: "Balanced quality and speed. Exa's default." },
  { id: "deep", label: "Deep", note: "Multi-step research with a synthesized answer. Slower." },
  { id: "agent", label: "Agent", note: "An autonomous research run (Agent API). Takes minutes; polls until done." },
];
const DEEP_VARIANTS = [["deep", "Deep"], ["deep-lite", "Deep lite (≈4 s)"], ["deep-reasoning", "Deep reasoning (legacy)"]];
const CATEGORIES = ["", "company", "people", "news", "publication", "personal site", "financial report"];
const SECTIONS = ["header", "navigation", "banner", "body", "sidebar", "footer", "metadata"];
const EFFORTS = ["auto", "minimal", "low", "medium", "high", "xhigh", "ultra"];
const DEFAULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    answer: { type: "string", description: "Direct answer to the query" },
    key_points: { type: "array", items: { type: "string" }, description: "Most important supporting facts" },
  },
  required: ["answer"],
}, null, 2);
// Fields Exa's "lite" type accepts (anything else is rejected with a 400).
const LITE_CONTENT = ["highlights", "text", "snapshotAsOf"];

const INITIAL = {
  mode: "auto", deepVariant: "deep", query: "", numResults: 10, objective: "", systemPrompt: "",
  structured: true, schemaText: DEFAULT_SCHEMA,
  category: "", includeDomains: "", excludeDomains: "", startPublished: "", endPublished: "",
  includeText: "", excludeText: "", country: "", lat: "", lon: "", moderation: false, additionalQueries: "",
  text: false, textMax: "", textVerbosity: "", textHtml: false, textInclude: [], textExclude: [],
  highlights: true, hlQuery: "", hlMax: "", hlVerbosity: "", hlDynamic: false,
  summary: false, sumQuery: "", sumSchemaOn: false, sumSchemaText: "",
  links: "", imageLinks: "", richImageLinks: "", maxAgeHours: "", livecrawlTimeout: "", snapshotAsOf: "",
  effort: "auto", maxCost: "", maxDuration: "", inputData: "", exclusion: "", previousRunId: "", dataSources: "",
};

const lines = (s) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const num = (s) => (s === "" || s == null ? undefined : Number(s));
function parseJson(text, label, problems) {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch (e) { problems.push(`${label}: ${e.message}`); return undefined; }
}
const prune = (o) => {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete o[k];
    else if (v && typeof v === "object" && !Array.isArray(v)) { prune(v); if (!Object.keys(v).length) delete o[k]; }
  }
  return o;
};
const isoDay = (d, end) => (d ? `${d}T${end ? "23:59:59.999" : "00:00:00.000"}Z` : undefined);

// -> { kind: "search" | "agent", request, problems: [] }
function buildRequest(o) {
  const problems = [];
  const schema = o.structured ? parseJson(o.schemaText, "Output schema", problems) : undefined;
  if (o.mode === "agent") {
    const data = parseJson(o.inputData, "Input data", problems);
    const exclusion = parseJson(o.exclusion, "Exclusions", problems);
    for (const [v, label] of [[data, "Input data"], [exclusion, "Exclusions"]]) {
      if (v !== undefined && !Array.isArray(v)) problems.push(`${label} must be a JSON array of objects`);
    }
    return {
      kind: "agent", problems, request: prune({
        query: o.query.trim(), systemPrompt: o.systemPrompt.trim(), effort: o.effort, outputSchema: schema,
        input: { data, exclusion }, previousRunId: o.previousRunId.trim(),
        dataSources: lines(o.dataSources).map((provider) => ({ provider })),
        budget: { maxCostDollars: num(o.maxCost), maxDurationSeconds: num(o.maxDuration) },
      }),
    };
  }
  const lite = o.mode === "lite";
  const loc = o.lat !== "" && o.lon !== ""
    ? prune({ country: o.country.trim().toUpperCase() || undefined, latitude: num(o.lat), longitude: num(o.lon) })
    : o.country.trim() ? o.country.trim().toUpperCase() : undefined;
  const text = o.text ? (o.textMax || o.textVerbosity || o.textHtml || o.textInclude.length || o.textExclude.length
    ? prune({ maxCharacters: num(o.textMax), verbosity: o.textVerbosity, includeHtmlTags: o.textHtml || undefined,
      includeSections: o.textInclude, excludeSections: o.textExclude })
    : true) : undefined;
  const hl = o.highlights ? (o.hlQuery || o.hlMax || o.hlVerbosity || o.hlDynamic
    ? prune({ query: o.hlQuery, maxCharacters: o.hlDynamic || o.hlVerbosity ? undefined : num(o.hlMax),
      verbosity: o.hlVerbosity, dynamic: o.hlDynamic || undefined })
    : true) : undefined;
  if (o.highlights && (o.hlDynamic || o.hlVerbosity) && o.hlMax) problems.push("Highlights: max characters can't be combined with verbosity or dynamic");
  const summary = o.summary ? prune({ query: o.sumQuery, schema: o.sumSchemaOn ? parseJson(o.sumSchemaText, "Summary schema", problems) : undefined }) : undefined;
  let contents = {
    text, highlights: hl, summary: summary && !Object.keys(summary).length ? {} : summary,
    extras: { links: num(o.links), imageLinks: num(o.imageLinks), richImageLinks: num(o.richImageLinks) },
    maxAgeHours: num(o.maxAgeHours), livecrawlTimeout: num(o.livecrawlTimeout), snapshotAsOf: o.snapshotAsOf || undefined,
  };
  if (o.summary && contents.summary && !Object.keys(contents.summary).length) contents.summary = true;
  if (lite) contents = Object.fromEntries(Object.entries(contents).filter(([k]) => LITE_CONTENT.includes(k)));
  const request = prune({
    query: o.query.trim(),
    type: o.mode === "deep" ? o.deepVariant : o.mode,
    numResults: num(o.numResults),
    objective: o.objective.trim(),
    category: o.category,
    includeDomains: lines(o.includeDomains), excludeDomains: lines(o.excludeDomains),
    startPublishedDate: isoDay(o.startPublished), endPublishedDate: isoDay(o.endPublished, true),
    userLocation: loc,
    moderation: o.moderation || undefined,
    contents,
    ...(lite ? {} : {
      systemPrompt: o.systemPrompt.trim(), outputSchema: schema,
      includeText: lines(o.includeText), excludeText: lines(o.excludeText),
      additionalQueries: o.mode === "deep" ? lines(o.additionalQueries).slice(0, 10) : undefined,
    }),
  });
  if (o.mode === "deep" && lines(o.additionalQueries).length > 10) problems.push("Deep allows at most 10 additional queries");
  return { kind: "search", request, problems };
}

function Lock({ onUnlock, notice }) {
  const [pw, setPw] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr("");
    try {
      const { key, who } = await unlockWithPassword(pw, remember);
      setPw("");
      onUnlock(key, who);
    } catch (x) {
      setErr(x.message || "Couldn't unlock.");
    } finally { setBusy(false); }
  }
  return (
    <form className="sx-card sx-lock" onSubmit={submit}>
      <h1>Search</h1>
      <p className="sx-muted">Exa web search. Enter the password to continue.</p>
      {notice && <p className="sx-note">{notice}</p>}
      <input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={pw}
        onChange={(e) => setPw(e.target.value)} aria-label="Password" />
      <label className="sx-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
      <button className="sx-primary" type="submit" disabled={busy || !pw}>{busy ? "Checking…" : "Unlock"}</button>
      {err && <p className="sx-err" role="alert">{err}</p>}
    </form>
  );
}

function Field({ label, hint, children, wide }) {
  return (
    <label className={`sx-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Section({ title, note, children, open }) {
  return (
    <details className="sx-group" open={open}>
      <summary>{title}{note && <span className="sx-muted"> · {note}</span>}</summary>
      <div className="sx-grid">{children}</div>
    </details>
  );
}

function JsonBlock({ value }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div className="sx-json">
      <button type="button" className="sx-mini" onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

function Grounding({ items }) {
  if (!items || !items.length) return null;
  return (
    <div className="sx-grounding">
      <h3>Citations</h3>
      <ul>
        {items.map((g, i) => (
          <li key={i}>
            <code>{g.field || "answer"}</code>{g.confidence && <span className={`sx-conf ${g.confidence}`}>{g.confidence}</span>}
            {(g.citations || []).map((c, j) => <a key={j} href={c.url} target="_blank" rel="noreferrer">{c.title || host(c.url)}</a>)}
          </li>
        ))}
      </ul>
    </div>
  );
}

const money = (c) => (c && typeof c.total === "number" ? `$${c.total.toFixed(4)}` : null);

function ResultCard({ r, i }) {
  return (
    <article className="sx-result">
      <div className="sx-result-head">
        <span className="sx-rank">{i + 1}</span>
        {r.favicon && <img src={r.favicon} alt="" width="16" height="16" loading="lazy" referrerPolicy="no-referrer" />}
        <a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url}</a>
      </div>
      <div className="sx-meta">{host(r.url)}{r.publishedDate && ` · ${r.publishedDate.slice(0, 10)}`}{r.author && ` · ${r.author}`}</div>
      {r.summary && <p className="sx-summary">{typeof r.summary === "string" ? r.summary : JSON.stringify(r.summary)}</p>}
      {r.highlights && r.highlights.length > 0 && (
        <ul className="sx-highlights">{r.highlights.map((h, k) => <li key={k}>{h}</li>)}</ul>
      )}
      {r.text && <details className="sx-text"><summary>Full text ({r.text.length.toLocaleString()} chars)</summary><pre>{r.text}</pre></details>}
      {r.extras && Object.entries(r.extras).some(([, v]) => v && v.length) && (
        <details className="sx-text"><summary>Extras</summary><JsonBlock value={r.extras} /></details>
      )}
    </article>
  );
}

function Output({ output }) {
  if (!output) return null;
  const content = "content" in output ? output.content : output.structured ?? output.text;
  return (
    <section className="sx-card sx-output">
      <h2>Answer</h2>
      {output.text && output.structured != null && <p className="sx-answer-text">{output.text}</p>}
      {content != null && (typeof content === "string" ? <p className="sx-answer-text">{content}</p> : <JsonBlock value={content} />)}
      <Grounding items={output.grounding} />
    </section>
  );
}

function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SearchPage() {
  const [key, setKey] = useState(null);
  const [who, setWho] = useState(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState("");
  const [o, setO] = useState(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState(null); // { kind, request, doc, ms }
  const [run, setRun] = useState(null); // agent run object while polling
  const poll = useRef(0);
  const set = (k) => (e) => setO((p) => ({ ...p, [k]: e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e }));

  useEffect(() => {
    restoreAccess().then((r) => {
      if (r.key) { setKey(r.key); setWho(r.who); } else setNotice(r.notice);
      setChecking(false);
    });
    return () => clearTimeout(poll.current);
  }, []);

  const role = who?.role;
  const lim = who?.limits || {};
  const ownerOnly = role !== "device";
  const built = useMemo(() => buildRequest(o), [o]);

  function lock() {
    forgetPassword();
    clearTimeout(poll.current);
    setKey(null); setWho(null); setRes(null); setRun(null);
  }

  async function refreshWho() {
    const { code, doc } = await api("whoami", {}, key);
    if (code === 200) setWho(doc);
  }

  async function pollRun(id, request, t0) {
    const { code, doc } = await api("run", { id }, key);
    if (code !== 200) { setError(doc.error || `HTTP ${code}`); setBusy(false); return; }
    const r = doc.exa;
    setRun(r);
    if (["completed", "failed", "cancelled"].includes(r.status)) {
      setRes({ kind: "agent", request, doc: r, ms: Date.now() - t0 });
      setBusy(false);
      refreshWho();
      return;
    }
    poll.current = setTimeout(() => pollRun(id, request, t0), 3000);
  }

  async function go(e) {
    e?.preventDefault();
    if (busy || !o.query.trim()) return;
    if (built.problems.length) { setError(built.problems.join(" · ")); return; }
    setBusy(true); setError(""); setRes(null); setRun(null);
    clearTimeout(poll.current);
    const t0 = Date.now();
    const { code, doc } = await api(built.kind, { request: built.request }, key);
    if (code === 401) { setBusy(false); lock(); setNotice("Your access was revoked or the password changed."); return; }
    if (code !== 200) { setBusy(false); setError(doc.error || `HTTP ${code}`); return; }
    if (built.kind === "agent") { setRun(doc.exa); pollRun(doc.exa.id, built.request, t0); return; }
    setRes({ kind: "search", request: built.request, doc: doc.exa, ms: Date.now() - t0 });
    setBusy(false);
    refreshWho();
  }

  if (checking) return <div className="sx-wrap"><p className="sx-muted sx-center">Checking access…</p></div>;
  if (!key) {
    return (
      <div className="sx-wrap">
        <SiteBar />
        <Lock notice={notice} onUnlock={(t, d) => { setKey(t); setWho(d); setNotice(""); }} />
      </div>
    );
  }

  const mode = o.mode, lite = mode === "lite", agent = mode === "agent";
  const doc = res?.doc;
  return (
    <div className="sx-wrap">
      <SiteBar>
        <span className={`sx-badge ${role}`}>{role === "device" ? "This PC (owner)" : "Shared password"}</span>
        {lim.dailyCapUsd != null && who?.spent_today != null && (
          <span className="sx-muted">today ${who.spent_today.toFixed(2)} / ${lim.dailyCapUsd}</span>
        )}
        {role !== "device" && <button type="button" className="sx-mini" onClick={lock}>Lock</button>}
      </SiteBar>
      {who && who.exa_ready === false && <p className="sx-note">The Exa API key isn't configured yet, so searches will fail until it is (infra/search_setup.py exa-key).</p>}

      <form className="sx-card sx-main" onSubmit={go} autoComplete="off">
        <div className="sx-querybar">
          <textarea value={o.query} onChange={set("query")} rows={2} placeholder={agent ? "Describe the research task…" : "Search the web…"}
            aria-label="Query" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) go(e); }} />
          <button className="sx-primary" type="submit" disabled={busy || !o.query.trim()}>{busy ? (agent ? "Running…" : "Searching…") : agent ? "Run agent" : "Search"}</button>
        </div>

        <div className="sx-types" role="radiogroup" aria-label="Search type">
          {TYPES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={mode === t.id} className={mode === t.id ? "on" : ""} onClick={() => set("mode")(t.id)}>
              <b>{t.label}</b><small>{t.note}</small>
            </button>
          ))}
        </div>

        <div className="sx-grid sx-output-opts">
          {mode === "deep" && (
            <Field label="Deep variant">
              <select value={o.deepVariant} onChange={set("deepVariant")}>{DEEP_VARIANTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
          )}
          {!agent && (
            <Field label="Number of results" hint={`1–${lim.maxResults || 100}`}>
              <input type="number" min="1" max={lim.maxResults || 100} value={o.numResults} onChange={set("numResults")} />
            </Field>
          )}
          {!agent && (
            <Field label="Guiding query" hint="The broader goal behind the query (objective)" wide>
              <input value={o.objective} onChange={set("objective")} placeholder="e.g. compare pricing for a small team" />
            </Field>
          )}
          <label className={`sx-toggle${lite ? " off" : ""}`}>
            <input type="checkbox" checked={o.structured && !lite} disabled={lite} onChange={set("structured")} />
            <span><b>Structured output (JSON)</b><small>{lite ? "Not available with Lite" : "Exa synthesizes an answer matching the schema"}</small></span>
          </label>
          {!lite && (
            <Field label="System prompt" hint="Guidance for the answer or agent: sources to prefer, style, what to avoid" wide>
              <textarea rows={2} value={o.systemPrompt} onChange={set("systemPrompt")} />
            </Field>
          )}
          {o.structured && !lite && (
            <Field label="Output schema (JSON Schema)" hint={agent ? "Returned as output.structured" : "Root type object (≤10 properties, 2 levels) or {\"type\":\"text\"}"} wide>
              <textarea className="sx-code" rows={8} value={o.schemaText} onChange={set("schemaText")} spellCheck={false} />
            </Field>
          )}
        </div>

        {!agent && (
          <Section title="Filters" note="category, domains, dates, text, location">
            <Field label="Category">
              <select value={o.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{c || "Any"}</option>)}</select>
            </Field>
            <Field label="Published after"><input type="date" value={o.startPublished} onChange={set("startPublished")} /></Field>
            <Field label="Published before"><input type="date" value={o.endPublished} onChange={set("endPublished")} /></Field>
            <Field label="Include domains" hint="One per line: example.com, example.com/blog, *.example.com" wide>
              <textarea rows={2} value={o.includeDomains} onChange={set("includeDomains")} />
            </Field>
            <Field label="Exclude domains" hint="Same formats" wide>
              <textarea rows={2} value={o.excludeDomains} onChange={set("excludeDomains")} />
            </Field>
            {!lite && <Field label="Must include text" hint="Phrases, one per line" wide><textarea rows={2} value={o.includeText} onChange={set("includeText")} /></Field>}
            {!lite && <Field label="Must exclude text" hint="Phrases, one per line" wide><textarea rows={2} value={o.excludeText} onChange={set("excludeText")} /></Field>}
            <Field label="Country" hint="2-letter code, e.g. US"><input value={o.country} maxLength={2} onChange={set("country")} /></Field>
            <Field label="Latitude"><input type="number" step="any" value={o.lat} onChange={set("lat")} /></Field>
            <Field label="Longitude"><input type="number" step="any" value={o.lon} onChange={set("lon")} /></Field>
            <label className="sx-check"><input type="checkbox" checked={o.moderation} onChange={set("moderation")} /> Filter unsafe content (moderation)</label>
            {o.category === "people" && <p className="sx-hint wide">People search doesn't support date filters or excluded domains.</p>}
            {o.category === "company" && <p className="sx-hint wide">Company search doesn't support date filters.</p>}
          </Section>
        )}

        {!agent && (
          <Section title="Page contents" note="text, highlights, summary, extras">
            <label className="sx-check wide"><input type="checkbox" checked={o.highlights} onChange={set("highlights")} /> <b>Highlights</b> (query-relevant excerpts)</label>
            {o.highlights && <>
              <Field label="Highlights query" hint="Defaults to the search query"><input value={o.hlQuery} onChange={set("hlQuery")} /></Field>
              <Field label="Max characters"><input type="number" min="1" value={o.hlMax} onChange={set("hlMax")} disabled={o.hlDynamic || !!o.hlVerbosity} /></Field>
              <Field label="Verbosity" hint="Beta"><select value={o.hlVerbosity} onChange={set("hlVerbosity")}><option value="">Default</option><option>low</option><option>medium</option><option>high</option></select></Field>
              <label className="sx-check"><input type="checkbox" checked={o.hlDynamic} onChange={set("hlDynamic")} /> Dynamic budget across results (beta)</label>
            </>}
            <label className="sx-check wide"><input type="checkbox" checked={o.text} onChange={set("text")} /> <b>Full text</b></label>
            {o.text && <>
              <Field label="Max characters"><input type="number" min="1" value={o.textMax} onChange={set("textMax")} /></Field>
              <Field label="Verbosity"><select value={o.textVerbosity} onChange={set("textVerbosity")}><option value="">Default (compact)</option><option>compact</option><option>standard</option><option>full</option></select></Field>
              <label className="sx-check"><input type="checkbox" checked={o.textHtml} onChange={set("textHtml")} /> Keep HTML tags</label>
              <Field label="Only sections" wide><SectionPicker value={o.textInclude} onChange={set("textInclude")} /></Field>
              <Field label="Skip sections" wide><SectionPicker value={o.textExclude} onChange={set("textExclude")} /></Field>
            </>}
            {!lite && <>
              <label className="sx-check wide"><input type="checkbox" checked={o.summary} onChange={set("summary")} /> <b>Per-result summary</b></label>
              {o.summary && <>
                <Field label="Summary query" wide><input value={o.sumQuery} onChange={set("sumQuery")} /></Field>
                <label className="sx-check"><input type="checkbox" checked={o.sumSchemaOn} onChange={set("sumSchemaOn")} /> Structured summary</label>
                {o.sumSchemaOn && <Field label="Summary schema" wide><textarea className="sx-code" rows={5} value={o.sumSchemaText} onChange={set("sumSchemaText")} spellCheck={false} /></Field>}
              </>}
              <Field label="Links per page"><input type="number" min="0" max="1000" value={o.links} onChange={set("links")} /></Field>
              <Field label="Image links"><input type="number" min="0" max="1000" value={o.imageLinks} onChange={set("imageLinks")} /></Field>
              <Field label="Rich image links"><input type="number" min="0" max="1000" value={o.richImageLinks} onChange={set("richImageLinks")} /></Field>
            </>}
          </Section>
        )}

        {!agent && (
          <Section title="Freshness" note="cache age, live crawl, snapshots">
            {!lite && <Field label="Max cache age (hours)" hint="0 = always fetch live, -1 = cache only, up to 720"><input type="number" min="-1" max="720" value={o.maxAgeHours} onChange={set("maxAgeHours")} /></Field>}
            {!lite && <Field label="Live crawl timeout (ms)" hint="Up to 90000"><input type="number" min="1" max="90000" value={o.livecrawlTimeout} onChange={set("livecrawlTimeout")} /></Field>}
            <Field label="Snapshot as of" hint="Serve stored versions from this date"><input type="date" value={o.snapshotAsOf} onChange={set("snapshotAsOf")} /></Field>
          </Section>
        )}

        {mode === "deep" && (
          <Section title="Deep search" note="extra queries" open>
            <Field label="Additional queries" hint="Up to 10, one per line: angles the research should also cover" wide>
              <textarea rows={3} value={o.additionalQueries} onChange={set("additionalQueries")} />
            </Field>
          </Section>
        )}

        {agent && (
          <Section title="Agent run" note={ownerOnly ? "shared password: effort auto, budget ≤ $" + (lim.agentMaxCost ?? 2) : "effort, budget, inputs"} open>
            <Field label="Effort">
              <select value={ownerOnly ? "auto" : o.effort} onChange={set("effort")} disabled={ownerOnly}>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select>
            </Field>
            <Field label="Max cost (USD)" hint={ownerOnly ? `Up to $${lim.agentMaxCost ?? 2}` : "$1–$100; auto/ultra only"}>
              <input type="number" min="1" max={ownerOnly ? lim.agentMaxCost ?? 2 : 100} step="0.5" value={o.maxCost} onChange={set("maxCost")} />
            </Field>
            {!ownerOnly && <Field label="Max duration (s)" hint="300–10800; ultra only"><input type="number" min="300" max="10800" value={o.maxDuration} onChange={set("maxDuration")} /></Field>}
            <Field label="Previous run id" hint="Continue from a completed run"><input value={o.previousRunId} onChange={set("previousRunId")} /></Field>
            <Field label="Data sources" hint="Provider names, e.g. fiber, financial_datasets"><input value={o.dataSources} onChange={set("dataSources")} /></Field>
            <Field label="Input data" hint="JSON array of records to process or enrich" wide><textarea className="sx-code" rows={3} value={o.inputData} onChange={set("inputData")} spellCheck={false} /></Field>
            <Field label="Exclusions" hint="JSON array of records to leave out" wide><textarea className="sx-code" rows={3} value={o.exclusion} onChange={set("exclusion")} spellCheck={false} /></Field>
          </Section>
        )}

        <details className="sx-group">
          <summary>Request JSON <span className="sx-muted">· exactly what's sent to Exa ({built.kind === "agent" ? "POST /agent/runs" : "POST /search"})</span></summary>
          {built.problems.length > 0 && <p className="sx-err">{built.problems.join(" · ")}</p>}
          <JsonBlock value={built.request} />
        </details>
      </form>

      {error && <p className="sx-err sx-card" role="alert">{error}</p>}

      {run && busy && (
        <section className="sx-card sx-run">
          <span className="sx-spin" aria-hidden="true" /> Agent run <code>{run.id}</code>: <b>{run.status}</b>. Checking every 3 s; this can take several minutes.
        </section>
      )}

      {doc && (
        <>
          <div className="sx-statline">
            {res.kind === "agent"
              ? <>Agent <b>{doc.status}</b>{doc.stopReason && ` (${doc.stopReason})`} · {(res.ms / 1000).toFixed(1)} s</>
              : <>{(doc.results || []).length} results · {(res.ms / 1000).toFixed(1)} s</>}
            {money(doc.costDollars) && <> · {money(doc.costDollars)}</>}
            {(doc.requestId || doc.id) && <> · <code>{doc.requestId || doc.id}</code></>}
            <span className="sx-grow" />
            <button type="button" className="sx-mini" onClick={() => download(`exa-${res.kind}-${Date.now()}.json`, { request: res.request, response: doc })}>Download JSON</button>
          </div>
          {(doc.warnings || []).length > 0 && <p className="sx-note">{doc.warnings.map((w) => (typeof w === "string" ? w : w.message || JSON.stringify(w))).join(" · ")}</p>}
          <Output output={doc.output} />
          {res.kind === "search" && (doc.results || []).map((r, i) => <ResultCard key={r.id || r.url || i} r={r} i={i} />)}
          <details className="sx-group sx-card"><summary>Raw response</summary><JsonBlock value={doc} /></details>
        </>
      )}
    </div>
  );
}

function SectionPicker({ value, onChange }) {
  const toggle = (s) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  return (
    <div className="sx-chips">
      {SECTIONS.map((s) => <button type="button" key={s} className={value.includes(s) ? "on" : ""} onClick={() => toggle(s)}>{s}</button>)}
    </div>
  );
}

function SiteBar({ children }) {
  return (
    <header className="sx-sitebar">
      <a className="who" href="/">Preet Patel</a>
      <span className="sx-title">Advanced search</span>
      <a className="sx-mini" href="/search/">Simple search</a>
      <span className="sx-grow" />
      {children}
    </header>
  );
}
