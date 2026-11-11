import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./models-themes.css";
import "./models.css";
import { LOGOS } from "./models-logos.js";

const DATA_URL = "/projects/models/data/latest.json";
const THEME_KEY = "models-theme";
const TYPE_KEY = "models-type";
const THEMES = [["ember", "Ember"], ["walnut", "Walnut"], ["space", "Space"], ["8bit", "8-Bit"], ["paper", "Paper"], ["ink", "Ink"]];
const SERIF_THEMES = ["paper", "ink"];

// Marker shapes follow the agent dashboard's vocabulary: squares, diamonds and a cross, never rounded.
// In the table and the over-time chart, shape = where the number came from and colour = company.
// In the scatter each point is the company's own mark (models-logos.js) in the theme's ink colour; only the
// "best in each area" cards tint marks with the company colour.
const SHAPE = { third_party: "square", third_party_aggregator: "square", self_reported: "diamond", community: "cross", manual_entry: "dashed" };
const SHAPE_LABEL = {
  square: "Third-party measurement",
  diamond: "Self-reported by the lab",
  cross: "Community measurement",
  dashed: "Manual entry, unverified",
};
const PROV_LABEL = {
  third_party: "third-party",
  third_party_aggregator: "third-party, via an aggregator",
  self_reported: "self-reported",
  community: "community",
  manual_entry: "manual entry",
};

// A pref is a per-viewer convenience: storage may be blocked or throw, so every access is wrapped.
function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: keep the in-memory choice */ }
}
function initialTheme() {
  const saved = readPref(THEME_KEY);
  if (THEMES.some(([id]) => id === saved)) return saved;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "ink" : "paper";
}

// On a wide screen the filter and the summary cards start open; on a phone they start folded so the table is close.
const ROOMY = typeof window !== "undefined" && window.innerWidth >= 720;

const day = (s) => s.slice(0, 10);
const fmtScore = (v) => v.toFixed(1);
const fmtPrice = (v) => `$${v >= 10 ? v.toFixed(0) : v.toFixed(2)}`;
const fmtSpeed = (v) => `${Math.round(v)}`;
// Efficiency benchmarks (cost, time, latency) carry a unit and are lower-is-better; index-style scores use fmtScore.
const UNIT_FMT = {
  USD: (v) => `$${v.toFixed(2)}`, minutes: (v) => `${v.toFixed(1)} min`, seconds: (v) => `${v.toFixed(1)} s`,
  "k tokens": (v) => (v >= 1000 ? `${+(v / 1000).toFixed(2)}M` : `${Math.round(v)}k`), Elo: (v) => `${Math.round(v)}`,
};
// Leaderboard column groups. Overview keeps the table readable; the rest are one click away.
const OVERVIEW = new Set(["aa_intelligence_index", "aa_coding_index", "aa_agentic_index", "aa_cost_per_task", "aa_time_per_task"]);
const EFFICIENCY = new Set(["cost", "speed", "latency", "spec"]);
const COLS = [["overview", "Overview"], ["evals", "Evaluations"], ["efficiency", "Cost & speed"]];
const inGroup = (b, g) => (g === "overview" ? OVERVIEW.has(b.benchmark_id)
  : g === "efficiency" ? EFFICIENCY.has(b.category) : !OVERVIEW.has(b.benchmark_id) && !EFFICIENCY.has(b.category));
const fmtFor = (b) => (b && UNIT_FMT[b.unit]) || fmtScore;

// Superscore = output tok/s x (blended price per 1M tokens x Intelligence Index) x (non-hallucination rate / 100)
//              / (time per task x cost per task).
// The non-hallucination factor keeps only the share of answers that are not made up. Units: tok/s, USD per 1M tokens,
// %, seconds (same clock as tok/s; the data stores minutes), USD. Needs all six numbers.
const SUPER_BLURB = "Superscore: output tok/s x (blended price per 1M tokens x AA Intelligence Index) x (non-hallucination rate / 100) / (AA time per task in seconds x AA cost per task). Higher is better.";
function superscore(r) {
  const idx = r.scores.aa_intelligence_index, cost = r.scores.aa_cost_per_task, time = r.scores.aa_time_per_task;
  const nh = r.scores.aa_non_hallucination;
  if (!idx || !cost || !time || !nh || !r.price || !r.speed || !(time.value > 0) || !(cost.value > 0)) return null;
  return (r.speed.value * r.price.value * idx.value * (nh.value / 100)) / (time.value * 60 * cost.value);
}
// The superscore as a pseudo-benchmark for the scatter's Score menu and its explanation.
const SUPER_BENCH = {
  benchmark_id: "superscore", name: "Superscore", higher_is_better: true, category: "composite",
  blurb: "Output tok/s x price per 1M tokens x Intelligence Index x (non-hallucination rate / 100), divided by (time per task in seconds x cost per task): roughly how much reliable intelligence a model delivers per second for the tokens it actually spends. Price and speed are both inside it, so against either axis the points lean with that axis; read it as a ranking with the axis for context. Higher is better.",
};
// Three significant figures, so small scores stay readable instead of rounding to 0.00.
const fmtSuper = (v) => (v >= 100 ? v.toFixed(0) : String(+v.toPrecision(3)));
// Short names for the "best in" tags on winning models.
const SHORT = { aa_intelligence_index: "Intelligence", aa_coding_index: "Coding", aa_agentic_index: "Agentic",
  aa_cost_per_task: "Cost per task", aa_time_per_task: "Time per task", fast: "Speed", cheap: "Price" };

function BestTags({ list }) {
  if (!list || !list.length) return null;
  return <span className="best-tags">{list.map((t) => <span key={t} className="best-tag">Best {t}</span>)}</span>;
}

