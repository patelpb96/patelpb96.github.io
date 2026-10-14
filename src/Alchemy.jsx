import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * RuneScape 3 high-alchemy dashboard.
 *
 * Reads the JSON exported by the `rs_alchemy` scraper (staged under
 * public/rs-alchemy/data). It is the whole of its own page (/projects/alchemy/,
 * see src/alchemy-main.jsx), so the table loads on arrival:
 *
 *   latest.json            newest row per item, ranked by alch profit (~1.9 MB)
 *   meta.json              run provenance (tiny)
 *   history/part-NNN.parquet  all items' daily prices as one table, sharded by
 *                             item_id % 256 (~200 kB each; see tools/rs_alchemy_table.py)
 *
 * Charts are plain SVG. The only dependency is hyparquet, loaded on demand the
 * first time an item's history is opened.
 */

const DATA_BASE = "/rs-alchemy/data";
const HISTORY_SHARDS = 256; // must match SHARDS in tools/rs_alchemy_table.py
const DAY_MS = 86400000;

// Live prices (patelpb.com on AWS only). A Lambda behind POST /api/rs/refresh re-quotes every
// item and writes live/rs-alchemy/{latest,meta}.json into the site bucket; see infra/ and lambdas/.
// Anywhere without that backend (GitHub Pages, vite dev) the live files are missing and the
// dashboard silently falls back to the static export above.
const LIVE_BASE = "/live/rs-alchemy";
const REFRESH_URL = "/api/rs/refresh";
// CloudFront signs the request to the Lambda function URL (OAC), which needs the body hash for POST.
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const POLL_MS = 5000;
const POLL_GIVE_UP_MS = 4 * 60000;

// Live meta is tiny and changes under us, so always bypass the browser cache.
function fetchLiveMeta() {
  return fetch(`${LIVE_BASE}/meta.json`, { cache: "no-store" })
    .then((r) => (r.ok && (r.headers.get("content-type") || "").includes("json") ? r.json() : null))
    .catch(() => null);
}

function fetchRows(url) {
  return fetch(url, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  });
}

// "2026-10-09 14:06:46" (static meta, UTC without zone) or full ISO (live meta) -> ms.
function parseUtc(text) {
  if (!text) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function formatAgo(ms, now) {
  if (ms == null) return "unknown";
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// One shard holds ~30 items' full histories. Fetch + decode it once, keep every
// item in it, so opening a neighbour is instant. Failures are dropped from the
// cache so a retry can succeed.
const shardCache = new Map(); // shard -> Promise<Map<item_id, points[]>>
function loadShard(k) {
  if (!shardCache.has(k)) {
    const p = Promise.all([
      import("hyparquet"),
      fetch(`${DATA_BASE}/history/part-${String(k).padStart(3, "0")}.parquet`).then((res) => {
        if (!res.ok) throw new Error(`history shard ${res.status}`);
        return res.arrayBuffer();
      }),
    ])
      .then(([{ parquetReadObjects }, file]) =>
        parquetReadObjects({ file, columns: ["item_id", "day", "price", "volume", "adj"] })
      )
      .then((rows) => {
        const byItem = new Map();
        for (const r of rows) {
          // int64 columns arrive as BigInt
          const id = Number(r.item_id);
          const price = r.price == null ? null : Number(r.price);
          const adj = r.adj == null ? null : Number(r.adj);
          let list = byItem.get(id);
          if (!list) byItem.set(id, (list = []));
          list.push({
            t: new Date(Number(r.day) * DAY_MS).toISOString().slice(0, 10),
            price,
            volume: r.volume == null ? null : Number(r.volume),
            profit: adj == null || price == null ? null : -(price + adj), // adj = -(price + profit)
          });
        }
        return byItem;
      });
    p.catch(() => shardCache.delete(k));
    shardCache.set(k, p);
  }
  return shardCache.get(k);
}

function loadHistory(itemId) {
  return loadShard(itemId % HISTORY_SHARDS).then((byItem) => byItem.get(itemId) || []);
}
const PAGE = 50; // rows revealed per "show more"
const CHART_MAX_POINTS = 900; // downsample threshold for the SVG line charts

// ---- formatting -----------------------------------------------------------

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Compact gp: 91.7M, 3.4K, -710. Full value goes in the cell's title tooltip.
function formatGp(value) {
  if (!isNum(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(abs).toLocaleString()}`;
}

function formatFull(value) {
  return isNum(value) ? Math.round(value).toLocaleString() : "—";
}

function formatPct(roi) {
  if (!isNum(roi)) return "—";
  const pct = roi * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(pct >= 100 || pct <= -100 ? 0 : 1)}%`;
}

function formatRatio(value) {
  if (!isNum(value)) return "—";
  if (value >= 100) return `${formatGp(value)}×`;
  return `${value.toFixed(value >= 10 ? 1 : 2)}×`;
}

function formatCell(kind, value) {
  if (kind === "pct") return formatPct(value);
  if (kind === "ratio") return formatRatio(value);
  if (kind === "int") return isNum(value) ? value.toLocaleString() : "—";
  return formatGp(value);
}

// ---- column configuration -------------------------------------------------

// `derived` columns are computed client-side in deriveRow; `on` = shown by default.
const COLUMNS = [
  { key: "name", label: "Item", align: "left", kind: "text", on: true },
  { key: "price", label: "Price", kind: "gp", on: true, help: "Current Grand Exchange price" },
  { key: "highalch", label: "High alch", kind: "gp", on: true, help: "gp received per High Level Alchemy cast" },
  { key: "alch_profit", label: "Profit", kind: "gp", signed: true, on: true, help: "High alch − price − nature rune, per cast" },
  { key: "alch_roi", label: "ROI", kind: "pct", signed: true, on: true, help: "Profit ÷ (price + nature rune)" },
  { key: "profit_per_limit", label: "Profit / limit", kind: "gp", signed: true, on: true, help: "Profit × buy limit (one 4-hour GE limit)" },
  { key: "fill_profit", label: "Fillable profit", kind: "gp", signed: true, on: true, derived: true, help: "Profit × min(buy limit, daily volume): what one limit yields when the item trades thinly" },
  { key: "volume", label: "Volume", kind: "gp", on: true, help: "Units traded on the GE per day" },
  { key: "vol_per_limit", label: "Vol / limit", kind: "ratio", on: true, derived: true, help: "Daily volume ÷ buy limit. Below 1×, a full limit rarely fills in a day" },
  { key: "limit", label: "Buy limit", kind: "int", help: "Units you can buy per 4 hours" },
  { key: "capital", label: "Capital", kind: "gp", derived: true, help: "(Price + nature rune) × buy limit: gp tied up to alch one full limit" },
  { key: "turnover", label: "GE turnover", kind: "gp", derived: true, help: "Price × daily volume: gp value traded per day" },
  { key: "nature_price", label: "Nature rune", kind: "gp", help: "Current nature rune price (cost per cast)" },
];
const NUMERIC_COLUMNS = COLUMNS.filter((c) => c.kind !== "text");
const COLUMN_BY_KEY = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));

function deriveRow(r) {
  const cost = isNum(r.price) ? r.price + (isNum(r.nature_price) ? r.nature_price : 0) : null;
  const hasLimit = isNum(r.limit) && r.limit > 0;
  return {
    ...r,
    _search: (r.name || "").toLowerCase(),
    fill_profit: isNum(r.alch_profit) && hasLimit && isNum(r.volume) ? r.alch_profit * Math.min(r.limit, r.volume) : null,
    vol_per_limit: hasLimit && isNum(r.volume) ? r.volume / r.limit : null,
    capital: hasLimit && cost != null ? cost * r.limit : null,
    turnover: isNum(r.price) && isNum(r.volume) ? r.price * r.volume : null,
  };
}

// Threshold box text -> number. Accepts "12,500", "10k", "1.5m", "2b"; percent columns take
// percent ("5" or "5%" = 0.05). Empty -> null, unparseable -> NaN (flagged in the UI).
function parseAmount(text, kind) {
  const s = String(text ?? "").trim().replace(/[,_\s]/g, "");
  if (!s) return null;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))([kmb%]?)$/i.exec(s);
  if (!m) return NaN;
  let v = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1);
  if (kind === "pct") v /= 100;
  return v;
}

