import { useEffect, useMemo, useState } from "react";
import "./models-themes.css";
import "./models.css";
import "./models-effort.css";
import { LOGOS } from "./models-logos.js";
import {
  DATA_URL, LADDER, X_OPTIONS, allEfforts, effortHalf, effortLabel, fmtValue, fmtX, frontier, labColor, ladderGain,
  logTicks, modelLabel, newestPerClass, niceTicks, placeLabels, visiblePoints, yMetrics,
} from "./models-effort-data.js";

// The "Frontier effort comparison" page: every reasoning-effort setting of the frontier OpenAI, Anthropic and Google
// models on one chart, from Artificial Analysis's published rows. Kept apart from ModelsPage.jsx on purpose (a few small
// helpers are copied below) so the main tracker page stays exactly as it is. It shares that page's themes and CSS.

const THEME_KEY = "models-theme";          // the same keys as the main page, so a theme chosen there carries over
const TYPE_KEY = "models-type";
const THEMES = [["ember", "Ember"], ["walnut", "Walnut"], ["space", "Space"], ["8bit", "8-Bit"], ["paper", "Paper"], ["ink", "Ink"]];
const SERIF_THEMES = ["paper", "ink"];
const ROOMY = typeof window !== "undefined" && window.innerWidth >= 720;

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

// A model's name: the base word with its version (or, for Gemini 4, the element symbol) as a subscript.
function Name({ label }) {
  return <span className="lm">{label.base}<sub>{label.sub}</sub></span>;
}

function OrgMark({ org, color, size = 14 }) {
  const paths = LOGOS[org];
  return (
    <svg className="omark" width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true">
      {paths ? (
        <g transform="translate(-12 -12)" fill={color} fillRule="evenodd">{paths.map((d) => <path key={d.slice(0, 24)} d={d} />)}</g>
      ) : <rect x={-8} y={-8} width={16} height={16} fill={color} />}
    </svg>
  );
}

// Charts are drawn at the size they are shown (one SVG unit = one CSS pixel), so text stays readable on a phone.
function useChartSize() {
  const [node, setNode] = useState(null);
  const [width, setWidth] = useState(() => Math.min(900, (typeof window !== "undefined" ? window.innerWidth : 900) - 62));
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  const W = Math.max(300, Math.min(width, 1600));
  return [setNode, W, W < 560 ? 430 : Math.round(Math.min(700, W * 0.56))];
}