// The newest row per key whose observation day is on or before asOf. Observations are append-only,
// so "previous dates" is this one query with an earlier asOf.
function latestBy(rows, keyOf, asOf) {
  const best = new Map();
  for (const r of rows) {
    if (day(r.observed_at) > asOf) continue;
    const k = keyOf(r);
    const cur = best.get(k);
    if (!cur || r.observed_at > cur.observed_at || (r.observed_at === cur.observed_at && r.obs_id > cur.obs_id)) best.set(k, r);
  }
  return best;
}

function bestPerModel(latest, valueOf, preferLow) {
  const out = new Map();
  for (const r of latest.values()) {
    const v = valueOf(r);
    if (v == null) continue;
    const cur = out.get(r.model_id);
    if (!cur || (preferLow ? v < cur.value : v > cur.value)) out.set(r.model_id, { value: v, row: r });
  }
  return out;
}

function Shape({ shape, size = 6, color }) {
  const s = size;
  if (shape === "diamond") return <path d={`M0 ${-s * 1.25} L${s * 1.25} 0 L0 ${s * 1.25} L${-s * 1.25} 0Z`} fill="none" stroke={color} strokeWidth="2" />;
  if (shape === "cross") return <path d={`M${-s} ${-s} L${s} ${s} M${s} ${-s} L${-s} ${s}`} stroke={color} strokeWidth="2.5" fill="none" />;
  if (shape === "dashed") return <rect x={-s} y={-s} width={2 * s} height={2 * s} fill="none" stroke={color} strokeWidth="2" strokeDasharray="3 2" />;
  return <rect x={-s} y={-s} width={2 * s} height={2 * s} fill={color} />;
}

function Glyph({ shape, color, size = 4.5 }) {
  return (
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true" style={{ flex: "none" }}>
      <Shape shape={shape} size={size} color={color} />
    </svg>
  );
}

// A company's mark in one colour, centred on the origin; `half` is half its side. No mark on file: a plain square.
function Mark({ org, color, half }) {
  const paths = LOGOS[org];
  if (!paths) return <rect x={-half * 0.7} y={-half * 0.7} width={half * 1.4} height={half * 1.4} fill={color} />;
  return (
    <g transform={`translate(${-half} ${-half}) scale(${half / 12})`} fill={color} fillRule="evenodd">
      {paths.map((d) => <path key={d.slice(0, 24)} d={d} />)}
    </g>
  );
}

function OrgMark({ org, color, size = 14 }) {
  return (
    <svg className="omark" width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true">
      <Mark org={org} color={color} half={12} />
    </svg>
  );
}

// Charts are drawn at the size they are shown (one SVG unit = one CSS pixel), so text and marks stay the same
// size on a phone as on a desktop instead of shrinking with the page.
function useChartSize() {
  const [node, setNode] = useState(null);
  const [width, setWidth] = useState(() => Math.min(720, (typeof window !== "undefined" ? window.innerWidth : 720) - 62));
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  const W = Math.max(300, Math.min(width, 1600));
  return [setNode, W, W < 560 ? 380 : Math.round(Math.min(640, W * 0.52))];
}