// Item search syntax: space-separated terms must all match; `-term` excludes; `a|b` matches
// either; "quoted phrase" matches literally; /regex/ is a case-insensitive regular expression.
// Returns a predicate over the lowercased name, or null for an empty query.
function compileQuery(text) {
  const tests = [];
  for (const m of text.matchAll(/(-?)(?:"([^"]*)"?|\/((?:\\.|[^/])+)\/|(\S+))/g)) {
    const negate = m[1] === "-";
    let test;
    if (m[3] != null) {
      let rx;
      try { rx = new RegExp(m[3], "i"); } catch { continue; } // half-typed regex: ignore until valid
      test = (s) => rx.test(s);
    } else {
      const raw = (m[2] ?? m[4]).toLowerCase();
      const alts = m[2] != null ? [raw] : raw.split("|");
      const terms = alts.filter(Boolean);
      if (!terms.length) continue;
      test = (s) => terms.some((t) => s.includes(t));
    }
    tests.push(negate ? (s) => !test(s) : test);
  }
  return tests.length ? (s) => tests.every((t) => t(s)) : null;
}

// One-click setups for common questions; each replaces the view's sort/shortlist/thresholds.
const PRESETS = [
  {
    label: "Liquid → profit / limit",
    help: "Top 100 profitable items by daily volume, ranked by profit per buy limit",
    view: { profitableOnly: true, shortlist: { on: true, key: "volume", dir: "desc", n: 100 }, sort: { key: "profit_per_limit", dir: "desc" }, ranges: {} },
  },
  {
    label: "Fills every day",
    help: "Daily volume covers the full buy limit (Vol / limit ≥ 1), ranked by fillable profit",
    view: { profitableOnly: true, shortlist: { on: false, key: "volume", dir: "desc", n: 100 }, sort: { key: "fill_profit", dir: "desc" }, ranges: { vol_per_limit: { min: "1", max: "" } } },
  },
  {
    label: "Low capital",
    help: "Profitable items whose full limit costs under 5M gp, ranked by ROI",
    view: { profitableOnly: true, shortlist: { on: false, key: "volume", dir: "desc", n: 100 }, sort: { key: "alch_roi", dir: "desc" }, ranges: { capital: { min: "", max: "5m" } } },
  },
];

const VIEW_STORAGE_KEY = "alc-view-v1";
const DEFAULT_VIEW = {
  query: "",
  membership: "all", // all | members | f2p
  profitableOnly: false,
  sort: { key: "alch_profit", dir: "desc" },
  // Two-stage ranking: keep the top `n` rows by `key`, then order those by the table sort.
  shortlist: { on: false, key: "volume", dir: "desc", n: 100 },
  ranges: {}, // column key -> { min, max } as typed
  columns: COLUMNS.filter((c) => c.on).map((c) => c.key),
};

// Per-viewer convenience only; a blocked or corrupt store just means the defaults.
function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return DEFAULT_VIEW;
    const view = { ...DEFAULT_VIEW, ...saved, shortlist: { ...DEFAULT_VIEW.shortlist, ...saved.shortlist } };
    view.columns = (Array.isArray(view.columns) ? view.columns : DEFAULT_VIEW.columns).filter((k) => COLUMN_BY_KEY[k]);
    if (!view.columns.includes("name")) view.columns.unshift("name");
    if (!COLUMN_BY_KEY[view.sort?.key]) view.sort = DEFAULT_VIEW.sort;
    if (!COLUMN_BY_KEY[view.shortlist.key]) view.shortlist.key = DEFAULT_VIEW.shortlist.key;
    return view;
  } catch {
    return DEFAULT_VIEW;
  }
}

function compareBy(key, dir) {
  const factor = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = a[key];
    const bv = b[key];
    // Missing values (null / NaN) always sort last, regardless of direction.
    const aMissing = av == null || (typeof av === "number" && Number.isNaN(av));
    const bMissing = bv == null || (typeof bv === "number" && Number.isNaN(bv));
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * factor;
    }
    return (av - bv) * factor;
  };
}

// ---- SVG line chart -------------------------------------------------------

