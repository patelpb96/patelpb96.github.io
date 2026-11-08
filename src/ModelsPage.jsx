import { useEffect, useMemo, useRef, useState } from "react";
import "./models-themes.css";
import "./models.css";

const DATA_URL = "/projects/models/data/latest.json";
const THEME_KEY = "models-theme";
const TYPE_KEY = "models-type";
const THEMES = [["ember", "Ember"], ["walnut", "Walnut"], ["space", "Space"], ["8bit", "8-Bit"], ["paper", "Paper"], ["ink", "Ink"]];
const SERIF_THEMES = ["paper", "ink"];

// Marker shapes follow the agent dashboard's vocabulary: squares, diamonds and a cross, never rounded.
// Shape = where the number came from; colour = company. Neither carries meaning alone.
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

const W = 720;
const H = 400;
const M = { l: 52, r: 24, t: 14, b: 44 };

function Scatter({ rows, bench, benchName, xMetric, colorOf, hl, pinned, togglePin, setBrushed }) {
  const svgRef = useRef(null);
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
  const ylo = Math.floor((Math.min(...ys) - 4) / 5) * 5;
  const yhi = Math.ceil((Math.max(...ys) + 3) / 5) * 5;
  const fx = (v) => {
    const t = xMetric === "price" ? (Math.log(v) - Math.log(xlo)) / (Math.log(xhi) - Math.log(xlo)) : (v - xlo) / (xhi - xlo);
    return M.l + t * (W - M.l - M.r);
  };
  const fy = (v) => H - M.b - ((v - ylo) / (yhi - ylo)) * (H - M.t - M.b);

  const xTicks = xMetric === "price"
    ? [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((t) => t >= xlo && t <= xhi)
    : Array.from({ length: 5 }, (_, i) => Math.round((xhi / 5) * i / 10) * 10);
  const yTicks = [];
  for (let v = ylo; v <= yhi; v += 5) yTicks.push(v);

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

  return (
    <div className="chart-wrap">
      <svg ref={svgRef} className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${benchName} against ${xMetric}`}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={fy(v)} y2={fy(v)} />
            <text x={M.l - 8} y={fy(v) + 4} textAnchor="end">{v}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            <line className="grid" x1={fx(v)} x2={fx(v)} y1={M.t} y2={H - M.b} />
            <text x={fx(v)} y={H - M.b + 16} textAnchor="middle">{xMetric === "price" ? `$${v}` : v}</text>
          </g>
        ))}
        <line className="axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
        <line className="axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle">
          {xMetric === "price" ? "Price, USD per 1M tokens (3:1 blend, log scale)" : "Output speed, tokens per second"}
        </text>
        <text x={14} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 14 ${(M.t + H - M.b) / 2})`}>{benchName}</text>

        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" style={{ cursor: "crosshair" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} />
        {front.length > 1 && (
          <polyline className="frontier" points={front.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ")} />
        )}
        {drag && (
          <rect className="brush" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)}
            width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} pointerEvents="none" />
        )}
        {pts.map((p) => {
          const id = p.r.model_id;
          const on = hl.has(id);
          const dim = hl.size > 0 && !on;
          const sc = p.r.scores[bench];
          return (
            <g key={id} className={`pt${dim ? " dim" : ""}`} transform={`translate(${fx(p.x)} ${fy(p.y)})`}
              tabIndex={0} role="button" aria-pressed={pinned.has(id)}
              aria-label={`${p.r.display_name}, ${benchName} ${fmtScore(sc.value)}, ${xMetric === "price" ? fmtPrice(p.x) : `${fmtSpeed(p.x)} tokens per second`}`}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => togglePin(id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(id); } }}
              onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(id)} onBlur={() => setHover(null)}>
              <rect x={-14} y={-14} width={28} height={28} fill="transparent" />
              <rect className={`ring${on ? " on" : ""}`} x={-11} y={-11} width={22} height={22} />
              <Shape shape={SHAPE[sc.provenance] || "square"} size={6} color={colorOf(p.r.org)} />
              {(on || hover === id) && <text className="plabel" x={11} y={-9}>{p.r.display_name}</text>}
            </g>
          );
        })}
      </svg>
      {hp && (
        <div className={`tip${fx(hp.x) > W * 0.62 ? " flip" : ""}`} role="status"
          style={{ left: `${(fx(hp.x) / W) * 100}%`, top: `${(fy(hp.y) / H) * 100}%` }}>
          <b>{hp.r.display_name}</b><br />
          {hp.r.org}<br />
          {benchName}: {fmtScore(hs.value)}{hs.effort ? ` (${hs.effort})` : ""}<br />
          {xMetric === "price" ? `Price: ${fmtPrice(hp.x)} per 1M` : `Speed: ${fmtSpeed(hp.x)} tok/s`}<br />
          <span className="muted">{PROV_LABEL[hs.provenance]}: {hs.source_name}</span>
        </div>
      )}
      <Legend />
      <div className="legend"><span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--hit)" strokeWidth="1.5" strokeDasharray="5 3" /></svg>Efficient frontier: nothing else is as {xMetric === "price" ? "cheap" : "fast"} and as good</span></div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Over time: one line per model + provider (or model + effort for scores). Each rescan appends a row,
