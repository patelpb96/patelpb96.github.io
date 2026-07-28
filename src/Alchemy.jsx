import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * RuneScape 3 high-alchemy dashboard.
 *
 * Reads the JSON exported by the `rs_alchemy` scraper (staged under
 * public/rs-alchemy/data). The big files are fetched lazily, behind a click,
 * the same way the site gates its heavy image graphics:
 *
 *   latest.json            newest row per item, ranked by alch profit (~1.9 MB)
 *   meta.json              run provenance (tiny)
 *   history/<id>.json      one item's daily {t, price, volume, profit, roi}
 *
 * Everything renders from that data with plain SVG charts, so the page adds no
 * new dependencies to the site.
 */

const DATA_BASE = "/rs-alchemy/data";
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

// ---- column configuration -------------------------------------------------

const COLUMNS = [
  { key: "name", label: "Item", align: "left", kind: "text" },
  { key: "price", label: "Price", align: "right", kind: "gp" },
  { key: "highalch", label: "High alch", align: "right", kind: "gp" },
  { key: "alch_profit", label: "Profit", align: "right", kind: "gp", signed: true },
  { key: "alch_roi", label: "ROI", align: "right", kind: "pct", signed: true },
  { key: "profit_per_limit", label: "Profit / limit", align: "right", kind: "gp", signed: true },
  { key: "volume", label: "Volume", align: "right", kind: "gp" },
];

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
    fetch(`${DATA_BASE}/history/${item.item_id}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`history ${res.status}`);
        return res.json();
      })
      .then((points) => {
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
  const text = column.kind === "pct" ? formatPct(value) : formatGp(value);
  const title = column.kind === "pct" ? undefined : formatFull(value);
  return <td className={`alc-td alc-num ${signed}`} title={title}>{text}</td>;
}

// ---- dashboard ------------------------------------------------------------

export default function AlchemyDashboard() {
  const [phase, setPhase] = useState("idle"); // idle -> loading -> ready | error
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [query, setQuery] = useState("");
  const [membership, setMembership] = useState("all"); // all | members | f2p
  const [profitableOnly, setProfitableOnly] = useState(false);
  const [sort, setSort] = useState({ key: "alch_profit", dir: "desc" });
  const [limit, setLimit] = useState(PAGE);
  const [selectedId, setSelectedId] = useState(null);
  const historyCache = useRef(new Map());

  const load = () => {
    setPhase("loading");
    Promise.all([
      fetch(`${DATA_BASE}/latest.json`).then((r) => {
        if (!r.ok) throw new Error(`latest ${r.status}`);
        return r.json();
      }),
      fetch(`${DATA_BASE}/meta.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([latest, metaJson]) => {
        const arr = Array.isArray(latest) ? latest : [];
        // Precompute a lowercased name once so search doesn't re-lowercase
        // ~7,000 names on every keystroke.
        setRows(arr.map((r) => ({ ...r, _search: (r.name || "").toLowerCase() })));
        setMeta(metaJson);
        setPhase("ready");
      })
      .catch(() => setPhase("error"));
  };

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter((r) => r._search.includes(q));
    if (membership === "members") out = out.filter((r) => r.members);
    else if (membership === "f2p") out = out.filter((r) => !r.members);
    if (profitableOnly) out = out.filter((r) => isNum(r.alch_profit) && r.alch_profit > 0);
    return [...out].sort(compareBy(sort.key, sort.dir));
  }, [rows, query, membership, profitableOnly, sort]);

  const visible = filtered.slice(0, limit);

  // Filter changes shrink/reshape the result set, so snap the window back to the top.
  const resetWindow = () => setLimit(PAGE);
  const onQuery = (value) => { setQuery(value); resetWindow(); };
  const onMembership = (value) => { setMembership(value); resetWindow(); };
  const onProfitableOnly = (value) => { setProfitableOnly(value); resetWindow(); };

  const toggleSort = (key) => {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      // Text defaults to A–Z, numbers to high-to-low.
      return { key, dir: key === "name" ? "asc" : "desc" };
    });
  };

  return (
    <div className="alchemy">
      <AlchemyStyles />

      {phase === "idle" && (
        <button className="lazy-graphic alc-load" type="button" onClick={load}>
          <span>Load alchemy data</span>
          <small>~1.9 MB · 7,000+ items</small>
        </button>
      )}

      {phase === "loading" && <div className="alc-msg">Fetching current Grand Exchange prices…</div>}

      {phase === "error" && (
        <div className="alc-msg">
          Could not load the alchemy data.{" "}
          <button className="alc-inline-btn" type="button" onClick={load}>Retry</button>
        </div>
      )}

      {phase === "ready" && rows && (
        <>
          <p className="alc-intro prose">
            High Level Alchemy turns an item into gp: <code>profit = high&nbsp;alch − price − nature&nbsp;rune</code>.
            These are current Grand Exchange prices for {formatFull(rows.length)} items{meta?.last_timestamp ? `, last scraped ${meta.last_timestamp.slice(0, 10)}` : ""}.
            Click any row for its full price history. Data via the{" "}
            <a href="https://prices.runescape.wiki/rs/alchemy" target="_blank" rel="noreferrer">RuneScape wiki exchange</a>.
          </p>

          <div className="alc-controls">
            <input
              className="alc-search"
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search items…"
              aria-label="Search items by name"
            />
            <div className="alc-toggle-group" role="group" aria-label="Membership filter">
              {[["all", "All"], ["members", "P2P"], ["f2p", "F2P"]].map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  className={`alc-toggle ${membership === value ? "is-active" : ""}`}
                  onClick={() => onMembership(value)}
                >
                  {text}
                </button>
              ))}
            </div>
            <label className="alc-check">
              <input type="checkbox" checked={profitableOnly} onChange={(e) => onProfitableOnly(e.target.checked)} />
              Profitable only
            </label>
            <span className="alc-count" role="status" aria-live="polite">{formatFull(filtered.length)} matches</span>
          </div>

          <div className="alc-table-wrap">
            <table className="alc-table">
              <thead>
                <tr>
                  <th className="alc-th alc-th-rank" scope="col">#</th>
                  {COLUMNS.map((col) => {
                    const active = sort.key === col.key;
                    return (
                      <th key={col.key} scope="col" className={`alc-th alc-th-${col.align}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className={`alc-sort ${active ? "is-active" : ""}`} onClick={() => toggleSort(col.key)}>
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
                        {COLUMNS.map((col) => (
                          <Cell key={col.key} column={col} item={item} expanded={isOpen} detailId={detailId} onToggle={toggle} />
                        ))}
                      </tr>
                      {isOpen && (
                        <tr className="alc-detail-row">
                          <td colSpan={COLUMNS.length + 1}>
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
                  <tr><td className="alc-td alc-empty" colSpan={COLUMNS.length + 1}>No items match your filters.</td></tr>
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
      .alc-load { margin: 0; }
      .alc-msg { padding: 22px; text-align: center; color: var(--muted); border: 1px solid var(--line); background: rgba(30,14,8,0.6); }
      .alc-intro { margin: 0 0 20px; }
      .alc-intro code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; color: var(--accent-soft); background: rgba(255,170,100,0.10); padding: 1px 6px; }
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
      .alc-count { margin-left: auto; color: var(--dim); font-size: 0.82rem; }

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
      .alc-num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86rem; }
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
      .alc-stat-value { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.05rem; font-weight: 700; color: var(--text); }

      .alc-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .alc-chart { margin: 0; }
      .alc-chart-cap { display: flex; justify-content: space-between; align-items: baseline; color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
      .alc-chart-last { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
      .alc-chart svg { width: 100%; height: 180px; display: block; background: rgba(20,10,6,0.5); border: 1px solid var(--line); }
      .alc-chart-zero { stroke: rgba(255,210,170,0.35); stroke-width: 1; stroke-dasharray: 4 4; }
      .alc-chart-axis { display: flex; justify-content: space-between; gap: 8px; color: var(--dim); font-size: 0.7rem; margin-top: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .alc-chart-range { color: var(--muted); }
      .alc-chart-empty { color: var(--dim); font-size: 0.85rem; padding: 40px 0; text-align: center; border: 1px solid var(--line); background: rgba(20,10,6,0.5); }
      .alc-detail-note { color: var(--dim); font-size: 0.78rem; margin: 16px 0 0; line-height: 1.6; }

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