function LineChart({ points, accessor, height = 180, color, baseline = null, anchor = false, label, unit }) {
  const chart = useMemo(() => {
    const parsed = [];
    for (const p of points) {
      const v = accessor(p);
      if (!isNum(v)) continue;
      const time = Date.parse(p.t);
      if (Number.isNaN(time)) continue;
      parsed.push({ time, v });
    }
    if (parsed.length < 2) return null;

    // True extremes of the series itself (reported on the axis).
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const p of parsed) {
      if (p.v < dataMin) dataMin = p.v;
      if (p.v > dataMax) dataMax = p.v;
    }

    // Scaling domain. `anchor` pulls the baseline into view (profit -> keep 0
    // visible); without it the series fills the height, so a price far below its
    // high-alch value is not squashed into a flat band at the bottom.
    let vMin = dataMin;
    let vMax = dataMax;
    if (anchor && baseline != null) {
      vMin = Math.min(vMin, baseline);
      vMax = Math.max(vMax, baseline);
    }
    if (vMin === vMax) {
      vMin -= 1;
      vMax += 1;
    }
    const pad = (vMax - vMin) * 0.08;
    vMin -= pad;
    vMax += pad;

    const t0 = parsed[0].time;
    const t1 = parsed[parsed.length - 1].time;
    const W = 760;
    const H = height;
    const PX = 6;
    const PY = 10;
    const sx = (t) => (t1 === t0 ? PX : PX + ((t - t0) / (t1 - t0)) * (W - 2 * PX));
    const sy = (v) => H - PY - ((v - vMin) / (vMax - vMin)) * (H - 2 * PY);

    // Downsample the drawn vertices for performance; stats already used all.
    const stride = Math.max(1, Math.ceil(parsed.length / CHART_MAX_POINTS));
    const drawn = parsed.filter((_, i) => i % stride === 0);
    if (drawn[drawn.length - 1] !== parsed[parsed.length - 1]) {
      drawn.push(parsed[parsed.length - 1]);
    }

    const line = drawn.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.time).toFixed(1)} ${sy(p.v).toFixed(1)}`).join(" ");
    const area = `${line} L${sx(drawn[drawn.length - 1].time).toFixed(1)} ${H - PY} L${sx(drawn[0].time).toFixed(1)} ${H - PY} Z`;
    const last = parsed[parsed.length - 1];
    // Only draw the reference line when it actually falls inside the chart.
    const showBaseline = baseline != null && baseline >= vMin && baseline <= vMax;

    return {
      W, H, line, area,
      baselineY: showBaseline ? sy(baseline) : null,
      lastX: sx(last.time), lastY: sy(last.v), lastV: last.v,
      dataMin, dataMax,
      startDate: new Date(t0).toISOString().slice(0, 10),
      endDate: new Date(t1).toISOString().slice(0, 10),
    };
  }, [points, accessor, height, baseline, anchor]);

  if (!chart) {
    return <div className="alc-chart-empty">Not enough data to chart {label ? label.toLowerCase() : ""}.</div>;
  }

  const gid = `alc-grad-${label}`.replace(/\s+/g, "-");
  return (
    <figure className="alc-chart">
      <figcaption className="alc-chart-cap">
        <span>{label}</span>
        <span className="alc-chart-last" style={{ color }}>{formatGp(chart.lastV)}{unit || ""}</span>
      </figcaption>
      <svg viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none" role="img" aria-label={`${label} over time`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {chart.baselineY != null && (
          <line x1="0" x2={chart.W} y1={chart.baselineY} y2={chart.baselineY} className="alc-chart-zero" vectorEffect="non-scaling-stroke" />
        )}
        <path d={chart.area} fill={`url(#${gid})`} />
        <path d={chart.line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={chart.lastX} cy={chart.lastY} r="2.6" fill={color} />
      </svg>
      <div className="alc-chart-axis">
        <span>{chart.startDate}</span>
        <span className="alc-chart-range">low {formatGp(chart.dataMin)} · high {formatGp(chart.dataMax)}</span>
        <span>{chart.endDate}</span>
      </div>
    </figure>
  );
}

// ---- per-item detail (history charts + stats) -----------------------------

// Hoisted so their identity is stable across renders — otherwise a new arrow
// each render would invalidate LineChart's useMemo on every keystroke.
const priceAccessor = (p) => p.price;
const profitAccessor = (p) => p.profit;