// A collapsible section (native <details>, so it works with the keyboard and without script state to break).
// Whether it is open is remembered per viewer.
function Fold({ id, title, meta, defaultOpen = false, children }) {
  const key = `models-fold-${id}`;
  const [open, setOpen] = useState(() => {
    const saved = readPref(key);
    return saved === "1" ? true : saved === "0" ? false : defaultOpen;
  });
  const onToggle = (e) => {
    const now = e.currentTarget.open;
    if (now === open) return;
    setOpen(now);
    writePref(key, now ? "1" : "0");
  };
  return (
    <details className="fold" open={open} onToggle={onToggle}>
      <summary>
        <span className="fold-mk" aria-hidden="true" />
        <span className="fold-t">{title}</span>
        {meta && <span className="fold-m">{meta}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

const X_EXPLAIN = {
  price: ["Price (horizontal, log scale)", "What one million tokens costs through the model's cheapest listed provider, blending input and output 3:1 (three input tokens for every output token, a typical chat mix). Each step right on the axis is a multiple, not a fixed amount, so $0.20 to $2 is the same distance as $2 to $20."],
  speed: ["Output speed (horizontal)", "Median tokens per second the model streams once it starts answering, through its fastest listed provider, as measured by Artificial Analysis. Higher is faster; it does not include the time spent thinking before the first token."],
};

function ScatterKey({ xMetric, benchObj }) {
  const [xName, xText] = X_EXPLAIN[xMetric];
  return (
    <>
      <dl className="explain">
        <dt>{benchObj.name} (vertical)</dt>
        <dd>{benchObj.blurb}{/(higher|lower) is (better|cheaper|faster|quicker)/i.test(benchObj.blurb) ? "" : benchObj.higher_is_better ? " Higher is better." : " Lower is better."}</dd>
        <dt>{xName}</dt>
        <dd>{xText}</dd>
        <dt>Reading the two together</dt>
        <dd>
          {xMetric === "price"
            ? `Up and to the left is better: a higher ${benchObj.name} for less money. The dotted frontier joins the models nothing else beats on both, so anything below it has a cheaper or equal option that scores at least as well.`
            : `Up and to the right is better: a higher ${benchObj.name} at a faster speed. The dotted frontier joins the models nothing else beats on both, so anything below it has a faster or equal option that scores at least as well.`}
        </dd>
      </dl>
      <p className="fold-p">Hover or tap a logo for details. Click it to pin the model, or drag a box to select several; pinned models are highlighted in the table below too.</p>
      <div className="legend" aria-label="Chart legend">
        <span>Each point is the company's logo.</span>
        <span><svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><rect className="champ" x={-6} y={-6} width={12} height={12} style={{ "--c": "var(--hit)" }} /></svg>In colour, on a tinted square: best in one of the areas below (also marked in the table)</span>
        <span><svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><rect x={-6} y={-6} width={12} height={12} fill="none" stroke="currentColor" strokeDasharray="3 2" /></svg>Dashed box: not a third-party measurement</span>
        <span><svg width="26" height="8" aria-hidden="true"><line className="frontier" x1="0" y1="4" x2="26" y2="4" /></svg>Efficient frontier: nothing else is as {xMetric === "price" ? "cheap" : "fast"} and as good</span>
      </div>
    </>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Marker legend">
      {Object.entries(SHAPE_LABEL).map(([shape, label]) => (
        <span key={shape}><Glyph shape={shape} color="currentColor" />{label}</span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Scatter: any benchmark against price (log) or speed, with the efficient frontier, hover, click to pin,
// and click-and-drag to brush a box of points.

const M = { l: 52, r: 24, t: 14, b: 44 };

function Scatter({ rows, bench, benchName, xMetric, colorOf, champs, hl, pinned, togglePin, setBrushed }) {
  const svgRef = useRef(null);
  const maskId = `cut${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [sizeRef, W, H] = useChartSize();
  // Axis text at twice the page's chart size on a wide screen (a bit less on a phone, where 22px would crowd
  // the plot); the margins grow with it so tick numbers and axis titles never overlap the data.
  const FT = W < 560 ? 15 : 22;
  const FL = W < 560 ? 16 : 24;
  const M = { l: Math.round(FT * 2.4 + FL + 18), r: 28, t: 16, b: Math.round(FT + FL + 30) };
  const fmtY = bench === "superscore" ? fmtSuper : fmtScore;
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(null);

  const pts = useMemo(
    () => rows
      .filter((r) => r.scores[bench] && (xMetric === "price" ? r.price : r.speed))
      .map((r) => ({ r, x: (xMetric === "price" ? r.price : r.speed).value, y: r.scores[bench].value })),
    [rows, bench, xMetric],
  );
  if (!pts.length) return <p className="empty">No models have both this benchmark and a {xMetric} observation yet.</p>;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xlo = xMetric === "price" ? Math.min(...xs) * 0.8 : 0;
  const xhi = Math.max(...xs) * (xMetric === "price" ? 1.25 : 1.1);
  // A handful of round-number ticks whatever the range (a 0-100 index or a 500k-1M token window).
  const pad = Math.max(2, (Math.max(...ys) - Math.min(...ys)) * 0.06);
  // Padding never pushes the axis below 0 or past 100 when the data itself stays inside those bounds.
  const lo = Math.min(...ys) >= 0 ? Math.max(0, Math.min(...ys) - pad) : Math.min(...ys) - pad;
  const hi = Math.max(...ys) <= 100 ? Math.min(100, Math.max(...ys) + pad) : Math.max(...ys) + pad;
  const yTicks = niceTicks(lo, hi, 6);
  const ylo = yTicks[0];
  const yhi = yTicks[yTicks.length - 1];
  const fx = (v) => {
    const t = xMetric === "price" ? (Math.log(v) - Math.log(xlo)) / (Math.log(xhi) - Math.log(xlo)) : (v - xlo) / (xhi - xlo);
    return M.l + t * (W - M.l - M.r);
  };
  const fy = (v) => H - M.b - ((v - ylo) / (yhi - ylo)) * (H - M.t - M.b);

  const xTicks = xMetric === "price"
    ? [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((t) => t >= xlo && t <= xhi)
    : niceTicks(0, xhi, W < 560 ? 4 : 7).filter((t) => t <= xhi);

  // A point is on the frontier when no other point is at least as cheap (or fast) and at least as good.
  const betterX = (a, b) => (xMetric === "price" ? a.x <= b.x : a.x >= b.x);
  const front = pts
    .filter((p) => !pts.some((q) => q !== p && betterX(q, p) && q.y >= p.y && (q.x !== p.x || q.y !== p.y)))
    .sort((a, b) => a.x - b.x);

  const toSvg = (e) => {
    const b = svgRef.current.getBoundingClientRect();
    return [((e.clientX - b.left) * W) / b.width, ((e.clientY - b.top) * H) / b.height];
  };
  const onDown = (e) => {
    const [x, y] = toSvg(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMove = (e) => {
    if (!drag) return;
    const [x, y] = toSvg(e);
    setDrag((d) => (d ? { ...d, x1: x, y1: y } : d));
  };
  const onUp = () => {
    if (!drag) return;
    const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
    if (x1 - x0 < 4 && y1 - y0 < 4) setBrushed(new Set());
    else setBrushed(new Set(pts.filter((p) => fx(p.x) >= x0 && fx(p.x) <= x1 && fy(p.y) >= y0 && fy(p.y) <= y1).map((p) => p.r.model_id)));
    setDrag(null);
  };

  const hp = hover && pts.find((p) => p.r.model_id === hover);
  const hs = hp && hp.r.scores[bench];
  // Highlighted points are drawn last so a pinned model is never hidden under a neighbour.
  // Winners of a "best in each area" card are drawn above the rest, and highlighted models above everything.
  const rank = (p) => (hl.has(p.r.model_id) ? 2 : champs.has(p.r.model_id) ? 1 : 0);
  const drawn = [...pts].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="chart-wrap" ref={sizeRef}>
      <svg ref={svgRef} className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${benchName} against ${xMetric}`}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={fy(v)} y2={fy(v)} />
            <text className="tick" x={M.l - 10} y={fy(v) + FT * 0.35} textAnchor="end" style={{ fontSize: FT }}>{v}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            <line className="grid" x1={fx(v)} x2={fx(v)} y1={M.t} y2={H - M.b} />
            <text className="tick" x={fx(v)} y={H - M.b + FT + 6} textAnchor="middle" style={{ fontSize: FT }}>{xMetric === "price" ? `$${v}` : v}</text>
          </g>
        ))}
        <line className="axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
        <line className="axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
        <text className="axlabel" x={(M.l + W - M.r) / 2} y={H - 8} textAnchor="middle" style={{ fontSize: FL }}>
          {xMetric === "price" ? (W < 560 ? "Price, USD / 1M tokens (log)" : "Price, USD per 1M tokens (3:1 blend, log scale)") : "Output speed, tokens per second"}
        </text>
        <text className="axlabel" x={FL} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 ${FL} ${(M.t + H - M.b) / 2})`} style={{ fontSize: FL }}>{benchName}</text>

        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" style={{ cursor: "crosshair" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} />
        {front.length > 1 && (
          <>
            {/* The frontier stops short of every logo: a mask cuts a small square out of the line at each point,
                so nothing shows through the gaps in a mark, whatever the theme's background is. */}
            <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
              <rect width={W} height={H} fill="#fff" />
              {pts.map((p) => <rect key={p.r.model_id} x={fx(p.x) - 12} y={fy(p.y) - 12} width={24} height={24} fill="#000" />)}
            </mask>
            <polyline className="frontier" mask={`url(#${maskId})`} pointerEvents="none" points={front.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ")} />
          </>
        )}
        {drag && (
          <rect className="brush" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)}
            width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} pointerEvents="none" />
        )}
        {drawn.map((p) => {
          const id = p.r.model_id;
          const on = hl.has(id);
          const dim = hl.size > 0 && !on;
          const sc = p.r.scores[bench];
          const third = (SHAPE[sc.provenance] || "square") === "square";
          const flip = fx(p.x) > W - 150;
          return (
            <g key={id} className={`pt${dim ? " dim" : ""}`} transform={`translate(${fx(p.x)} ${fy(p.y)})`}
              tabIndex={0} role="button" aria-pressed={pinned.has(id)}
              aria-label={`${p.r.display_name}, ${benchName} ${fmtY(sc.value)}, ${xMetric === "price" ? fmtPrice(p.x) : `${fmtSpeed(p.x)} tokens per second`}`}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => togglePin(id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(id); } }}
              onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(id)} onBlur={() => setHover(null)}>
              <rect x={-15} y={-15} width={30} height={30} fill="transparent" />
              <rect className={`ring${on ? " on" : ""}${third ? "" : " unverified"}`} x={-13} y={-13} width={26} height={26} />
              {champs.has(id) && <rect className="champ" x={-12} y={-12} width={24} height={24} style={{ "--c": colorOf(p.r.org) }} />}
              <g className="mark"><Mark org={p.r.org} color={champs.has(id) ? colorOf(p.r.org) : "var(--ink)"} half={champs.has(id) ? 9.5 : 9} /></g>
              {(on || hover === id) && (
                <text className="plabel" x={flip ? -15 : 15} y={-12} textAnchor={flip ? "end" : "start"}>{p.r.display_name}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hp && (
        <div className={`tip${fx(hp.x) > W * 0.62 ? " flip" : ""}`} role="status"
          style={{ left: `${(fx(hp.x) / W) * 100}%`, top: `${(fy(hp.y) / H) * 100}%` }}>
          <b>{hp.r.display_name}</b><br />
          {hp.r.org}<br />
          {champs.has(hp.r.model_id) && <><BestTags list={champs.get(hp.r.model_id)} /><br /></>}
          {benchName}: {fmtY(hs.value)}{hs.effort ? ` (${hs.effort})` : ""}<br />
          {xMetric === "price" ? `Price: ${fmtPrice(hp.x)} per 1M` : `Speed: ${fmtSpeed(hp.x)} tok/s`}<br />
          <span className="muted">{PROV_LABEL[hs.provenance]}: {hs.source_name}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Over time: one line per model, its best value each day (cheapest provider, fastest provider, best effort).
// Rescans append a row even when nothing moved, so a model whose value never changed is drawn as a faint guide
// without a label, and a measure where nothing has changed yet (a context window, say) is shown as a ranked
// list of current values instead of a stack of identical flat lines.

const T0 = (s) => Date.parse(`${day(s)}T00:00:00Z`);
const DAY_MS = 864e5;

// Round-number axis ticks ("nice numbers").
function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / Math.max(1, n - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

// Spread labels apart vertically so none overlap; keeps them inside [top, bottom].
function spreadLabels(items, gap, top, bottom) {
  const sorted = [...items].sort((x, y) => x.y - y.y);
  for (let i = 1; i < sorted.length; i++) sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + gap);
  const over = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
  if (over > 0) for (const it of sorted) it.y -= over;
  for (let i = 0; i < sorted.length; i++) sorted[i].y = Math.max(sorted[i].y, top + i * gap);
  return sorted;
}

function OverTime({ data, asOf, visible, metric, colorOf, champs, hl, modelsById }) {
  const [sizeRef, W, H] = useChartSize();
  const bm = data.benchmarks.find((b) => b.benchmark_id === metric);
  const higher = metric === "price" ? false : metric === "speed" ? true : bm ? !!bm.higher_is_better : true;

  const series = useMemo(() => {
    let rows;
    let valueOf;
    if (metric === "speed") { rows = data.speeds; valueOf = (r) => r.tok_per_s; }
    else if (metric === "price") { rows = data.prices; valueOf = (r) => r.blended_3to1_per_1m; }
    else { rows = data.scores.filter((r) => r.benchmark_id === metric && r.status === "observed"); valueOf = (r) => r.value; }
    const byModel = new Map();                                   // model -> day -> best row that day
    for (const r of rows) {
      const v = valueOf(r);
      if (!visible.has(r.model_id) || day(r.observed_at) > asOf || v == null) continue;
      if (!byModel.has(r.model_id)) byModel.set(r.model_id, new Map());
      const days = byModel.get(r.model_id);
      const cur = days.get(day(r.observed_at));
      if (!cur || (higher ? v > cur.v : v < cur.v)) days.set(day(r.observed_at), { t: T0(r.observed_at), v, row: r });
    }
    return [...byModel.entries()].filter(([id]) => modelsById.has(id)).map(([id, days]) => {
      const pts = [...days.values()].sort((x, y) => x.t - y.t);
      const vals = pts.map((q) => q.v);
      return { key: id, model: modelsById.get(id), pts, last: pts[pts.length - 1], changed: Math.max(...vals) - Math.min(...vals) > 1e-9 };
    });
  }, [data, asOf, visible, metric, modelsById, higher]);

  if (!series.length) return <p className="empty">No observations for this measure yet.</p>;

  const unitFmt = bm && UNIT_FMT[bm.unit];
  const isScore = metric !== "speed" && metric !== "price" && !unitFmt;
  const fmtV = metric === "price" ? fmtPrice : unitFmt || (isScore ? fmtScore : fmtSpeed);
  const ts = series.flatMap((x) => x.pts.map((q) => q.t));
  const firstDay = new Date(Math.min(...ts)).toISOString().slice(0, 10);
  const moved = series.filter((x) => x.changed);

  // Nothing has changed: a ranked list of each model's current value says more than identical flat lines.
  if (!moved.length) {
    const ranked = [...series].sort((x, y) => (higher ? y.last.v - x.last.v : x.last.v - y.last.v));
    const top = Math.max(...ranked.map((x) => x.last.v)) || 1;
    return (
      <div className="chart-wrap">
        <p className="fold-p">
          No model's value has changed since tracking began on {firstDay}, so here is each model's current value,
          {higher ? " highest" : " lowest"} first. Lines appear here once a value moves.
        </p>
        <ol className="bars" aria-label={`${bm ? bm.name : metric}, current values`}>
          {ranked.map((x) => {
            const on = hl.has(x.key);
            const champ = champs.has(x.key);
            const c = colorOf(x.model.org);
            return (
              <li key={x.key} className={`${on ? "is-hl" : hl.size ? "is-dim" : ""}${champ ? " is-champ" : ""}`} style={champ ? { "--c": c } : undefined}
                title={`${PROV_LABEL[x.last.row.provenance]}: ${x.last.row.source_name}, ${day(x.last.row.observed_at)}`}>
                <span className="bar-name"><OrgMark org={x.model.org} color={champ ? c : "var(--ink)"} />{x.model.display_name}</span>
                <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.max(1.5, (x.last.v / top) * 100)}%` }} /></span>
                <span className="bar-v">{fmtV(x.last.v)}</span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  let t0 = Math.min(...ts);
  let t1 = Math.max(...ts);
  if (t0 === t1) { t0 -= DAY_MS; t1 += DAY_MS; }
  const vs = series.flatMap((x) => x.pts.map((q) => q.v));
  const vmin = Math.min(...vs);
  const vmax = Math.max(...vs);
  const yTicks = niceTicks(isScore ? vmin - 2 : 0, vmax * (isScore ? 1 : 1.05) + (isScore ? 2 : 0), 5);
  const vlo = yTicks[0];
  const vhi = yTicks[yTicks.length - 1];
  const LABEL_W = W < 520 ? 96 : 150;
  const fx = (t) => M.l + ((t - t0) / (t1 - t0)) * (W - M.l - M.r - LABEL_W);
  const fy = (v) => H - M.b - ((v - vlo) / (vhi - vlo)) * (H - M.t - M.b);
  const nDays = Math.round((t1 - t0) / DAY_MS);
  const stepDays = Math.max(1, Math.ceil(nDays / (W < 520 ? 3 : 6)));
  const xTicks = [];
  for (let t = t0; t <= t1 + 1; t += stepDays * DAY_MS) xTicks.push(t);
  const fmtDate = (t) => new Date(t).toISOString().slice(5, 10);

  // Only the biggest movers get a colour and a label (plus anything pinned); the rest stay faint, so a measure that
  // jitters a little every day (output speed, latency) doesn't turn into two dozen tangled labels.
  const move = (x) => Math.abs(x.last.v - x.pts[0].v) / (Math.abs(x.pts[0].v) || 1);
  const top = new Set([...moved].sort((x, y) => move(y) - move(x)).slice(0, W < 520 ? 5 : 8).map((x) => x.key));
  const lit = series.filter((x) => top.has(x.key) || hl.has(x.key));
  const labels = spreadLabels(lit.map((x) => ({ key: x.key, name: x.model.display_name, y: fy(x.last.v) + 4 })), 14, M.t + 8, H - M.b);
  const labelY = new Map(labels.map((l) => [l.key, l.y]));
  const faint = series.length - lit.length;

  return (
    <div className="chart-wrap" ref={sizeRef}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${bm ? bm.name : metric} over time`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={fy(v)} y2={fy(v)} />
            <text x={M.l - 8} y={fy(v) + 4} textAnchor="end">{isScore ? v : fmtV(v)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={fx(t)} y={H - M.b + 16} textAnchor="middle">{fmtDate(t)}</text>
        ))}
        <line className="axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
        <line className="axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
        {[...series].sort((x, y) => labelY.has(x.key) - labelY.has(y.key)).map((x) => {
          const isLit = labelY.has(x.key);
          const on = hl.has(x.key);
          const color = isLit ? colorOf(x.model.org) : "var(--muted)";
          const pts = x.pts.map((q) => `${fx(q.t)},${fy(q.v)}`).join(" ");
          return (
            <g key={x.key} className={`${isLit ? "" : "faint"}${hl.size && !on ? " dim" : ""}`}>
              <title>{`${x.model.display_name}: ${x.pts.map((q) => `${day(q.row.observed_at)} ${fmtV(q.v)}`).join(", ")}`}</title>
              {x.pts.length > 1
                ? <polyline fill="none" stroke={color} strokeWidth={on ? 3 : isLit ? 2 : 1} points={pts} />
                : <rect x={fx(x.last.t) - 3} y={fy(x.last.v) - 3} width={6} height={6} fill={color} />}
              {isLit && (
                <>
                  <rect x={fx(x.last.t) - 3} y={fy(x.last.v) - 3} width={6} height={6} fill={color} />
                  <line className="leader" x1={fx(x.last.t) + 5} y1={fy(x.last.v)} x2={fx(x.last.t) + 12} y2={labelY.get(x.key) - 4} />
                  <text className="plabel" x={fx(x.last.t) + 14} y={labelY.get(x.key)}>{x.model.display_name} {fmtV(x.last.v)}</text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <p className="fold-p">
        {moved.length} of {series.length} models changed since {firstDay} (each at its best value per day). Labelled: the {top.size} biggest moves
        {faint > 0 && `; the other ${faint} are faint. Pin a model in the chart or table to label it.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------

function Dashboard({ data, intro }) {
  const dates = useMemo(() => [...new Set([...data.scores, ...data.prices, ...data.speeds].map((r) => day(r.observed_at)))].sort(), [data]);
  const [asOfPick, setAsOfPick] = useState(null);
  const asOf = asOfPick && dates.includes(asOfPick) ? asOfPick : dates[dates.length - 1];

  // A benchmark with no observed score yet (defined in the seed so the review step can accept its first one) stays off the page.
  const benches = useMemo(() => {
    const seen = new Set(data.scores.filter((r) => r.status === "observed").map((r) => r.benchmark_id));
    return data.benchmarks.filter((b) => seen.has(b.benchmark_id));
  }, [data]);
  // The scatter's efficient frontier assumes bigger is better on the vertical axis, so lower-is-better measures stay out of it.
  const quality = useMemo(() => {
    const list = benches.filter((b) => b.higher_is_better && b.category !== "spec");
    const at = list.findIndex((b) => b.benchmark_id === "aa_intelligence_index") + 1;   // right after the Intelligence Index
    return [...list.slice(0, at), SUPER_BENCH, ...list.slice(at)];
  }, [benches]);
  const [cols, setCols] = useState("overview");
  const shown = useMemo(() => benches.filter((b) => inGroup(b, cols)), [benches, cols]);
  const showMoney = cols !== "evals";
  const showSuper = cols === "overview";

  const orgs = useMemo(() => [...new Set(data.models.map((m) => m.org))].sort(), [data]);
  const colorOf = (org) => `var(--s${(orgs.indexOf(org) % 16) + 1})`;
  const modelsById = useMemo(() => new Map(data.models.map((m) => [m.model_id, m])), [data]);

  const [hiddenOrgs, setHiddenOrgs] = useState(() => new Set());
  const [tab, setTab] = useState("board");
  const [benchPick, setBenchPick] = useState(null);
  const bench = quality.some((b) => b.benchmark_id === benchPick) ? benchPick : quality[0].benchmark_id;
  const benchName = quality.find((b) => b.benchmark_id === bench).name;
  const [xMetric, setXMetric] = useState("price");
  const [timeMetric, setTimeMetric] = useState("speed");
  const [sort, setSort] = useState({ key: `b:${benches[0].benchmark_id}`, dir: -1 });
  const [pinned, setPinned] = useState(() => new Set());
  const [brushed, setBrushed] = useState(() => new Set());
  const hl = useMemo(() => new Set([...pinned, ...brushed]), [pinned, brushed]);

  const allRows = useMemo(() => {
    const sc = latestBy(data.scores, (r) => `${r.model_id}|${r.benchmark_id}`, asOf);
    const price = bestPerModel(latestBy(data.prices, (r) => `${r.model_id}|${r.provider}`, asOf), (r) => r.blended_3to1_per_1m, true);
    const speed = bestPerModel(latestBy(data.speeds, (r) => `${r.model_id}|${r.provider}`, asOf), (r) => r.tok_per_s, false);
    return data.models.map((m) => {
      const scores = {};
      for (const b of benches) {
        const r = sc.get(`${m.model_id}|${b.benchmark_id}`);
        scores[b.benchmark_id] = r && r.status === "observed" ? r : null;
      }
      const row = { ...m, scores, price: price.get(m.model_id) || null, speed: speed.get(m.model_id) || null };
      const ss = superscore(row);
      // Also filed as a score so the scatter can plot it against price or speed like any benchmark.
      if (ss != null) scores.superscore = { value: ss, provenance: "third_party", source_name: "computed here from Artificial Analysis numbers", effort: "" };
      return { ...row, superscore: ss };
    }).filter((m) => m.price || m.speed || Object.values(m.scores).some(Boolean));
  }, [data, asOf, benches]);

  const rows = useMemo(() => allRows.filter((r) => !hiddenOrgs.has(r.org)), [allRows, hiddenOrgs]);
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.model_id)), [rows]);

  const sorted = useMemo(() => {
    const val = (r) => {
      if (sort.key === "name") return r.display_name.toLowerCase();
      if (sort.key === "super") return r.superscore;
      if (sort.key === "price") return r.price ? r.price.value : null;
      if (sort.key === "speed") return r.speed ? r.speed.value : null;
      const s = r.scores[sort.key.slice(2)];
      return s ? s.value : null;
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, sort]);

  const cards = useMemo(() => {
    const out = benches.filter((b) => OVERVIEW.has(b.benchmark_id)).map((b) => {
      let top = null;
      for (const r of rows) {
        const s = r.scores[b.benchmark_id];
        if (s && (!top || (b.higher_is_better ? s.value > top.s.value : s.value < top.s.value))) top = { r, s };
      }
      return { id: b.benchmark_id, label: `Best: ${b.name}`, top: top && { r: top.r, text: fmtFor(b)(top.s.value) }, blurb: b.blurb };
    });
    const fast = rows.filter((r) => r.speed).sort((a, b) => b.speed.value - a.speed.value)[0];
    const cheap = rows.filter((r) => r.price).sort((a, b) => a.price.value - b.price.value)[0];
    out.push({ id: "fast", label: "Fastest output", top: fast && { r: fast, text: `${fmtSpeed(fast.speed.value)} tok/s` }, blurb: "Median output tokens per second." });
    out.push({ id: "cheap", label: "Lowest price", top: cheap && { r: cheap, text: `${fmtPrice(cheap.price.value)} / 1M` }, blurb: "3:1 input:output blend, USD per 1M tokens." });
    return out;
  }, [benches, rows]);
  const champs = useMemo(() => {
    const m = new Map();
    for (const c of cards) {
      if (!c.top) continue;
      const id = c.top.r.model_id;
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(SHORT[c.id] || c.label.replace(/^Best: /, ""));
    }
    return m;
  }, [cards]);

  const togglePin = (id) => setPinned((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleOrg = (org) => setHiddenOrgs((prev) => {
    const next = new Set(prev);
    if (next.has(org)) next.delete(org); else next.add(org);
    return next;
  });
  const lowerFirst = (key) => key === "name" || key === "price" || benches.some((b) => `b:${b.benchmark_id}` === key && !b.higher_is_better);
  const setSortKey = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: lowerFirst(key) ? 1 : -1 }));
  const ariaSort = (key) => (sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none");

  const selected = [...hl].map((id) => modelsById.get(id)?.display_name).filter(Boolean);
  const tabs = [["board", "Leaderboard"], ["time", "Over time"]];

  return (
    <>
      <section className="mt-panel mt-hero" aria-label="Score against price or speed">
        <div className="pane-tools">
          <label className="lbl">Score{" "}
            <select value={bench} onChange={(e) => { setBenchPick(e.target.value); setBrushed(new Set()); }}>
              {quality.map((b) => <option key={b.benchmark_id} value={b.benchmark_id}>{b.name}</option>)}
            </select>
          </label>
          <span className="lbl">against</span>
          <div className="seg" role="group" aria-label="Horizontal axis">
            <button type="button" aria-pressed={xMetric === "price"} onClick={() => { setXMetric("price"); setBrushed(new Set()); }}>Price</button>
            <button type="button" aria-pressed={xMetric === "speed"} onClick={() => { setXMetric("speed"); setBrushed(new Set()); }}>Speed</button>
          </div>
        </div>
        <Scatter rows={rows} bench={bench} benchName={benchName} xMetric={xMetric} colorOf={colorOf} champs={champs}
          hl={hl} pinned={pinned} togglePin={togglePin} setBrushed={setBrushed} />
        {selected.length > 0 && (
          <p className="sel-list">
            <span>Highlighted: {selected.join(", ")}</span>
            <button type="button" className="chip" onClick={() => { setPinned(new Set()); setBrushed(new Set()); }}>Clear</button>
          </p>
        )}
        <Fold id="explain" title="How to read this chart" meta={`${benchName} vs ${xMetric === "price" ? "price" : "output speed"}`} defaultOpen={ROOMY}>
          <ScatterKey xMetric={xMetric} benchObj={quality.find((b) => b.benchmark_id === bench)} />
        </Fold>
      </section>

      {intro}

      <div className="folds">
        <Fold id="companies" title="Companies" meta={`${orgs.length - hiddenOrgs.size} of ${orgs.length} shown · as of ${asOf}`} defaultOpen={ROOMY}>
          <div className="mt-filters">
            <div className="chips">
              {orgs.map((org) => (
                <button key={org} type="button" className="chip" aria-pressed={!hiddenOrgs.has(org)} onClick={() => toggleOrg(org)}>
                  <OrgMark org={org} color="var(--ink)" />{org}
                </button>
              ))}
            </div>
            {hiddenOrgs.size > 0 && (
              <button type="button" className="chip" onClick={() => setHiddenOrgs(new Set())}>Show all</button>
            )}
            {dates.length > 0 && (
              <label className="lbl">As of{" "}
                <select value={asOf} onChange={(e) => setAsOfPick(e.target.value)} aria-label="Show data as of this date">
                  {dates.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            )}
          </div>
        </Fold>

        <Fold id="best" title="Best in each area" meta={`${cards.length} measures`} defaultOpen={ROOMY}>
          <div className="mt-cards">
            {cards.map((c) => (
              <div key={c.id} className="mt-card">
                <div className="k">{c.label}</div>
                {c.top ? (
                  <>
                    <div className="v"><OrgMark org={c.top.r.org} color={colorOf(c.top.r.org)} size={18} />{c.top.r.display_name}</div>
                    <div className="n">{c.top.r.org} · {c.top.text}</div>
                  </>
                ) : <div className="v muted">not observed</div>}
                <div className="blurb">{c.blurb}</div>
              </div>
            ))}
          </div>
        </Fold>

        <Fold id="about" title="About this data" meta="sources and caveats">
          <p className="mt-note">{data.note}</p>
        </Fold>
      </div>

      <section className="mt-panel">
        <div className="tabs" role="tablist" aria-label="Views">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {tab === "board" && (
          <div className="tbl-wrap" style={{ marginTop: 10 }}>
            <div className="pane-tools">
              <div className="seg" role="group" aria-label="Columns">
                {COLS.map(([id, label]) => (
                  <button key={id} type="button" aria-pressed={cols === id} onClick={() => setCols(id)}>{label}</button>
                ))}
              </div>
              <span className="muted">{shown.length + (showMoney ? 2 : 0) + (showSuper ? 1 : 0)} columns · click a header to sort</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th aria-sort={ariaSort("name")}><button type="button" onClick={() => setSortKey("name")}>Model</button></th>
                  {showSuper && <th className="super" aria-sort={ariaSort("super")} title={SUPER_BLURB}><button type="button" onClick={() => setSortKey("super")}>Superscore</button></th>}
                  {shown.map((b) => (
                    <th key={b.benchmark_id} aria-sort={ariaSort(`b:${b.benchmark_id}`)} title={b.blurb}>
                      <button type="button" onClick={() => setSortKey(`b:${b.benchmark_id}`)}>{b.name}</button>
                    </th>
                  ))}
                  {showMoney && <th aria-sort={ariaSort("price")} title="USD per 1M tokens, 3:1 input:output blend"><button type="button" onClick={() => setSortKey("price")}>$ / 1M</button></th>}
                  {showMoney && <th aria-sort={ariaSort("speed")} title="Median output tokens per second"><button type="button" onClick={() => setSortKey("speed")}>tok/s</button></th>}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.model_id} className={`${hl.has(r.model_id) ? "is-hl" : hl.size ? "is-dim" : ""}${champs.has(r.model_id) ? " is-champ" : ""}`}
                    style={champs.has(r.model_id) ? { "--c": colorOf(r.org) } : undefined} onClick={() => togglePin(r.model_id)}>
                    <td><span className="mname"><OrgMark org={r.org} color={champs.has(r.model_id) ? colorOf(r.org) : "var(--ink)"} />{r.display_name}<span className="muted">{r.org}</span><BestTags list={champs.get(r.model_id)} /></span></td>
                    {showSuper && (r.superscore != null ? (
                      <td className="super" title={`${SUPER_BLURB}\n${fmtSpeed(r.speed.value)} tok/s x ${fmtPrice(r.price.value)} x ${fmtScore(r.scores.aa_intelligence_index.value)} x ${(r.scores.aa_non_hallucination.value / 100).toFixed(2)} / (${Math.round(r.scores.aa_time_per_task.value * 60)} s x ${UNIT_FMT.USD(r.scores.aa_cost_per_task.value)})`}>{fmtSuper(r.superscore)}</td>
                    ) : <td className="na super" title="Needs output speed, a price, the Intelligence Index, the non-hallucination rate, time per task and cost per task.">not observed</td>)}
                    {shown.map((b) => {
                      const s = r.scores[b.benchmark_id];
                      return s ? (
                        <td key={b.benchmark_id} title={`${PROV_LABEL[s.provenance]}: ${s.source_name}${s.effort ? `, ${s.effort}` : ""}`}>
                          <span className="cellmk"><Glyph shape={SHAPE[s.provenance] || "square"} color={colorOf(r.org)} />{fmtFor(b)(s.value)}</span>
                        </td>
                      ) : <td key={b.benchmark_id} className="na">not observed</td>;
                    })}
                    {showMoney && (r.price ? (
                      <td title={`${PROV_LABEL[r.price.row.provenance]}: ${r.price.row.source_name}`}>{fmtPrice(r.price.value)}</td>
                    ) : <td className="na">not observed</td>)}
                    {showMoney && (r.speed ? (
                      <td title={`${PROV_LABEL[r.speed.row.provenance]}: ${r.speed.row.source_name}`}>{fmtSpeed(r.speed.value)}</td>
                    ) : <td className="na">not observed</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <Legend />
          </div>
        )}

        {tab === "time" && (
          <div style={{ marginTop: 10 }}>
            <div className="pane-tools">
              <label className="lbl">Measure{" "}
                <select value={timeMetric} onChange={(e) => setTimeMetric(e.target.value)}>
                  <option value="speed">Output speed (tok/s)</option>
                  <option value="price">Price ($ / 1M, blended)</option>
                  {benches.map((b) => <option key={b.benchmark_id} value={b.benchmark_id}>{b.name}</option>)}
                </select>
              </label>
            </div>
            <OverTime data={data} asOf={asOf} visible={visibleIds} metric={timeMetric} colorOf={colorOf} champs={champs} hl={hl} modelsById={modelsById} />
          </div>
        )}
      </section>
    </>
  );
}

export default function ModelsPage() {
  const [theme, setTheme] = useState(initialTheme);
  const [type, setType] = useState(() => (readPref(TYPE_KEY) === "sans" ? "sans" : "serif"));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref(THEME_KEY, theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.type = type;
    writePref(TYPE_KEY, type);
  }, [type]);
  useEffect(() => {
    let live = true;
    fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.message || String(e)); });
    return () => { live = false; };
  }, []);

  // The chart is the takeaway, so it comes first; title, theme and the data note follow it.
  const intro = (
    <>
        <header className="mt-head">
          <div>
            <h1 className="mt-title">Model tracker</h1>
            <p className="mt-sub">Frontier AI models by benchmark score, price and speed. <a href="/">patelpb.com</a></p>
          </div>
          <div className="mt-tools">
            <div className="seg" role="group" aria-label="Theme">
              {THEMES.map(([id, label]) => (
                <button key={id} type="button" aria-pressed={theme === id} onClick={() => setTheme(id)}>{label}</button>
              ))}
            </div>
            {SERIF_THEMES.includes(theme) && (
              <div className="seg" role="group" aria-label="Typeface">
                <button type="button" aria-pressed={type === "sans"} onClick={() => setType("sans")}>Sans</button>
                <button type="button" aria-pressed={type === "serif"} onClick={() => setType("serif")}>Serif</button>
              </div>
            )}
          </div>
        </header>
    </>
  );

  return (
    <main className="mt">
      {!data && intro}
      {error && <p className="mt-note" role="alert">Could not load the data ({error}).</p>}
      {!data && !error && <p className="empty">Loading…</p>}
      {data && <Dashboard data={data} intro={intro} />}
    </main>
  );
}