function Fold({ id, title, meta, defaultOpen = false, children }) {
  const key = `models-effort-fold-${id}`;
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

// The point a ladder is labelled at: its highest setting on the line, else its only setting.
const anchorOf = (pts) => [...pts].reverse().find((p) => LADDER.has(p.effort)) || pts[pts.length - 1];
const textWidth = (label, fs) => (label.base.length + label.sub.length * 0.72) * fs * 0.62 + 6;

function EffortChart({ models, xId, yMetric, efforts, hl, hover, setHover, pinned, togglePin }) {
  const yId = yMetric.id;
  const [sizeRef, W, H] = useChartSize();
  const narrow = W < 560;
  const FT = narrow ? 13 : 16, FL = narrow ? 14 : 18, FS = narrow ? 12 : 14;
  const M = { l: Math.round(FT * 2.6 + FL + 14), r: narrow ? 14 : 30, t: 14, b: FT + FL + 26 };
  const xName = X_OPTIONS.find(([id]) => id === xId)[1];

  const series = useMemo(
    () => models.map((m) => ({ m, label: modelLabel(m), pts: visiblePoints(m, { xId, yId, efforts }) })).filter((s) => s.pts.length),
    [models, xId, yId, efforts],
  );
  const all = useMemo(() => series.flatMap((s) => s.pts), [series]);
  const front = useMemo(() => frontier(all), [all]);
  if (!all.length) return <p className="empty">Nothing to draw: no visible setting has both {xName.toLowerCase()} and {yMetric.name} yet.</p>;

  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const xlo = Math.min(...xs) * 0.8, xhi = Math.max(...xs) * 1.3;
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const pad = Math.max((ymax - ymin) * 0.06, 1);
  const lo = ymin >= 0 ? Math.max(0, ymin - pad) : ymin - pad;
  const hi = ymax <= 100 ? Math.min(100, ymax + pad) : ymax + pad;
  const yTicks = niceTicks(lo, hi, narrow ? 6 : 8);
  const ylo = yTicks[0], yhi = yTicks[yTicks.length - 1];
  const xTicks = logTicks(xlo, xhi, narrow ? 5 : 9);
  const fx = (v) => M.l + ((Math.log(v) - Math.log(xlo)) / (Math.log(xhi) - Math.log(xlo))) * (W - M.l - M.r);
  const fy = (v) => H - M.b - ((v - ylo) / (yhi - ylo)) * (H - M.t - M.b);
  const xTick = (v) => (xId === "aa_cost_per_task" ? `$${v}` : `${v}`);

  const showAll = !narrow || series.length <= 8;
  const placed = placeLabels(
    series.filter((s) => showAll || hl.has(s.m.model_id)).map((s) => {
      const a = anchorOf(s.pts);
      return { id: s.m.model_id, x: fx(a.x), y: fy(a.y), w: textWidth(s.label, FS) };
    }),
    { gap: FS + 3, width: W, top: M.t + FS, bottom: H - M.b - 4 },
  );
  const rank = (s) => (hl.has(s.m.model_id) ? 1 : 0);
  const drawn = [...series].sort((a, b) => rank(a) - rank(b));

  const hs = hover && series.find((s) => s.m.model_id === hover.id);
  const hp = hs && (hs.pts.find((p) => p.effort === hover.effort) || anchorOf(hs.pts));
  const aria = (s) => {
    const line = s.pts.filter((p) => LADDER.has(p.effort));
    const ends = line.length > 1 ? `${effortLabel(line[0].effort)} ${fmtValue(yMetric, line[0].y)} at ${fmtX(xId, line[0].x)} to ${effortLabel(line[line.length - 1].effort)} ${fmtValue(yMetric, line[line.length - 1].y)} at ${fmtX(xId, line[line.length - 1].x)}` : `${effortLabel(s.pts[0].effort)} ${fmtValue(yMetric, s.pts[0].y)} at ${fmtX(xId, s.pts[0].x)}`;
    return `${s.label.text}, ${s.pts.length} setting${s.pts.length === 1 ? "" : "s"}: ${ends}`;
  };

  return (
    <div className="chart-wrap" ref={sizeRef}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${yMetric.name} against ${xName.toLowerCase()}, one line per model through its effort settings`}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={fy(v)} y2={fy(v)} />
            <text className="tick" x={M.l - 8} y={fy(v) + FT * 0.35} textAnchor="end" style={{ fontSize: FT }}>{v}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            <line className="grid" x1={fx(v)} x2={fx(v)} y1={M.t} y2={H - M.b} />
            <text className="tick" x={fx(v)} y={H - M.b + FT + 6} textAnchor="middle" style={{ fontSize: FT }}>{xTick(v)}</text>
          </g>
        ))}
        <line className="axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
        <line className="axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
        <text className="axlabel" x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" style={{ fontSize: FL }}>
          {xId === "aa_cost_per_task" ? "Cost per task, USD (log scale)" : "Time per task, minutes (log scale)"}
        </text>
        <text className="axlabel" x={FL} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 ${FL} ${(M.t + H - M.b) / 2})`} style={{ fontSize: FL }}>{yMetric.name}</text>

        {front.length > 1 && <polyline className="frontier" pointerEvents="none" points={front.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ")} />}

        {drawn.map((s) => {
          const id = s.m.model_id;
          const on = hl.has(id);
          const dim = hl.size > 0 && !on;
          const color = labColor(s.m.org);
          const line = s.pts.filter((p) => LADDER.has(p.effort));
          const lineAt = line.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ");
          const top = anchorOf(s.pts);
          return (
            <g key={id} className={`ef${dim ? " dim" : ""}`} tabIndex={0} role="button" aria-pressed={pinned.has(id)} aria-label={aria(s)}
              onClick={() => togglePin(id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(id); } }}
              onFocus={() => setHover({ id, effort: top.effort })} onBlur={() => setHover(null)}>
              {line.length > 1 && (
                <>
                  <polyline className="ladder-hit" points={lineAt} onPointerEnter={() => setHover({ id })} onPointerLeave={() => setHover(null)} />
                  <polyline className="ladder" stroke={color} strokeWidth={on ? 3 : 1.75} points={lineAt} pointerEvents="none" />
                </>
              )}
              {s.pts.map((p) => {
                const h = effortHalf(p.effort);
                return (
                  <g key={p.effort} transform={`translate(${fx(p.x)} ${fy(p.y)})`} onPointerEnter={() => setHover({ id, effort: p.effort })} onPointerLeave={() => setHover(null)}>
                    <rect x={-h - 6} y={-h - 6} width={2 * h + 12} height={2 * h + 12} fill="transparent" />
                    {!s.m.live && <rect className="ef-ring" x={-h - 3.5} y={-h - 3.5} width={2 * h + 7} height={2 * h + 7} />}
                    <rect className="ef-mk" x={-h} y={-h} width={2 * h} height={2 * h} fill={p.effort === "none" ? "var(--bg)" : color} stroke={color} />
                    {on && <rect className="ef-on" x={-h - 2} y={-h - 2} width={2 * h + 4} height={2 * h + 4} />}
                  </g>
                );
              })}
            </g>
          );
        })}

        {series.filter((s) => placed.has(s.m.model_id)).map((s) => {
          const id = s.m.model_id;
          const a = anchorOf(s.pts);
          const at = placed.get(id);
          const dim = hl.size > 0 && !hl.has(id);
          return (
            <g key={`t${id}`} pointerEvents="none" className={dim ? "dim" : ""}>
              {at.moved && <line className="leader" x1={fx(a.x)} y1={fy(a.y)} x2={at.x + (at.anchor === "start" ? -2 : 2)} y2={at.y - FS * 0.35} />}
              <text className="plabel" x={at.x} y={at.y} textAnchor={at.anchor} style={{ fontSize: FS }}>
                {s.label.base}<tspan className="sub" dy={FS * 0.28} style={{ fontSize: FS * 0.72 }}>{s.label.sub}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
      {hp && (
        <div className={`tip${fx(hp.x) > W * 0.62 ? " flip" : ""}`} role="status" style={{ left: `${(fx(hp.x) / W) * 100}%`, top: `${(fy(hp.y) / H) * 100}%` }}>
          <b>{hs.m.display_name}</b><br />
          {hs.m.org} · <Name label={hs.label} /><br />
          Effort: {effortLabel(hp.effort)}<br />
          {yMetric.name}: {fmtValue(yMetric, hp.y)}<br />
          Cost per task: {fmtValue({ unit: "USD" }, hp.values.aa_cost_per_task)}<br />
          {hp.values.aa_time_per_task != null && <>Time per task: {fmtValue({ unit: "minutes" }, hp.values.aa_time_per_task)}<br /></>}
          <span className="muted">{hs.m.live ? `Artificial Analysis, ${hp.observed_at}` : `No longer listed by AA; last seen ${hs.m.last_seen}`}</span>
        </div>
      )}
    </div>
  );
}

function Dashboard({ data, intro }) {
  const efforts = useMemo(() => allEfforts(data), [data]);
  const yList = useMemo(() => yMetrics(data), [data]);
  const labs = useMemo(() => [...new Set(data.models.map((m) => m.org))].sort(), [data]);
  const [shownEfforts, setShownEfforts] = useState(() => new Set(efforts));
  const [shownModels, setShownModels] = useState(() => new Set(data.models.map((m) => m.model_id)));
  const [yPick, setYPick] = useState("aa_intelligence_index");
  const [xId, setXId] = useState("aa_cost_per_task");
  const [pinned, setPinned] = useState(() => new Set());
  const [hover, setHover] = useState(null);

  const yMetric = yList.find((m) => m.id === yPick) || yList[0];
  const models = useMemo(() => data.models.filter((m) => shownModels.has(m.model_id)), [data, shownModels]);
  const hl = useMemo(() => new Set([...pinned, ...(hover ? [hover.id] : [])]), [pinned, hover]);
  const byId = useMemo(() => new Map(data.models.map((m) => [m.model_id, m])), [data]);

  const flip = (set, v) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const toggleModel = (id) => setShownModels((s) => flip(s, id));
  const toggleEffort = (e) => setShownEfforts((s) => flip(s, e));
  const togglePin = (id) => setPinned((s) => flip(s, id));
  const toggleLab = (org) => setShownModels((s) => {
    const ids = data.models.filter((m) => m.org === org).map((m) => m.model_id);
    const n = new Set(s);
    if (ids.every((id) => n.has(id))) ids.forEach((id) => n.delete(id)); else ids.forEach((id) => n.add(id));
    return n;
  });
  const preset = (kind) => setShownModels(
    kind === "all" ? new Set(data.models.map((m) => m.model_id))
      : kind === "live" ? new Set(data.models.filter((m) => m.live).map((m) => m.model_id))
        : newestPerClass(data.models),
  );

  const unit = yMetric.unit === "%" ? " pts" : "";
  const rows = models.map((m) => ({ m, label: modelLabel(m), pts: visiblePoints(m, { xId, yId: yMetric.id, efforts: shownEfforts }) }));
  const selected = [...pinned].map((id) => byId.get(id)).filter(Boolean).map((m) => modelLabel(m).text);
  const xName = X_OPTIONS.find(([id]) => id === xId)[1];

  return (
    <>
      {intro}

      <section className="mt-panel mt-hero" aria-label="Score against cost for every effort setting">
        <div className="pane-tools">
          <label className="lbl">Score{" "}
            <select value={yMetric.id} onChange={(e) => setYPick(e.target.value)}>
              {yList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <span className="lbl">against</span>
          <div className="seg" role="group" aria-label="Horizontal axis">
            {X_OPTIONS.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={xId === id} onClick={() => setXId(id)}>{label}</button>
            ))}
          </div>
        </div>
        <EffortChart models={models} xId={xId} yMetric={yMetric} efforts={shownEfforts} hl={hl} hover={hover} setHover={setHover} pinned={pinned} togglePin={togglePin} />
        {selected.length > 0 && (
          <p className="sel-list">
            <span>Highlighted: {selected.join(", ")}</span>
            <button type="button" className="chip" onClick={() => setPinned(new Set())}>Clear</button>
          </p>
        )}
        <div className="legend" aria-label="Chart legend">
          <span className="legend-sizes" aria-hidden="true">
            {["low", "medium", "high", "xhigh", "max"].filter((e) => efforts.includes(e)).map((e) => (
              <svg key={e} width="18" height="18" viewBox="-9 -9 18 18"><rect x={-effortHalf(e)} y={-effortHalf(e)} width={2 * effortHalf(e)} height={2 * effortHalf(e)} fill="currentColor" /></svg>
            ))}
          </span>
          <span>Bigger square = more effort (low to max)</span>
          <span><svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><rect x={-4} y={-4} width={8} height={8} fill="none" stroke="currentColor" strokeWidth="1.75" /></svg>Hollow: no reasoning</span>
          <span><svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><rect x={-9} y={-9} width={18} height={18} fill="none" stroke="currentColor" strokeDasharray="2 2" /><rect x={-5} y={-5} width={10} height={10} fill="currentColor" /></svg>Dashed ring: AA no longer lists it</span>
          <span><svg width="26" height="8" aria-hidden="true"><line className="frontier" x1="0" y1="4" x2="26" y2="4" /></svg>Efficient frontier</span>
          {labs.map((org) => <span key={org}><OrgMark org={org} color={labColor(org)} />{org}</span>)}
        </div>
        <Fold id="explain" title="How to read this chart" meta={`${yMetric.name} vs ${xName.toLowerCase()}`} defaultOpen={ROOMY}>
          <dl className="explain">
            <dt>One line per model</dt>
            <dd>Each line joins a model's published effort settings from lowest to highest. Reading a line left to right shows what extra thinking cost and what it bought; a steep climb means the model gets a lot from more effort, a flat run means it does not.</dd>
            <dt>{yMetric.name} (vertical)</dt>
            <dd>{yMetric.blurb} Higher is better.</dd>
            <dt>{xName} (horizontal, log scale)</dt>
            <dd>{xId === "aa_cost_per_task" ? "What it cost Artificial Analysis to run the Intelligence Index tasks at that setting, at list prices." : "How long those tasks took at that setting."} Each step right is a multiple, not a fixed amount, so $0.10 to $1 is the same distance as $1 to $10. Up and to the left is better.</dd>
            <dt>Names</dt>
            <dd>The small number is the model's version (Astra<sub>6.2</sub> is GPT-6.2 Astra, Opus<sub>5.5</sub> is Claude Opus 5.5). Gemini 4 models are named by the chemical symbol of their class (Gemini<sub>Ar</sub> is Gemini 4 Argon).</dd>
          </dl>
          <p className="fold-p">Hover a square for its exact numbers, or click a line to highlight it. A line can double back: more effort does not always cost more, or score more, for every model.</p>
        </Fold>
      </section>

      <div className="folds">
        <Fold id="models" title="Models" meta={`${models.length} of ${data.models.length} shown`} defaultOpen={ROOMY}>
          <div className="mt-filters">
            <div className="seg" role="group" aria-label="Quick selections">
              <button type="button" onClick={() => preset("all")}>All</button>
              <button type="button" onClick={() => preset("newest")}>Newest of each class</button>
              <button type="button" onClick={() => preset("live")}>Listed by AA now</button>
            </div>
          </div>
          <div className="eff-groups">
            {labs.map((org) => {
              const list = data.models.filter((m) => m.org === org);
              const allOn = list.every((m) => shownModels.has(m.model_id));
              return (
                <div key={org} className="eff-group">
                  <button type="button" className="chip eff-lab" aria-pressed={allOn} onClick={() => toggleLab(org)} title={`Show or hide every ${org} model`}>
                    <OrgMark org={org} color="var(--ink)" />{org}
                  </button>
                  {list.map((m) => {
                    const label = modelLabel(m);
                    return (
                      <button key={m.model_id} type="button" className="chip" aria-pressed={shownModels.has(m.model_id)}
                        title={`${m.display_name}${m.live ? "" : ` (single setting; last listed by AA on ${m.last_seen})`}`}
                        onClick={() => toggleModel(m.model_id)} onPointerEnter={() => setHover({ id: m.model_id })} onPointerLeave={() => setHover(null)}>
                        <svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" fill={labColor(m.org)} /></svg>
                        <Name label={label} />
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </Fold>

        <Fold id="efforts" title="Effort levels" meta={`${shownEfforts.size} of ${efforts.length} shown`} defaultOpen={ROOMY}>
          <div className="chips">
            {efforts.map((e) => (
              <button key={e} type="button" className="chip" aria-pressed={shownEfforts.has(e)} onClick={() => toggleEffort(e)}>
                <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true"><rect x={-effortHalf(e)} y={-effortHalf(e)} width={2 * effortHalf(e)} height={2 * effortHalf(e)} fill={e === "none" ? "none" : "currentColor"} stroke="currentColor" strokeWidth="1.5" /></svg>
                {effortLabel(e)}
              </button>
            ))}
          </div>
        </Fold>

        <Fold id="about" title="About this data" meta={`as of ${data.as_of}`}>
          <p className="mt-note">{data.note}</p>
          <p className="fold-p" style={{ marginTop: 8 }}>
            Source: <a href={data.source.url}>{data.source.name}</a> ({data.counts.settings} settings across {data.counts.models} models; {data.counts.live} listed on the latest day).
            Companies and versions covered: OpenAI GPT-6 and later, Anthropic Claude 5 and later, Google Gemini 3.8 and later. New models in those families appear on the next data refresh.
          </p>
        </Fold>
      </div>

      <section className="mt-panel">
        <div className="pane-tools">
          <span className="lbl">Every setting</span>
          <span className="muted">{yMetric.name} (and {xName.toLowerCase()}) · click a row to highlight it</span>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                {efforts.filter((e) => shownEfforts.has(e)).map((e) => <th key={e}>{effortLabel(e)}</th>)}
                <th title="From the lowest to the highest setting on the line">Gain, low to top</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, label, pts }) => {
                const g = ladderGain(pts);
                const at = new Map(pts.map((p) => [p.effort, p]));
                return (
                  <tr key={m.model_id} className={`eff-row${hl.has(m.model_id) ? " is-hl" : hl.size ? " is-dim" : ""}`} style={{ "--c": labColor(m.org) }} onClick={() => togglePin(m.model_id)}>
                    <td><span className="mname"><OrgMark org={m.org} color={labColor(m.org)} /><Name label={label} /><span className="muted">{m.display_name}{m.live ? "" : " · not listed now"}</span></span></td>
                    {efforts.filter((e) => shownEfforts.has(e)).map((e) => {
                      const p = at.get(e);
                      return p ? (
                        <td key={e} title={`${m.display_name}, ${effortLabel(e)}: ${fmtValue(yMetric, p.y)} at ${fmtX(xId, p.x)}`}>
                          <span className="cell-v">{fmtValue(yMetric, p.y)}</span><span className="cell-c muted">{fmtX(xId, p.x)}</span>
                        </td>
                      ) : <td key={e} className="na">not listed</td>;
                    })}
                    {g ? <td><span className="cell-v">{g.dy >= 0 ? "+" : "−"}{Math.abs(g.dy).toFixed(1)}{unit}</span><span className="cell-c muted">{g.mult.toFixed(1)}× the {xName.toLowerCase().replace(" per task", "")}</span></td> : <td className="na">one setting</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function EffortPage() {
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

  const intro = (
    <header className="mt-head">
      <div>
        <h1 className="mt-title">Frontier effort comparison</h1>
        <p className="mt-sub">
          What each frontier model scores, and costs, at every reasoning-effort setting. Data from{" "}
          <a href="https://artificialanalysis.ai/">Artificial Analysis</a>. <a href="/projects/models/">Model tracker</a> · <a href="/">patelpb.com</a>
        </p>
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