function ItemDetail({ item, cache }) {
  const [state, setState] = useState(() => {
    const cached = cache.current.get(item.item_id);
    return cached ? { status: "ready", points: cached } : { status: "loading", points: null };
  });

  useEffect(() => {
    // Cache hit is already reflected by the lazy initializer above; nothing to fetch.
    if (cache.current.has(item.item_id)) return undefined;
    let active = true;
    loadHistory(item.item_id)
      .then((points) => {
        if (!points.length) throw new Error("no history");
        // Cache the completed download even if we unmounted mid-flight (the
        // cache is a ref, so this is safe) — reopening the row is then instant.
        cache.current.set(item.item_id, points);
        if (!active) return;
        setState({ status: "ready", points });
      })
      .catch(() => {
        if (active) setState({ status: "error", points: null });
      });
    return () => {
      active = false;
    };
  }, [item.item_id, cache]);

  const stats = useMemo(() => {
    if (!state.points || !state.points.length) return null;
    const pts = state.points;
    let pMin = Infinity;
    let pMax = -Infinity;
    let volSum = 0;
    let volCount = 0;
    let profitable = 0;
    for (const p of pts) {
      if (isNum(p.price)) {
        if (p.price < pMin) pMin = p.price;
        if (p.price > pMax) pMax = p.price;
      }
      if (isNum(p.volume)) {
        volSum += p.volume;
        volCount += 1;
      }
      if (isNum(p.profit) && p.profit > 0) profitable += 1;
    }
    return {
      days: pts.length,
      priceMin: pMin === Infinity ? null : pMin,
      priceMax: pMax === -Infinity ? null : pMax,
      volAvg: volCount ? volSum / volCount : null,
      profitable,
      profitablePct: pts.length ? profitable / pts.length : 0,
    };
  }, [state.points]);

  if (state.status === "loading") {
    return <div className="alc-detail alc-detail-msg">Loading price history for {item.name}…</div>;
  }
  if (state.status === "error") {
    return <div className="alc-detail alc-detail-msg">No price history available for {item.name}.</div>;
  }

  // Colour the profit chart by its current sign so a loss never reads as green.
  const profitColor = isNum(item.alch_profit) && item.alch_profit < 0 ? "var(--alc-neg)" : "var(--alc-pos)";

  return (
    <div className="alc-detail">
      <div className="alc-stat-row">
        <Stat label="Current" value={formatGp(item.price)} title={formatFull(item.price)} />
        <Stat label="Profit / cast" value={formatGp(item.alch_profit)} signed={item.alch_profit} title={formatFull(item.alch_profit)} />
        <Stat label="Nature cost" value={formatGp(item.nature_price)} title={formatFull(item.nature_price)} />
        <Stat label="Buy limit" value={isNum(item.limit) ? item.limit.toLocaleString() : "—"} />
        <Stat label="Fillable profit" value={formatGp(item.fill_profit)} signed={item.fill_profit} title={formatFull(item.fill_profit)} />
        <Stat label="Vol / limit" value={formatRatio(item.vol_per_limit)} />
        <Stat label="Capital" value={formatGp(item.capital)} title={formatFull(item.capital)} />
        {stats && <Stat label="Days charted" value={stats.days.toLocaleString()} />}
        {stats && <Stat label="Profitable days" value={`${Math.round(stats.profitablePct * 100)}%`} />}
        {stats && <Stat label="Avg volume" value={formatGp(stats.volAvg)} title={formatFull(stats.volAvg)} />}
        {stats && <Stat label="Price range" value={`${formatGp(stats.priceMin)}–${formatGp(stats.priceMax)}`} />}
      </div>
      <div className="alc-charts">
        <LineChart points={state.points} accessor={priceAccessor} color="var(--accent)" baseline={item.highalch} label="Price" />
        <LineChart points={state.points} accessor={profitAccessor} color={profitColor} baseline={0} anchor label="Alch profit" />
      </div>
      <p className="alc-detail-note">
        The profit chart&rsquo;s dashed line is break-even (0); the price chart shows the high-alch value ({formatFull(item.highalch)} gp) when it falls within the visible price range.
        {item.examine ? ` — ${item.examine}` : ""}
      </p>
    </div>
  );
}

function Stat({ label, value, title, signed }) {
  const cls = signed != null && isNum(signed) ? (signed < 0 ? "alc-neg" : "alc-pos") : "";
  return (
    <div className="alc-stat">
      <span className="alc-stat-label">{label}</span>
      <span className={`alc-stat-value ${cls}`} title={title}>{value}</span>
    </div>
  );
}

// ---- table ----------------------------------------------------------------

function Cell({ column, item, expanded, detailId, onToggle }) {
  const value = item[column.key];
  if (column.kind === "text") {
    return (
      <td className="alc-td alc-td-name">
        <button
          type="button"
          className="alc-name-btn"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        >
          {value}
        </button>
        <span className={`alc-badge ${item.members ? "alc-badge-mem" : "alc-badge-f2p"}`}>
          {item.members ? "P2P" : "F2P"}
        </span>
      </td>
    );
  }
  const signed = column.signed && isNum(value) ? (value < 0 ? "alc-neg" : "alc-pos") : "";
  const text = formatCell(column.kind, value);
  const title = column.kind === "gp" ? formatFull(value) : undefined;
  return <td className={`alc-td alc-num ${signed}`} title={title}>{text}</td>;
}

// ---- live refresh ---------------------------------------------------------