// so a flat line means "checked and unchanged".

const T0 = (s) => Date.parse(`${day(s)}T00:00:00Z`);

function OverTime({ data, asOf, visible, metric, colorOf, hl, modelsById }) {
  const series = useMemo(() => {
    let rows;
    let valueOf;
    let keyOf;
    if (metric === "speed") { rows = data.speeds; valueOf = (r) => r.tok_per_s; keyOf = (r) => `${r.model_id}|${r.provider}`; }
    else if (metric === "price") { rows = data.prices; valueOf = (r) => r.blended_3to1_per_1m; keyOf = (r) => `${r.model_id}|${r.provider}`; }
    else {
      rows = data.scores.filter((r) => r.benchmark_id === metric && r.status === "observed");
      valueOf = (r) => r.value;
      keyOf = (r) => `${r.model_id}|${r.effort || "setup n/a"}`;
    }
    const groups = new Map();
    for (const r of rows) {
      if (!visible.has(r.model_id) || day(r.observed_at) > asOf || valueOf(r) == null) continue;
      const k = keyOf(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ t: T0(r.observed_at), v: valueOf(r), row: r });
    }
    return [...groups.entries()].map(([k, pts]) => ({ key: k, model: modelsById.get(k.split("|")[0]), sub: k.split("|")[1], pts: pts.sort((a, b) => a.t - b.t) }));
  }, [data, asOf, visible, metric, modelsById]);

  if (!series.length) return <p className="empty">No observations for this measure yet.</p>;

  const ts = series.flatMap((s) => s.pts.map((p) => p.t));
  let t0 = Math.min(...ts);
  let t1 = Math.max(...ts);
  if (t0 === t1) { t0 -= 3 * 864e5; t1 += 3 * 864e5; }
  const vs = series.flatMap((s) => s.pts.map((p) => p.v));
  const bm = data.benchmarks.find((b) => b.benchmark_id === metric);
  const unitFmt = bm && UNIT_FMT[bm.unit];
  const isScore = metric !== "speed" && metric !== "price" && !unitFmt;       // index scores get a tight axis; units start at zero
  const vlo = isScore ? Math.floor((Math.min(...vs) - 4) / 5) * 5 : 0;
  const vhi = isScore ? Math.ceil((Math.max(...vs) + 3) / 5) * 5 : Math.max(...vs) * 1.15;
  const fx = (t) => M.l + ((t - t0) / (t1 - t0)) * (W - M.l - M.r - 90);
  const fy = (v) => H - M.b - ((v - vlo) / (vhi - vlo)) * (H - M.t - M.b);
  const yTicks = Array.from({ length: 5 }, (_, i) => vlo + ((vhi - vlo) / 4) * i);
  const xTicks = Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) / 3) * i);
  const fmtV = metric === "price" ? fmtPrice : unitFmt || (isScore ? fmtScore : fmtSpeed);
  const single = new Set(ts).size < 2;

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${metric} over time`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={fy(v)} y2={fy(v)} />
            <text x={M.l - 8} y={fy(v) + 4} textAnchor="end">{isScore ? v.toFixed(0) : metric === "price" ? v.toFixed(0) : Math.round(v)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={fx(t)} y={H - M.b + 16} textAnchor="middle">{new Date(t).toISOString().slice(0, 10)}</text>
        ))}
        <line className="axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
        <line className="axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
        {series.map((s) => {
          const color = colorOf(s.model.org);
          const on = hl.has(s.model.model_id);
          const dim = hl.size > 0 && !on;
          const last = s.pts[s.pts.length - 1];
          return (
            <g key={s.key} className={dim ? "dim" : ""}>
              {s.pts.length > 1 && <polyline fill="none" stroke={color} strokeWidth={on ? 3 : 1.8} points={s.pts.map((p) => `${fx(p.t)},${fy(p.v)}`).join(" ")} />}
              {s.pts.map((p) => (
                <g key={p.row.obs_id} transform={`translate(${fx(p.t)} ${fy(p.v)})`}>
                  <title>{`${s.model.display_name} (${s.sub}) ${fmtV(p.v)} on ${day(p.row.observed_at)}, ${PROV_LABEL[p.row.provenance]}: ${p.row.source_name}`}</title>
                  <rect x={-9} y={-9} width={18} height={18} fill="transparent" />
                  <Shape shape={SHAPE[p.row.provenance] || "square"} size={4.5} color={color} />
                </g>
              ))}
              <text className="plabel" x={fx(last.t) + 10} y={fy(last.v) + 4}>{s.model.display_name}</text>
            </g>
          );
        })}
      </svg>
      {single && <p className="mt-note">One observation date so far. Lines appear as rescans add rows.</p>}
      <Legend />
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
  const quality = useMemo(() => benches.filter((b) => b.higher_is_better), [benches]);
  const [cols, setCols] = useState("overview");
  const shown = useMemo(() => benches.filter((b) => inGroup(b, cols)), [benches, cols]);
  const showMoney = cols !== "evals";

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
      return { ...m, scores, price: price.get(m.model_id) || null, speed: speed.get(m.model_id) || null };
    }).filter((m) => m.price || m.speed || Object.values(m.scores).some(Boolean));
  }, [data, asOf, benches]);

  const rows = useMemo(() => allRows.filter((r) => !hiddenOrgs.has(r.org)), [allRows, hiddenOrgs]);
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.model_id)), [rows]);

  const sorted = useMemo(() => {
    const val = (r) => {
      if (sort.key === "name") return r.display_name.toLowerCase();
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
      <div>
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
          <span className="muted">Hover for details, click to pin, drag a box to select.</span>
        </div>
        <Scatter rows={rows} bench={bench} benchName={benchName} xMetric={xMetric} colorOf={colorOf}
          hl={hl} pinned={pinned} togglePin={togglePin} setBrushed={setBrushed} />
        {selected.length > 0 && <p className="sel-list">Highlighted: {selected.join(", ")}</p>}
      </div>
      </section>

      {intro}

      <section className="mt-filters" aria-label="Filters">
        <span className="lbl">Companies</span>
        <div className="chips">
          {orgs.map((org) => (
            <button key={org} type="button" className="chip" aria-pressed={!hiddenOrgs.has(org)} onClick={() => toggleOrg(org)}>
              <span className="sw" style={{ background: colorOf(org) }} />{org}
            </button>
          ))}
        </div>
        {dates.length > 0 && (
          <label className="lbl">As of{" "}
            <select value={asOf} onChange={(e) => setAsOfPick(e.target.value)} aria-label="Show data as of this date">
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}
        {hl.size > 0 && (
          <button type="button" className="chip" onClick={() => { setPinned(new Set()); setBrushed(new Set()); }}>Clear {hl.size} highlighted</button>
        )}
      </section>

      <section className="mt-cards" aria-label="Best in each area">
        {cards.map((c) => (
          <div key={c.id} className="mt-card">
            <div className="k">{c.label}</div>
            {c.top ? (
              <>
                <div className="v"><span className="sw" style={{ background: colorOf(c.top.r.org) }} />{c.top.r.display_name}</div>
                <div className="n">{c.top.r.org} · {c.top.text}</div>
              </>
            ) : <div className="v muted">not observed</div>}
            <div className="blurb">{c.blurb}</div>
          </div>
        ))}
      </section>

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
              <span className="muted">{shown.length + (showMoney ? 2 : 0)} columns · click a header to sort</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th aria-sort={ariaSort("name")}><button type="button" onClick={() => setSortKey("name")}>Model</button></th>
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
                  <tr key={r.model_id} className={hl.has(r.model_id) ? "is-hl" : hl.size ? "is-dim" : ""} onClick={() => togglePin(r.model_id)}>
                    <td><span className="mname"><span className="sw" style={{ background: colorOf(r.org) }} />{r.display_name}<span className="muted">{r.org}</span></span></td>
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
            <OverTime data={data} asOf={asOf} visible={visibleIds} metric={timeMetric} colorOf={colorOf} hl={hl} modelsById={modelsById} />
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
        {data && <p className="mt-note">{data.note}</p>}
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
