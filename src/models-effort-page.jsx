import { memo, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import "./models-effort.css";
import { LOGOS } from "./models-logos.js";
import {
  DATA_URL, EFFORT_SHORT, LADDER, LAB_SHAPE, X_OPTIONS, allEfforts, domainOf, effortHalf, effortLabel, fmtValue, fmtX, frontier,
  labColor, ladderGain, logTicks, markPath, modelLabel, niceTicks, placeLabels, segDist, stairPath, visiblePoints, yMetrics,
} from "./models-effort-data.js";
import { keepInside, useMobileVariant, useNarrow } from "./models-mobile.js";

// The "Reasoning effort" view of the model tracker (the second tab, loaded on demand): every effort setting of the frontier
// OpenAI, Anthropic and Google models on one chart, from Artificial Analysis's published rows. It shares the tracker's themes
// and CSS. Pointer handling is one distance-based hit test on the chart wrapper, and the highlight is a CSS class toggled on the
// DOM, so moving the mouse never re-renders React.

const DEFAULT_FOCUS = "anthropic/claude-sonnet-5-5";      // the pre-selected line, so the first look explains itself
const MOUSE_R = 12, TOUCH_R = 24, LINE_R = 4, STICKY = 3;  // pixels

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: keep the in-memory choice */ }
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

// The company's marker shape in its colour: square (OpenAI), diamond (Anthropic), triangle (Google).
function Swatch({ org, size = 12, hollow }) {
  return (
    <svg width={size} height={size} viewBox="-8 -8 16 16" aria-hidden="true" style={{ flex: "none" }}>
      <path d={markPath(LAB_SHAPE[org] || "square", 5)} fill={hollow ? "none" : labColor(org)} stroke={labColor(org)} strokeWidth="1.5" />
    </svg>
  );
}

function useChartSize(wide, tall) {
  const [node, setNode] = useState(null);
  const [width, setWidth] = useState(() => Math.min(900, (typeof window !== "undefined" ? window.innerWidth : 900) - 62));
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([e]) => { if (e.contentRect.width > 0) setWidth(Math.round(e.contentRect.width)); });   // 0 = tab hidden
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  const W = Math.max(300, Math.min(width, 1600));
  return [setNode, W, W < 560 ? (tall ? Math.round(Math.min(600, W * 1.2)) : 380) : Math.round(Math.min(wide ? 700 : 480, W * (wide ? 0.56 : 0.8)))];
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
const textWidth = (label, fs, extra = 0) => (label.base.length + label.sub.length * 0.72 + extra) * fs * 0.72 + 10;   // bold serif runs wide; err long so labels flip before they clip

// The one tooltip. It owns its own state, so showing it re-renders only this component, never the chart or the page.
function Tip({ ref, lookup, yMetric, W, H }) {
  const [t, setT] = useState(null);
  useImperativeHandle(ref, () => ({ show: setT }), []);
  const f = t && lookup(t.id, t.effort);
  if (!f) return null;
  const { s, p } = f;
  const body = (
    <>
      <b>{s.m.display_name}</b><br />
      <Name label={s.label} /> · {effortLabel(p.effort)}<br />
      {yMetric.name}: {fmtValue(yMetric, p.y)}<br />
      {yMetric.id === "superscore" && <>{p.values.aa_output_speed.toFixed(0)} tok/s · ${p.values.aa_price_blended} per 1M · non-halluc. {fmtValue({ unit: "%" }, p.values.aa_non_hallucination)}<br /></>}
      Cost per task: {fmtValue({ unit: "USD" }, p.values.aa_cost_per_task)}
      {p.values.aa_time_per_task != null && <> · {fmtValue({ unit: "minutes" }, p.values.aa_time_per_task)}</>}<br />
      <span className="muted">{s.m.live ? `Artificial Analysis, ${p.observed_at}` : `No longer listed by AA; last seen ${s.m.last_seen}`}</span>
    </>
  );
  if (t.dock) return <div className="tip-dock" role="status">{body}</div>;
  return <div className={`tip${t.px > W * 0.62 ? " flip" : ""}`} role="status" style={{ left: `${(t.px / W) * 100}%`, top: `${(t.py / H) * 100}%` }}>{body}</div>;
}