// "Refresh live prices" button + "as of" label. Asks the backend for a refresh, then polls the live
// meta until a newer run lands and hands the new rows up. The backend enforces a shared cooldown and
// a single-run lock, so a click during either just reports how fresh the data already is.
function LiveRefresh({ live, asOf, source, onLiveData }) {
  // idle | requesting | running | fresh | unavailable | error. A refresh someone else started may
  // already be running when the page loads; the mount effect below follows it.
  const [state, setState] = useState(() => ({ kind: live?.status === "running" ? "running" : "idle" }));
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => clearTimeout(pollRef.current), []);

  const poll = (baseline, deadline) => {
    clearTimeout(pollRef.current);
    pollRef.current = setTimeout(() => {
      fetchLiveMeta().then((m) => {
        if (m && m.status === "error") return setState({ kind: "error", text: "The refresh failed. Try again later." });
        if (m && m.status === "idle" && m.updated_utc && m.updated_utc !== baseline) {
          return fetchRows(`${LIVE_BASE}/latest.json`)
            .then((latest) => { onLiveData(latest, m); setState({ kind: "idle" }); })
            .catch(() => setState({ kind: "error", text: "Fetched new prices but couldn't load them. Reload the page." }));
        }
        if (Date.now() > deadline) return setState({ kind: "error", text: "Still running — check back in a few minutes." });
        setState((s) => (s.kind === "running" ? s : { kind: "running" }));
        poll(baseline, deadline);
      });
    }, POLL_MS);
  };

  useEffect(() => {
    if (live?.status === "running") poll(live.updated_utc ?? null, Date.now() + POLL_GIVE_UP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    setState({ kind: "requesting" });
    fetch(REFRESH_URL, { method: "POST", headers: { "x-amz-content-sha256": EMPTY_BODY_SHA256 }, cache: "no-store" })
      .then((r) => {
        // 429 = the account's Lambda concurrency is saturated, i.e. a burst of clicks; one of them
        // has almost certainly started a run, so follow it like "running".
        if (r.status === 429) return { status: "running" };
        return r.json().catch(() => ({ status: r.status === 405 || r.status === 404 ? "unavailable" : "error" }));
      })
      .then((res) => {
        if (res.status === "started" || res.status === "running") {
          setState({ kind: "running" });
          poll(live?.updated_utc ?? null, Date.now() + POLL_GIVE_UP_MS);
        } else if (res.status === "fresh") {
          setState({ kind: "fresh", updated: parseUtc(res.updated_utc), next: parseUtc(res.next_allowed_utc) });
        } else if (res.status === "unavailable") {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", text: "The refresh service had a problem. Try again later." });
        }
      })
      .catch(() => setState({ kind: "unavailable" }));
  };

  const coolingDown = state.kind === "fresh" && state.next != null && now < state.next;
  const busy = state.kind === "requesting" || state.kind === "running";
  let note = null;
  if (state.kind === "running") note = "Re-quoting every item on the Grand Exchange… (~1 min)";
  else if (coolingDown) note = `Already fresh (${formatAgo(state.updated, now)}) · next refresh in ${Math.max(1, Math.ceil((state.next - now) / 60000))} min`;
  else if (state.kind === "unavailable") note = "Live refresh isn't available on this copy of the site.";
  else if (state.kind === "error") note = state.text;

  return (
    <div className="alc-live" role="status" aria-live="polite">
      <span className="alc-live-asof">
        <span className={`alc-live-dot ${source === "live" ? "is-live" : ""}`} aria-hidden="true" />
        Prices as of <strong title={asOf ? new Date(asOf).toLocaleString() : undefined}>{formatAgo(asOf, now)}</strong>
        {source === "live" ? " · live" : ""}
      </span>
      <button type="button" className="alc-inline-btn alc-live-btn" onClick={refresh} disabled={busy || coolingDown || state.kind === "unavailable"}>
        {busy ? "Refreshing…" : "Refresh live prices"}
      </button>
      {note && <span className="alc-live-note">{note}</span>}
    </div>
  );
}

// ---- dashboard ------------------------------------------------------------

export default function AlchemyDashboard() {
  const [phase, setPhase] = useState("loading"); // loading -> ready | error
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [live, setLive] = useState(null); // live/rs-alchemy/meta.json, when the backend exists
  const [source, setSource] = useState("static"); // which latest.json the rows came from
  const [view, setView] = useState(loadView);
  const { query, membership, profitableOnly, sort, shortlist, ranges } = view;
  const [limit, setLimit] = useState(PAGE);
  const [selectedId, setSelectedId] = useState(null);
  const historyCache = useRef(new Map());

  // Any filter/sort change reshapes the result set, so snap the window back to the top.
  const patchView = (patch) => {
    setView((v) => ({ ...v, ...(typeof patch === "function" ? patch(v) : patch) }));
    setLimit(PAGE);
  };

  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view)); } catch { /* storage blocked */ }
  }, [view]);

  // Precompute derived metrics and a lowercased name once, not per keystroke.
  const applyRows = (latest) => {
    const arr = Array.isArray(latest) ? latest : [];
    setRows(arr.map(deriveRow));
  };

  // Only sets state from promise callbacks, so the mount effect below can call it directly.
  const fetchData = () => {
    Promise.all([
      fetchLiveMeta(),
      fetch(`${DATA_BASE}/meta.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([liveMeta, metaJson]) => {
        // Prefer the live export once one exists; fall back to the static one if it can't be read.
        const fromLive = liveMeta?.updated_utc
          ? fetchRows(`${LIVE_BASE}/latest.json`).then((latest) => ({ latest, src: "live" }))
          : Promise.reject(new Error("no live data"));
        return fromLive
          .catch(() => fetchRows(`${DATA_BASE}/latest.json`).then((latest) => ({ latest, src: "static" })))
          .then(({ latest, src }) => {
            applyRows(latest);
            setMeta(metaJson);
            setLive(liveMeta);
            setSource(src);
            setPhase("ready");
          });
      })
      .catch(() => setPhase("error"));
  };
  const retry = () => {
    setPhase("loading");
    fetchData();
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLiveData = (latest, liveMeta) => {
    applyRows(latest);
    setLive(liveMeta);
    setSource("live");
  };

  const asOf = source === "live" ? parseUtc(live?.updated_utc) : parseUtc(meta?.last_timestamp);

  // Parsed thresholds; NaN marks a box the user typed garbage into (it's ignored, and outlined).
  const bounds = useMemo(() => {
    const out = [];
    for (const [key, r] of Object.entries(ranges)) {
      const col = COLUMN_BY_KEY[key];
      if (!col) continue;
      const min = parseAmount(r?.min, col.kind);
      const max = parseAmount(r?.max, col.kind);
      out.push({ key, min, max });
    }
    return out;
  }, [ranges]);
  const activeBounds = bounds.filter((b) => isNum(b.min) || isNum(b.max));

  const { filtered, matched } = useMemo(() => {
    if (!rows) return { filtered: [], matched: 0 };
    const test = compileQuery(query);
    let out = rows;
    if (test) out = out.filter((r) => test(r._search));
    if (membership === "members") out = out.filter((r) => r.members);
    else if (membership === "f2p") out = out.filter((r) => !r.members);
    if (profitableOnly) out = out.filter((r) => isNum(r.alch_profit) && r.alch_profit > 0);
    for (const { key, min, max } of bounds) {
      if (!isNum(min) && !isNum(max)) continue;
      // A row with no value for a thresholded column can't satisfy it.
      out = out.filter((r) => {
        const v = r[key];
        if (!isNum(v)) return false;
        return !(isNum(min) && v < min) && !(isNum(max) && v > max);
      });
    }
    const matchedCount = out.length;
    if (shortlist.on && shortlist.n > 0) {
      out = [...out].sort(compareBy(shortlist.key, shortlist.dir)).slice(0, shortlist.n);
    }
    return { filtered: [...out].sort(compareBy(sort.key, sort.dir)), matched: matchedCount };
  },[rows, query, membership, profitableOnly, sort, shortlist, bounds]);

  const visible = filtered.slice(0, limit);
  const shownColumns = COLUMNS.filter((c) => view.columns.includes(c.key));

  const setRange = (key, side, value) =>
    patchView((v) => ({ ranges: { ...v.ranges, [key]: { ...v.ranges[key], [side]: value } } }));
  const toggleColumn = (key) =>
    setView((v) => ({ ...v, columns: v.columns.includes(key) ? v.columns.filter((k) => k !== key) : [...v.columns, key] }));
  const applyPreset = (preset) => {
    patchView({ ...preset.view, columns: [...new Set([...view.columns, preset.view.sort.key, ...Object.keys(preset.view.ranges)])] });
  };
  const resetView = () => setView({ ...DEFAULT_VIEW, columns: view.columns });

  const toggleSort = (key) => {
    patchView(({ sort: prev }) => {
      if (prev.key === key) return { sort: { key, dir: prev.dir === "asc" ? "desc" : "asc" } };
      // Text defaults to A–Z, numbers to high-to-low.
      return { sort: { key, dir: key === "name" ? "asc" : "desc" } };
    });
  };

  return (
    <div className="alchemy">
      <AlchemyStyles />

      {phase === "loading" && <div className="alc-msg">Fetching current Grand Exchange prices…</div>}

      {phase === "error" && (
        <div className="alc-msg">
          Could not load the alchemy data.{" "}
          <button className="alc-inline-btn" type="button" onClick={retry}>Retry</button>
        </div>
      )}

      {phase === "ready" && rows && (
        <>
          <p className="alc-intro prose">
            High Level Alchemy turns an item into gp: <code>profit = high&nbsp;alch − price − nature&nbsp;rune</code>.
            These are Grand Exchange prices for {formatFull(rows.length)} items.
            Click any row for its full price history. Data via the{" "}
            <a href="https://prices.runescape.wiki/rs/alchemy" target="_blank" rel="noreferrer">RuneScape wiki exchange</a>.
          </p>

          <LiveRefresh live={live} asOf={asOf} source={source} onLiveData={onLiveData} />

          <div className="alc-controls">
            <input
              className="alc-search"
              type="search"
              value={query}
              onChange={(e) => patchView({ query: e.target.value })}
              placeholder='Search items… e.g. rune -arrow, "dragon bones", sword|axe, /^black/'
              aria-label="Search items by name"
              aria-describedby="alc-search-help"
            />
            <div className="alc-toggle-group" role="group" aria-label="Membership filter">
              {[["all", "All"], ["members", "P2P"], ["f2p", "F2P"]].map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  className={`alc-toggle ${membership === value ? "is-active" : ""}`}
                  onClick={() => patchView({ membership: value })}
                >
                  {text}
                </button>
              ))}
            </div>
            <label className="alc-check">
              <input type="checkbox" checked={profitableOnly} onChange={(e) => patchView({ profitableOnly: e.target.checked })} />
              Profitable only
            </label>
            <p id="alc-search-help" className="alc-help">
              Search: all words must match · <code>-word</code> excludes · <code>a|b</code> either · <code>"exact phrase"</code> · <code>/regex/</code>
            </p>
          </div>

          <div className="alc-panel">
            <div className="alc-shortlist">
              <label className="alc-check">
                <input type="checkbox" checked={shortlist.on} onChange={(e) => patchView({ shortlist: { ...shortlist, on: e.target.checked } })} />
                Shortlist
              </label>
              <span className={`alc-shortlist-body ${shortlist.on ? "" : "is-off"}`}>
                take the
                <select className="alc-select" value={shortlist.dir} onChange={(e) => patchView({ shortlist: { ...shortlist, dir: e.target.value, on: true } })} aria-label="Shortlist direction">
                  <option value="desc">top</option>
                  <option value="asc">bottom</option>
                </select>
                <input
                  className="alc-num-input alc-n-input"
                  type="number"
                  min="1"
                  step="10"
                  value={shortlist.n}
                  onChange={(e) => patchView({ shortlist: { ...shortlist, n: Math.max(1, Math.floor(Number(e.target.value) || 0)), on: true } })}
                  aria-label="Shortlist size"
                />
                by
                <select className="alc-select" value={shortlist.key} onChange={(e) => patchView({ shortlist: { ...shortlist, key: e.target.value, on: true } })} aria-label="Shortlist metric">
                  {NUMERIC_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </span>
              <span className="alc-shortlist-body">
                {shortlist.on ? "then rank them by" : "Rank by"}
                <select className="alc-select" value={sort.key} onChange={(e) => patchView({ sort: { key: e.target.value, dir: e.target.value === "name" ? "asc" : "desc" } })} aria-label="Sort column">
                  {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                <button type="button" className="alc-dir-btn" onClick={() => toggleSort(sort.key)} aria-label={`Sort ${sort.dir === "asc" ? "ascending" : "descending"}; click to flip`}>
                  {sort.dir === "asc" ? "▲ low → high" : "▼ high → low"}
                </button>
              </span>
            </div>

            <div className="alc-presets" role="group" aria-label="Quick views">
              <span className="alc-panel-label">Quick views</span>
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className="alc-chip" title={p.help} onClick={() => applyPreset(p)}>{p.label}</button>
              ))}
              <button type="button" className="alc-chip alc-chip-quiet" onClick={resetView}>Reset filters</button>
            </div>

            <details className="alc-drawer">
              <summary>
                Thresholds{activeBounds.length ? <span className="alc-pill">{activeBounds.length} active</span> : null}
                <small> — min / max per column; 10k, 1.5m, 2b work; ROI in %</small>
              </summary>
              <div className="alc-range-grid">
                {NUMERIC_COLUMNS.map((col) => {
                  const b = bounds.find((x) => x.key === col.key) || {};
                  const r = ranges[col.key] || {};
                  const active = isNum(b.min) || isNum(b.max);
                  return (
                    <div key={col.key} className={`alc-range ${active ? "is-active" : ""}`}>
                      <span className="alc-range-label" title={col.help}>{col.label}</span>
                      {["min", "max"].map((side) => (
                        <input
                          key={side}
                          className={`alc-num-input ${Number.isNaN(b[side]) ? "is-bad" : ""}`}
                          type="text"
                          inputMode="decimal"
                          placeholder={side}
                          value={r[side] ?? ""}
                          onChange={(e) => setRange(col.key, side, e.target.value)}
                          aria-label={`${col.label} ${side}imum`}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              {activeBounds.length > 0 && (
                <button type="button" className="alc-chip alc-chip-quiet" onClick={() => patchView({ ranges: {} })}>Clear thresholds</button>
              )}
            </details>

            <details className="alc-drawer">
              <summary>Columns <small>— {shownColumns.length} of {COLUMNS.length} shown; hover a header for its definition</small></summary>
              <div className="alc-col-grid">
                {COLUMNS.filter((c) => c.key !== "name").map((col) => (
                  <label key={col.key} className="alc-check" title={col.help}>
                    <input type="checkbox" checked={view.columns.includes(col.key)} onChange={() => toggleColumn(col.key)} />
                    {col.label}{col.derived ? <span className="alc-derived">derived</span> : null}
                  </label>
                ))}
              </div>
            </details>

            <span className="alc-count" role="status" aria-live="polite">
              {formatFull(matched)} matches
              {shortlist.on && matched > filtered.length
                ? ` · ranking the ${shortlist.dir === "desc" ? "top" : "bottom"} ${formatFull(filtered.length)} by ${COLUMN_BY_KEY[shortlist.key].label.toLowerCase()}`
                : ""}
            </span>
          </div>

          <div className="alc-table-wrap">
            <table className="alc-table">
              <thead>
                <tr>
                  <th className="alc-th alc-th-rank" scope="col">#</th>
                  {shownColumns.map((col) => {
                    const active = sort.key === col.key;
                    return (
                      <th key={col.key} scope="col" className={`alc-th alc-th-${col.align || "right"}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className={`alc-sort ${active ? "is-active" : ""}`} title={col.help} onClick={() => toggleSort(col.key)}>
                          {col.label}
                          <span className="alc-arrow" aria-hidden="true">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((item, i) => {
                  const isOpen = item.item_id === selectedId;
                  const detailId = `alc-detail-${item.item_id}`;
                  const toggle = () => setSelectedId(isOpen ? null : item.item_id);
                  // The whole row is a mouse-click convenience; the real keyboard/
                  // AT control is the disclosure <button> in the name cell, so the
                  // <tr> keeps its native row semantics (no role override).
                  return (
                    <React.Fragment key={item.item_id}>
                      <tr className={`alc-row ${isOpen ? "is-open" : ""}`} onClick={toggle}>
                        <td className="alc-td alc-num alc-rank">{i + 1}</td>
                        {shownColumns.map((col) => (
                          <Cell key={col.key} column={col} item={item} expanded={isOpen} detailId={detailId} onToggle={toggle} />
                        ))}
                      </tr>
                      {isOpen && (
                        <tr className="alc-detail-row">
                          <td colSpan={shownColumns.length + 1}>
                            <div id={detailId} role="region" aria-label={`${item.name} price history`}>
                              <ItemDetail item={item} cache={historyCache} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {visible.length === 0 && (
                  <tr><td className="alc-td alc-empty" colSpan={shownColumns.length + 1}>No items match your filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {limit < filtered.length && (
            <div className="alc-more">
              <button className="alc-inline-btn" type="button" onClick={() => setLimit((n) => n + PAGE)}>
                Show more ({formatFull(filtered.length - limit)} hidden)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- scoped styles (reuse the site's :root palette) -----------------------

function AlchemyStyles() {
  return (
    <style>{`
      .alchemy { --alc-pos: #7fdca4; --alc-neg: #ff8a6b; color: var(--text); }
      .alc-msg { padding: 22px; text-align: center; color: var(--muted); border: 1px solid var(--line); background: rgba(30,14,8,0.6); }
      .alc-intro { margin: 0 0 20px; }
      .alc-intro code { font-family: inherit; font-size: 0.92em; color: var(--accent-soft); background: rgba(255,170,100,0.10); padding: 1px 6px; }
      .alc-neg { color: var(--alc-neg); }
      .alc-pos { color: var(--alc-pos); }

      .alc-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; }
      .alc-search {
        flex: 1 1 200px; min-width: 160px; font: inherit; font-size: 0.95rem;
        color: var(--text); background: rgba(20,10,6,0.8); border: 1px solid var(--line);
        padding: 10px 14px; border-radius: 0;
      }
      .alc-search::placeholder { color: var(--dim); }
      .alc-search:focus { outline: none; border-color: var(--accent); }
      .alc-toggle-group { display: inline-flex; border: 1px solid var(--line); }
      .alc-toggle {
        font: inherit; font-size: 0.82rem; color: var(--muted); background: transparent;
        border: 0; padding: 9px 14px; cursor: pointer; transition: 140ms ease;
      }
      .alc-toggle + .alc-toggle { border-left: 1px solid var(--line); }
      .alc-toggle:hover { color: var(--text); }
      .alc-toggle.is-active { background: var(--accent-soft); color: #2a1208; font-weight: 700; }
      .alc-check { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 0.85rem; cursor: pointer; }
      .alc-check input { accent-color: var(--accent); width: 15px; height: 15px; }
      .alc-count { display: block; margin-top: 12px; color: var(--dim); font-size: 0.82rem; }
      .alc-help { flex-basis: 100%; margin: 0; color: var(--dim); font-size: 0.76rem; }
      .alc-help code, .alc-intro code { font-family: inherit; }
      .alc-help code { color: var(--accent-soft); background: rgba(255,170,100,0.08); padding: 0 4px; }

      .alc-panel { border: 1px solid var(--line); background: rgba(30,14,8,0.5); padding: 12px 14px; margin-bottom: 16px; display: grid; gap: 12px; font-size: 0.86rem; }
      .alc-shortlist { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
      .alc-shortlist-body { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); transition: opacity 140ms ease; }
      .alc-shortlist-body.is-off { opacity: 0.45; }
      .alc-select, .alc-num-input {
        font: inherit; font-size: 0.84rem; color: var(--text); background: rgba(20,10,6,0.85);
        border: 1px solid var(--line); padding: 5px 8px; border-radius: 0; min-width: 0;
      }
      .alc-select:focus, .alc-num-input:focus { outline: none; border-color: var(--accent); }
      .alc-num-input.is-bad { border-color: var(--alc-neg); }
      .alc-n-input { width: 76px; }
      .alc-dir-btn, .alc-chip {
        font: inherit; font-size: 0.8rem; color: var(--accent); background: transparent;
        border: 1px solid var(--line); padding: 5px 10px; cursor: pointer; transition: 140ms ease;
      }
      .alc-dir-btn:hover, .alc-chip:hover { border-color: var(--accent); background: rgba(255,170,100,0.1); }
      .alc-chip-quiet { color: var(--muted); }
      .alc-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .alc-panel-label { color: var(--dim); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; margin-right: 4px; }
      .alc-drawer summary { cursor: pointer; color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; }
      .alc-drawer summary small { text-transform: none; letter-spacing: 0; color: var(--dim); }
      .alc-drawer summary:hover { color: var(--text); }
      .alc-drawer[open] summary { margin-bottom: 10px; }
      .alc-pill { margin-left: 8px; padding: 1px 7px; font-size: 0.7rem; background: var(--accent-soft); color: #2a1208; font-weight: 700; letter-spacing: 0; }
      .alc-range-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px 16px; margin-bottom: 10px; }
      .alc-range { display: grid; grid-template-columns: 1fr 78px 78px; gap: 6px; align-items: center; }
      .alc-range-label { color: var(--muted); font-size: 0.82rem; }
      .alc-range.is-active .alc-range-label { color: var(--accent); }
      .alc-col-grid { display: flex; flex-wrap: wrap; gap: 8px 18px; }
      .alc-derived { margin-left: 4px; font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dim); border: 1px solid var(--line); padding: 0 4px; }
      .alc-th { white-space: nowrap; }
      .alc-td-name { min-width: 230px; }
      .alc-select option { background: #1e0e08; color: var(--text); }

      .alc-table-wrap { overflow-x: auto; border: 1px solid var(--line); }
      .alc-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
      .alc-th { position: sticky; top: 0; z-index: 1; background: rgba(28,14,8,0.96); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); padding: 0; text-align: right; }
      .alc-th-left { text-align: left; }
      .alc-th-rank { padding: 10px 12px; color: var(--dim); font-size: 0.78rem; font-weight: 600; width: 46px; text-align: right; }
      .alc-sort {
        width: 100%; font: inherit; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--muted); background: transparent; border: 0;
        padding: 11px 12px; cursor: pointer; display: inline-flex; gap: 5px; justify-content: flex-end; align-items: center;
      }
      .alc-th-left .alc-sort { justify-content: flex-start; }
      .alc-sort:hover { color: var(--text); }
      .alc-sort.is-active { color: var(--accent); }
      .alc-arrow { font-size: 0.6rem; }

      .alc-row { cursor: pointer; border-bottom: 1px solid rgba(255,180,120,0.08); transition: background 120ms ease; }
      .alc-row:hover { background: rgba(255,170,100,0.07); }
      .alc-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
      .alc-row.is-open { background: rgba(255,170,100,0.12); }
      .alc-td { padding: 9px 12px; vertical-align: middle; }
      .alc-num { text-align: right; font-variant-numeric: tabular-nums; font-family: inherit; font-size: 0.86rem; }
      .alc-rank { color: var(--dim); }
      .alc-td-name { display: flex; align-items: center; gap: 8px; }
      .alc-name-btn {
        font: inherit; color: var(--text); background: transparent; border: 0; padding: 0;
        text-align: left; cursor: pointer;
      }
      .alc-name-btn:hover { color: var(--accent-soft); text-decoration: underline; }
      .alc-name-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .alc-badge { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; padding: 2px 5px; border: 1px solid var(--line); color: var(--dim); }
      .alc-badge-mem { color: var(--accent-soft); border-color: rgba(255,170,100,0.35); }
      .alc-empty { text-align: center; color: var(--dim); padding: 28px; }

      .alc-detail-row td { padding: 0; background: rgba(12,6,4,0.6); border-bottom: 1px solid var(--line); }
      .alc-detail { padding: 20px clamp(12px, 3vw, 26px); }
      .alc-detail-msg { color: var(--muted); }
      .alc-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 20px; }
      .alc-stat { border: 1px solid var(--line); padding: 10px 12px; background: rgba(30,14,8,0.5); }
      .alc-stat-label { display: block; color: var(--dim); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
      .alc-stat-value { display: block; font-family: inherit; font-size: 1.05rem; font-weight: 700; color: var(--text); }

      .alc-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .alc-chart { margin: 0; }
      .alc-chart-cap { display: flex; justify-content: space-between; align-items: baseline; color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
      .alc-chart-last { font-family: inherit; font-weight: 700; }
      .alc-chart svg { width: 100%; height: 180px; display: block; background: rgba(20,10,6,0.5); border: 1px solid var(--line); }
      .alc-chart-zero { stroke: rgba(255,210,170,0.35); stroke-width: 1; stroke-dasharray: 4 4; }
      .alc-chart-axis { display: flex; justify-content: space-between; gap: 8px; color: var(--dim); font-size: 0.7rem; margin-top: 5px; font-family: inherit; }
      .alc-chart-range { color: var(--muted); }
      .alc-chart-empty { color: var(--dim); font-size: 0.85rem; padding: 40px 0; text-align: center; border: 1px solid var(--line); background: rgba(20,10,6,0.5); }
      .alc-detail-note { color: var(--dim); font-size: 0.78rem; margin: 16px 0 0; line-height: 1.6; }

      .alc-live {
        display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 0 0 16px;
        padding: 10px 14px; border: 1px solid var(--line); background: rgba(30,14,8,0.5); font-size: 0.88rem;
      }
      .alc-live-asof { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); }
      .alc-live-asof strong { color: var(--text); font-weight: 700; }
      .alc-live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
      .alc-live-dot.is-live { background: var(--alc-pos); box-shadow: 0 0 10px var(--alc-pos); animation: alcPulse 2s ease-in-out infinite; }
      @keyframes alcPulse { 50% { opacity: 0.45; } }
      .alc-live-btn { margin-left: auto; }
      .alc-live-btn:disabled { opacity: 0.5; cursor: default; background: transparent; border-color: var(--line); }
      .alc-live-note { flex-basis: 100%; color: var(--dim); font-size: 0.8rem; }
      @media (prefers-reduced-motion: reduce) { .alc-live-dot.is-live { animation: none; } }

      .alc-more { text-align: center; margin-top: 16px; }
      .alc-inline-btn {
        font: inherit; font-size: 0.85rem; color: var(--accent); background: transparent;
        border: 1px solid var(--line); padding: 9px 18px; cursor: pointer; transition: 140ms ease;
      }
      .alc-inline-btn:hover { background: rgba(255,170,100,0.1); border-color: var(--accent); }

      @media (max-width: 620px) {
        .alc-charts { grid-template-columns: 1fr; }
        .alc-count { margin-left: 0; width: 100%; }
      }
    `}</style>
  );
}