// Phone layouts (models-mobile.js): `phone` keeps labels inside the plot; `spot` (variant A) is the set of models drawn in colour
// and named, the rest stay grey and small until tapped.
const EffortChart = memo(function EffortChart({ models, ghosts, dom, xId, yMetric, efforts, pinned, onPin, onClearPins, wide, phone, spot }) {
  const yId = yMetric.id;
  const [sizeRef, W, H] = useChartSize(wide, !!spot);
  const narrow = W < 560;
  const FT = narrow ? 12 : 15, FL = narrow ? 13 : 17, FS = narrow ? 12 : 14;
  // Phone layouts put the vertical axis title above the plot, so the left margin only holds the tick numbers.
  const M = useMemo(() => (phone && narrow
    ? { l: Math.round(FT * 2.4 + 10), r: 8, t: FL + 12, b: FT + FL + 20 }
    : { l: Math.round(FT * 2.6 + FL + 12), r: narrow ? 14 : 30, t: 14, b: FT + FL + 24 }), [FT, FL, narrow, phone]);
  const xName = X_OPTIONS.find(([id]) => id === xId)[1];

  const svgRef = useRef(null);
  const clipId = `efclip${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const groups = useRef(new Map());          // model id -> its <g>, to toggle classes without React
  const raiseRef = useRef(null);             // <use> that draws the hot line on top
  const tipRef = useRef(null);
  const liveRef = useRef(null);
  const hot = useRef(null);                  // {id, effort|null, px, py}
  const frame = useRef(0);
  const last = useRef(null);
  const kb = useRef({ m: 0, e: -1 });

  const geo = useMemo(() => {
    const series = models.map((m, i) => ({ m, i, label: modelLabel(m), pts: visiblePoints(m, { xId, yId, efforts }) })).filter((s) => s.pts.length);
    const all = series.flatMap((s) => s.pts);
    if (!all.length) return null;
    const ghostLines = ghosts.map((m) => visiblePoints(m, { xId, yId, efforts }).filter((p) => LADDER.has(p.effort))).filter((l) => l.length > 1);
    const d = dom || domainOf(all);
    const yTicks = niceTicks(d.lo, d.hi, narrow ? 6 : 8);
    const ylo = yTicks[0], yhi = yTicks[yTicks.length - 1];
    const fx = (v) => M.l + ((Math.log(v) - Math.log(d.xlo)) / (Math.log(d.xhi) - Math.log(d.xlo))) * (W - M.l - M.r);
    const fy = (v) => H - M.b - ((v - ylo) / (yhi - ylo)) * (H - M.t - M.b);
    const front = frontier(all);
    const hits = [], segs = [], byId = new Map();
    for (const s of series) {
      byId.set(s.m.model_id, s);
      s.line = s.pts.filter((p) => LADDER.has(p.effort));
      s.gid = `ef-${s.i}`;
      for (const p of s.pts) {
        const px = fx(p.x), py = fy(p.y);
        if (spot && (px < M.l || px > W - M.r || py < M.t || py > H - M.b)) continue;     // zoomed (A): off-plot settings are clipped, not tappable
        hits.push({ id: s.m.model_id, effort: p.effort, px, py });
      }
      for (let k = 1; k < s.line.length; k++) segs.push({ id: s.m.model_id, x1: fx(s.line[k - 1].x), y1: fy(s.line[k - 1].y), x2: fx(s.line[k].x), y2: fy(s.line[k].y) });
    }
    const labItems = series.filter((s) => !spot || spot.has(s.m.model_id) || pinned.has(s.m.model_id))
      .map((s) => { const a = anchorOf(s.pts); return { id: s.m.model_id, x: fx(a.x), y: fy(a.y), w: textWidth(s.label, FS, s.m.live ? 0 : 1) }; });
    const labels = placeLabels(labItems,
      { gap: FS + 3, width: W, top: M.t + FS, bottom: H - M.b - 4, obstacles: hits.map((h) => ({ id: h.id, x: h.px, y: h.py, r: 9 })), left: phone ? M.l + 2 : undefined },
    );
    if (phone) keepInside(labels, labItems, W, 4, FS + 3);
    return { series, byId, ghostLines, yTicks, xTicks: logTicks(d.xlo, d.xhi, narrow ? 5 : 9), fx, fy, front, hits, segs, labels };
  }, [models, ghosts, dom, xId, yId, efforts, W, H, M, FS, narrow, phone, spot, pinned]);

  const lookup = useCallback((id, effort) => {
    const s = geo && geo.byId.get(id);
    const p = s && s.pts.find((q) => q.effort === effort);
    return p ? { s, p } : null;
  }, [geo]);

  // Highlight: toggle classes on the DOM and tell the tooltip; nothing here goes through React state.
  const setHot = useCallback((t) => {
    const cur = hot.current;
    if (cur === t || (cur && t && cur.id === t.id && cur.effort === t.effort)) return;
    hot.current = t;
    if (cur) groups.current.get(cur.id)?.classList.remove("is-hot");
    if (t) groups.current.get(t.id)?.classList.add("is-hot");
    svgRef.current?.classList.toggle("has-hot", !!t);
    const u = raiseRef.current, s = t && geo && geo.byId.get(t.id);
    if (u) { if (s) u.setAttribute("href", `#${s.gid}`); else u.removeAttribute("href"); }
    tipRef.current?.show(t && t.effort ? t : null);
  }, [geo]);

  // What is under (cx, cy): the nearest marker within the radius, else a line within a few pixels, else nothing.
  const pick = useCallback((cx, cy, touch) => {
    const el = svgRef.current;
    if (!el || !geo) return null;
    const r = el.getBoundingClientRect();
    const px = ((cx - r.left) * W) / r.width, py = ((cy - r.top) * H) / r.height;
    const R = touch ? TOUCH_R : MOUSE_R;
    let best = null, bd = Infinity;
    for (const h of geo.hits) { const d = Math.hypot(h.px - px, h.py - py); if (d < bd) { bd = d; best = h; } }
    const cur = hot.current;
    if (best && bd <= R) {
      if (cur && cur.effort && !(cur.id === best.id && cur.effort === best.effort)) {
        const cd = Math.hypot(cur.px - px, cur.py - py);
        if (cd <= R && bd + STICKY > cd) return cur;                    // stay on the current marker unless the new one is clearly closer
      }
      return { id: best.id, effort: best.effort, px: best.px, py: best.py };
    }
    let ln = null, ld = LINE_R;
    for (const s of geo.segs) { const d = segDist(px, py, s.x1, s.y1, s.x2, s.y2); if (d <= ld) { ld = d; ln = s; } }
    return ln ? { id: ln.id, effort: null } : null;
  }, [geo, W, H]);

  useEffect(() => {
    const clear = () => setHot(null);
    window.addEventListener("blur", clear);
    window.addEventListener("scroll", clear, { passive: true });
    return () => { window.removeEventListener("blur", clear); window.removeEventListener("scroll", clear); if (frame.current) cancelAnimationFrame(frame.current); };
  }, [setHot]);

  const onMove = (e) => {
    if (e.pointerType === "touch") return;
    last.current = { x: e.clientX, y: e.clientY };
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (last.current) setHot(pick(last.current.x, last.current.y, false));
    });
  };
  const onLeave = () => { last.current = null; setHot(null); };
  const onClick = (e) => {
    const touch = e.nativeEvent.pointerType === "touch";
    const hit = pick(e.clientX, e.clientY, touch);
    if (!hit) { onClearPins(); setHot(null); return; }
    if (touch && !(hot.current && hot.current.id === hit.id)) {           // first tap inspects, a second tap on the same model pins
      setHot(hit.effort ? { ...hit, dock: true } : hit);
      return;
    }
    onPin(hit.id);
  };

  const announce = (s, p) => { if (liveRef.current) liveRef.current.textContent = `${s.label.text}, ${effortLabel(p.effort)}: ${yMetric.name} ${fmtValue(yMetric, p.y)} at ${fmtX(xId, p.x)}`; };
  const onKey = (e) => {
    if (!geo) return;
    const S = geo.series;
    if (e.key === "Escape") { e.preventDefault(); onClearPins(); setHot(null); return; }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " "].includes(e.key)) return;
    e.preventDefault();
    let { m, e: ei } = kb.current;
    m = Math.min(m, S.length - 1);
    if (e.key === "Enter" || e.key === " ") { onPin(S[m].m.model_id); return; }
    if (e.key === "ArrowDown") { m = (m + 1) % S.length; ei = -1; }
    else if (e.key === "ArrowUp") { m = (m - 1 + S.length) % S.length; ei = -1; }
    const pts = S[m].pts;
    if (ei < 0 || ei >= pts.length) ei = pts.length - 1;
    if (e.key === "ArrowRight") ei = Math.min(ei + 1, pts.length - 1);
    if (e.key === "ArrowLeft") ei = Math.max(ei - 1, 0);
    kb.current = { m, e: ei };
    const p = pts[ei];
    setHot({ id: S[m].m.model_id, effort: p.effort, px: geo.fx(p.x), py: geo.fy(p.y) });
    announce(S[m], p);
  };

  if (!geo) return <p className="empty">Nothing to draw here: no visible setting has both {xName.toLowerCase()} and {yMetric.name} yet.</p>;
  const { series, yTicks, xTicks, fx, fy } = geo;
  const xTick = (v) => (xId === "aa_cost_per_task" ? `$${v}` : `${v}`);
  const aria = (s) => `${s.label.text}: ${s.pts.length} setting${s.pts.length === 1 ? "" : "s"}`;

  return (
    <div className="chart-wrap" ref={sizeRef} onPointerMove={onMove} onPointerLeave={onLeave} onPointerCancel={onLeave} onClick={onClick}>
      <svg ref={svgRef} className="chart ef-chart" viewBox={`0 0 ${W} ${H}`} tabIndex={0} role="group" onKeyDown={onKey}
        aria-label={`${yMetric.name} against ${xName.toLowerCase()}, one line per model through its effort settings. Arrow keys move between points, Enter pins a model, Escape clears.`}>
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
        <text className="axlabel" x={(M.l + W - M.r) / 2} y={H - 5} textAnchor="middle" style={{ fontSize: FL }}>
          {xId === "aa_cost_per_task" ? "Cost per task, USD (log scale)" : "Time per task, minutes (log scale)"}
        </text>
        {phone && narrow
          ? <text className="axlabel" x={2} y={FL} textAnchor="start" style={{ fontSize: FL }}>↑ {yMetric.name}</text>
          : <text className="axlabel" x={FL} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 ${FL} ${(M.t + H - M.b) / 2})`} style={{ fontSize: FL }}>{yMetric.name}</text>}

        {spot && <clipPath id={clipId}><rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} /></clipPath>}
        <g clipPath={spot ? `url(#${clipId})` : undefined}>
        {geo.front.length > 1 && <path className="ef-front" d={stairPath(geo.front, fx, fy)} />}
        {geo.ghostLines.map((l, i) => <polyline key={i} className="ef-ghost" points={l.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ")} />)}

        {series.map((s) => {
          const id = s.m.model_id;
          const fade = !!spot && !spot.has(id) && !pinned.has(id);
          const color = fade ? "var(--muted)" : labColor(s.m.org);
          const shape = LAB_SHAPE[s.m.org] || "square";
          const none = s.pts.find((p) => p.effort === "none");
          const first = s.line[0];
          return (
            <g key={id} id={s.gid} aria-label={aria(s)} ref={(el) => { if (el) groups.current.set(id, el); else groups.current.delete(id); }}
              className={`ef${pinned.has(id) ? " is-pin" : ""}${s.m.live ? "" : " gone"}${fade ? " fade" : ""}`}>
              {none && first && <line className="ef-join" x1={fx(none.x)} y1={fy(none.y)} x2={fx(first.x)} y2={fy(first.y)} stroke={color} />}
              {s.line.length > 1 && <polyline className="ladder" stroke={color} points={s.line.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ")} />}
              {s.pts.map((p) => (
                <path key={p.effort} className="ef-mk" transform={`translate(${fx(p.x)} ${fy(p.y)})`} d={markPath(shape, effortHalf(p.effort) * (fade ? 0.55 : 1))}
                  fill={p.effort === "none" ? "var(--bg)" : color} stroke={color} />
              ))}
              {pinned.has(id) && s.pts.map((p) => (
                <text key={`l${p.effort}`} className="ef-pt" x={fx(p.x) + effortHalf(p.effort) + 4} y={fy(p.y) + FS * 1.25} style={{ fontSize: FS - 1 }}>{EFFORT_SHORT[p.effort] || p.effort}</text>
              ))}
            </g>
          );
        })}
        </g>
        <use ref={raiseRef} className="ef-raise" />

        {series.map((s) => {
          const at = geo.labels.get(s.m.model_id);
          const a = anchorOf(s.pts);
          if (!at) return null;
          return (
            <g key={`t${s.m.model_id}`} className={`ef-lab${s.m.live ? "" : " gone"}`}>
              {at.moved && <line className="leader" x1={fx(a.x)} y1={fy(a.y)} x2={at.x + (at.anchor === "start" ? -2 : 2)} y2={at.y - FS * 0.35} />}
              <text className="plabel" x={at.x} y={at.y} textAnchor={at.anchor} style={{ fontSize: FS }}>
                {s.label.base}<tspan className="sub" dy={FS * 0.28} style={{ fontSize: FS * 0.72 }}>{s.label.sub}</tspan>{s.m.live ? "" : <tspan dy={-FS * 0.28}>†</tspan>}
              </text>
            </g>
          );
        })}
      </svg>
      <Tip ref={tipRef} lookup={lookup} yMetric={yMetric} W={W} H={H} />
      <span ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  );
});

// Variant C on a phone: one small chart per model, all on the same axes, each with every other model's ladder in faint grey
// behind it. Sorted by the best score a model reaches; tap one to highlight it in the table.
function MiniGrid({ models, dom, xId, yMetric, efforts, pinned, onPin }) {
  const [sizeRef, W] = useChartSize(false);
  const gap = 10;
  const w = Math.floor((W - gap) / 2);
  const h = Math.round(w * 0.8);
  const M = { l: 22, r: 6, t: 6, b: 15 };
  const series = models
    .map((m) => ({ m, label: modelLabel(m), pts: visiblePoints(m, { xId, yId: yMetric.id, efforts }) }))
    .filter((s) => s.pts.length)
    .map((s) => ({ ...s, top: Math.max(...s.pts.map((p) => p.y)), line: s.pts.filter((p) => LADDER.has(p.effort)) }))
    .sort((a, b) => b.top - a.top);
  if (!series.length || !dom) return <p className="empty" ref={sizeRef}>Nothing to draw here yet.</p>;
  const yT = niceTicks(dom.lo, dom.hi, 4);
  const ylo = yT[0], yhi = yT[yT.length - 1];
  const xT = logTicks(dom.xlo, dom.xhi, 3);
  const fx = (v) => M.l + ((Math.log(v) - Math.log(dom.xlo)) / (Math.log(dom.xhi) - Math.log(dom.xlo))) * (w - M.l - M.r);
  const fy = (v) => h - M.b - ((v - ylo) / (yhi - ylo)) * (h - M.t - M.b);
  const poly = (pts) => pts.map((p) => `${fx(p.x)},${fy(p.y)}`).join(" ");
  return (
    <div className="ef-multi" ref={sizeRef}>
      {series.map((s) => {
        const id = s.m.model_id;
        const color = labColor(s.m.org);
        const shape = LAB_SHAPE[s.m.org] || "square";
        const xs = s.pts.map((p) => p.x);
        return (
          <button key={id} type="button" className={`ef-mini${pinned.has(id) ? " is-pin" : ""}`} aria-pressed={pinned.has(id)}
            style={{ "--c": color }} onClick={() => onPin(id)}
            aria-label={`${s.label.text}: best ${yMetric.name} ${fmtValue(yMetric, s.top)}, ${s.pts.length} settings`}>
            <span className="ef-mini-h"><Swatch org={s.m.org} size={10} /><Name label={s.label} /><span className="ef-mini-v">{fmtValue(yMetric, s.top)}</span></span>
            <svg className="chart" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
              {yT.map((v, i) => (
                <g key={`y${v}`}>
                  <line className="grid" x1={M.l} x2={w - M.r} y1={fy(v)} y2={fy(v)} />
                  {i % 2 === 0 && <text x={M.l - 3} y={fy(v) + 3} textAnchor="end" style={{ fontSize: 9 }}>{v}</text>}
                </g>
              ))}
              {xT.map((v) => <text key={`x${v}`} x={fx(v)} y={h - 3} textAnchor="middle" style={{ fontSize: 9 }}>{xId === "aa_cost_per_task" ? `$${v}` : v}</text>)}
              {series.filter((o) => o !== s && o.line.length > 1).map((o) => <polyline key={o.m.model_id} className="ef-ghost" points={poly(o.line)} />)}
              {s.line.length > 1 && <polyline className="ladder" stroke={color} points={poly(s.line)} />}
              {s.pts.map((p) => (
                <path key={p.effort} className="ef-mk" transform={`translate(${fx(p.x)} ${fy(p.y)})`} d={markPath(shape, effortHalf(p.effort) * 0.7)}
                  fill={p.effort === "none" ? "var(--bg)" : color} stroke={color} />
              ))}
            </svg>
            <span className="ef-mini-f muted">{fmtX(xId, Math.min(...xs))} to {fmtX(xId, Math.max(...xs))}{s.m.live ? "" : " · †"}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function EffortView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.message || String(e)); });
    return () => { live = false; };
  }, []);
  if (error) return <p className="mt-note" role="alert">Could not load the effort data ({error}).</p>;
  if (!data) return <p className="empty">Loading…</p>;
  return <Dashboard data={data} />;
}

function Dashboard({ data }) {
  const efforts = useMemo(() => allEfforts(data), [data]);
  const yList = useMemo(() => yMetrics(data), [data]);
  const labs = useMemo(() => [...new Set(data.models.map((m) => m.org))].sort(), [data]);
  const liveIds = useMemo(() => new Set(data.models.filter((m) => m.live).map((m) => m.model_id)), [data]);
  const byId = useMemo(() => new Map(data.models.map((m) => [m.model_id, m])), [data]);
  const [shownEfforts, setShownEfforts] = useState(() => new Set(efforts));
  const [shownModels, setShownModels] = useState(() => new Set(liveIds));          // the models AA lists now; the retired ones are one click away
  const [yPick, setYPick] = useState("aa_intelligence_index");
  const [xId, setXId] = useState("aa_cost_per_task");
  const [layout, setLayout] = useState(() => (typeof window !== "undefined" && window.innerWidth < 560 ? "lab" : "one"));
  const [pinned, setPinned] = useState(() => new Set(byId.has(DEFAULT_FOCUS) ? [DEFAULT_FOCUS] : []));
  const [variant] = useMobileVariant();
  const narrow = useNarrow();
  const mode = narrow ? variant : "off";
  // A: one tall chart with each lab's flagship in colour; B: a panel per company, each zoomed to its own data; C: one small chart per model.
  const shownLayout = mode === "a" ? "one" : mode === "b" ? "lab" : mode === "c" ? "multi" : layout;

  const yMetric = yList.find((m) => m.id === yPick) || yList[0];
  const models = useMemo(() => data.models.filter((m) => shownModels.has(m.model_id)), [data, shownModels]);
  const xName = X_OPTIONS.find(([id]) => id === xId)[1];
  const dom = useMemo(() => {
    const pts = models.flatMap((m) => visiblePoints(m, { xId, yId: yMetric.id, efforts: shownEfforts }));
    return pts.length ? domainOf(pts) : null;
  }, [models, xId, yMetric, shownEfforts]);
  // Variant A's flagships: the model with the best score at its top setting, per company.
  const spot = useMemo(() => {
    if (mode !== "a") return null;
    const best = new Map();
    for (const m of models) {
      const pts = visiblePoints(m, { xId, yId: yMetric.id, efforts: shownEfforts });
      if (!pts.length) continue;
      const top = Math.max(...pts.map((p) => p.y));
      if (!best.has(m.org) || top > best.get(m.org).top) best.set(m.org, { id: m.model_id, top });
    }
    return new Set([...best.values()].map((b) => b.id));
  }, [mode, models, xId, yMetric, shownEfforts]);
  // A zooms its axes to the models in colour (flagships and pins); the grey ladders are clipped at the plot's edge.
  const domA = useMemo(() => {
    if (!spot) return null;
    const pts = models.filter((m) => spot.has(m.model_id) || pinned.has(m.model_id)).flatMap((m) => visiblePoints(m, { xId, yId: yMetric.id, efforts: shownEfforts }));
    return pts.length ? domainOf(pts) : null;
  }, [spot, pinned, models, xId, yMetric, shownEfforts]);
  const panels = useMemo(() => labs.map((org) => ({ org, models: models.filter((m) => m.org === org), ghosts: models.filter((m) => m.org !== org) })).filter((p) => p.models.length), [labs, models]);

  const flip = (set, v) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const toggleModel = (id) => setShownModels((s) => flip(s, id));
  const toggleEffort = (e) => setShownEfforts((s) => flip(s, e));
  const onPin = useCallback((id) => setPinned((s) => flip(s, id)), []);
  const onClearPins = useCallback(() => setPinned((s) => (s.size ? new Set() : s)), []);
  const toggleLab = (org) => setShownModels((s) => {
    const ids = data.models.filter((m) => m.org === org).map((m) => m.model_id);
    const n = new Set(s);
    if (ids.every((id) => n.has(id))) ids.forEach((id) => n.delete(id)); else ids.forEach((id) => n.add(id));
    return n;
  });
  const isCurrent = shownModels.size === liveIds.size && [...liveIds].every((id) => shownModels.has(id));
  const isAll = shownModels.size === data.models.length;

  const unit = yMetric.unit === "%" ? " pts" : "";
  const rows = models.map((m) => ({ m, label: modelLabel(m), pts: visiblePoints(m, { xId, yId: yMetric.id, efforts: shownEfforts }) }));
  const chartProps = { xId, yMetric, efforts: shownEfforts, pinned, onPin, onClearPins, phone: mode !== "off" };

  return (
    <>
      <section className="mt-panel mt-hero" aria-label="Score against cost for every effort setting">
        <div className="ef-title">
          <h2>Frontier effort comparison</h2>
          <p className="fold-p">Each line is one model, from its lowest to its highest reasoning effort. Up and to the left is better. Data from <a href={data.source.url}>{data.source.name}</a>, as of {data.as_of}.</p>
        </div>
        <div className="pane-tools">
          <label className="lbl">Score{" "}
            <select value={yMetric.id} onChange={(e) => setYPick(e.target.value)}>
              {yList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <span className="lbl">against</span>
          <div className="seg" role="group" aria-label="Horizontal axis">
            {X_OPTIONS.map(([id, label]) => <button key={id} type="button" aria-pressed={xId === id} onClick={() => setXId(id)}>{label}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Which models">
            <button type="button" aria-pressed={isCurrent} onClick={() => setShownModels(new Set(liveIds))} title="The models Artificial Analysis lists now, each with its full set of effort levels">Current</button>
            <button type="button" aria-pressed={isAll} onClick={() => setShownModels(new Set(data.models.map((m) => m.model_id)))} title="Adds models AA no longer lists, each with a single setting">All ({data.models.length})</button>
          </div>
          {mode === "off" && <div className="seg" role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === "one"} onClick={() => setLayout("one")}>One chart</button>
            <button type="button" aria-pressed={layout === "lab"} onClick={() => setLayout("lab")}>By company</button>
          </div>}
        </div>

        {shownLayout === "one" ? (
          <EffortChart models={models} ghosts={[]} dom={domA || dom} wide spot={spot} {...chartProps} />
        ) : shownLayout === "multi" ? (
          <MiniGrid models={models} dom={dom} xId={xId} yMetric={yMetric} efforts={shownEfforts} pinned={pinned} onPin={onPin} />
        ) : (
          <div className="ef-panels">
            {panels.map((p) => (
              <div key={p.org} className="ef-panel">
                <div className="ef-panel-h"><OrgMark org={p.org} color="var(--ink)" />{p.org}</div>
                <EffortChart models={p.models} ghosts={mode === "b" ? [] : p.ghosts} dom={mode === "b" ? null : dom} {...chartProps} />
              </div>
            ))}
          </div>
        )}

        <div className="ef-chips" aria-label="Models shown">
          {labs.map((org) => {
            const list = data.models.filter((m) => m.org === org);
            return (
              <div key={org} className="eff-group">
                <button type="button" className="chip eff-lab" aria-pressed={list.every((m) => shownModels.has(m.model_id))} onClick={() => toggleLab(org)} title={`Show or hide every ${org} model`}>
                  <Swatch org={org} />{org}
                </button>
                {list.map((m) => (
                  <button key={m.model_id} type="button" className="chip" aria-pressed={shownModels.has(m.model_id)}
                    title={`${m.display_name}${m.live ? "" : ` (single setting; last listed by AA on ${m.last_seen})`}`} onClick={() => toggleModel(m.model_id)}>
                    <Name label={modelLabel(m)} />{m.live ? "" : <span className="muted"> †</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="ef-effort" aria-label="Effort levels shown">
          <span className="lbl">Effort levels</span>
          {efforts.map((e) => (
            <button key={e} type="button" className="chip" aria-pressed={shownEfforts.has(e)} onClick={() => toggleEffort(e)}>{effortLabel(e)}</button>
          ))}
        </div>
        <p className="fold-p ef-hint">Hover a point for its numbers · click a line to keep it highlighted, click empty space to clear · bigger marker = more effort, hollow = no reasoning, † = AA no longer lists it.</p>

        <Fold id="explain" title="How to read this chart" meta={`${yMetric.name} vs ${xName.toLowerCase()}`} defaultOpen={false}>
          <dl className="explain">
            <dt>One line per model</dt>
            <dd>Each line joins a model's published effort settings from lowest to highest. A steep climb means the model gets a lot from more effort; a flat run means it does not.</dd>
            <dt>{yMetric.name} (vertical)</dt>
            <dd>{yMetric.blurb} Higher is better.</dd>
            <dt>{xName} (horizontal, log scale)</dt>
            <dd>{xId === "aa_cost_per_task" ? "What it cost Artificial Analysis to run the Intelligence Index tasks at that setting, at list prices." : "How long those tasks took at that setting."} Each step right is a multiple, not a fixed amount. The stepped line is the efficient frontier: the best score available for that cost or less.</dd>
            <dt>Names</dt>
            <dd>The small number is the model's version (Astra<sub>6.2</sub> is GPT-6.2 Astra, Opus<sub>5.5</sub> is Claude Opus 5.5). Gemini 4 models are named by the chemical symbol of their class (Gemini<sub>Ar</sub> is Gemini 4 Argon). Marker shape tells the company: square OpenAI, diamond Anthropic, triangle Google.</dd>
          </dl>
        </Fold>
        <Fold id="about" title="About this data" meta={`${data.counts.settings} settings, ${data.counts.models} models`}>
          <p className="mt-note">{data.note}</p>
          <p className="fold-p" style={{ marginTop: 8 }}>Covers OpenAI GPT-6 and later, Anthropic Claude 5 and later, Google Gemini 3.8 and later. New models in those families appear on the next data refresh.</p>
        </Fold>
      </section>

      <section className="mt-panel">
        <div className="pane-tools">
          <span className="lbl">Every setting</span>
          <span className="muted">{yMetric.name} over {xName.toLowerCase()} · click a row to highlight it</span>
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
                  <tr key={m.model_id} className={`eff-row${pinned.has(m.model_id) ? " is-hl" : pinned.size ? " is-dim" : ""}`} style={{ "--c": labColor(m.org) }} onClick={() => onPin(m.model_id)}>
                    <td><span className="mname"><OrgMark org={m.org} color={labColor(m.org)} /><Name label={label} /><span className="muted">{m.display_name}{m.live ? "" : " · not listed now"}</span></span></td>
                    {efforts.filter((e) => shownEfforts.has(e)).map((e) => {
                      const p = at.get(e);
                      return p ? (
                        <td key={e} title={`${m.display_name}, ${effortLabel(e)}: ${fmtValue(yMetric, p.y)} at ${fmtX(xId, p.x)}`}>
                          <span className="cell-v">{fmtValue(yMetric, p.y)}</span><span className="cell-c muted">{fmtX(xId, p.x)}</span>
                        </td>
                      ) : <td key={e} className="dash">–</td>;
                    })}
                    {g ? <td><span className="cell-v">{g.dy >= 0 ? "+" : "−"}{Math.abs(g.dy).toFixed(yMetric.unit === "ln" ? 2 : 1)}{unit}</span><span className="cell-c muted">{g.mult.toFixed(1)}× the {xName.toLowerCase().replace(" per task", "")}</span></td> : <td className="dash">–</td>}
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
