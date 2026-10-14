// Compact, read-only "plane" renderer (canvas 2D, no dependencies).
//
// Non-agent nodes (tools, docs) sit on a fixed ring, grouped into contiguous arcs by `group`.
// Agents live inside the ring: tier 0 near the centre, higher tiers further out, pulled toward
// the ring nodes they have active/pulsing edges to and repelling each other. Edges are drawn only
// while active or pulsing. Everything eases; nothing jumps. Colours come from CSS variables on
// the canvas (--np-working, --np-idle, --np-done, --np-ring, --np-edge, --np-text).

const TAU = Math.PI * 2;

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

export function createPlane(canvas) {
  const ctx = canvas.getContext("2d");
  let W = 300, H = 300, dpr = 1;
  let nodes = [];            // incoming data
  let edges = [];
  const agents = new Map();  // id -> { x, y, tx, ty, node, a }
  const ring = new Map();    // id -> { x, y, node, ang }
  const edgeA = new Map();   // key -> alpha (eased)
  let groups = [];           // [{label, a0, a1}]
  let raf = 0, last = 0, running = false, visible = true, onScreen = true, destroyed = false;
  let colors = null, colorsAt = 0;
  let geom = { cx: 0, cy: 0, R: 100 };

  function readColors(now) {
    if (colors && now - colorsAt < 1500) return colors;
    const cs = getComputedStyle(canvas);
    const g = (n, d) => cs.getPropertyValue(n).trim() || d;
    colors = {
      working: g("--np-working", "#e8a33d"), idle: g("--np-idle", "#8a8f98"), done: g("--np-done", "#4caf7d"),
      ring: g("--np-ring", "#8a8f98"), edge: g("--np-edge", "#e8a33d"), text: g("--np-text", "#8a8f98"),
    };
    colorsAt = now;
    return colors;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(120, r.width); H = Math.max(120, r.height);
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    layoutRing();
  }

  function layoutRing() {
    const m = Math.min(W, H);
    geom = { cx: W / 2, cy: H / 2, R: m * 0.36 };
    const fixed = nodes.filter((n) => n.kind !== "agent")
      .sort((a, b) => (a.group || "").localeCompare(b.group || "", undefined, { numeric: true }) ||
        a.id.localeCompare(b.id, undefined, { numeric: true }));
    ring.clear(); groups = [];
    const gaps = 0.12; // radians between groups
    const keys = [...new Set(fixed.map((n) => n.group || ""))];
    const span = TAU - gaps * keys.length;
    let ang = -Math.PI / 2;
    for (const k of keys) {
      const members = fixed.filter((n) => (n.group || "") === k);
      const step = span / Math.max(1, fixed.length);
      const a0 = ang;
      members.forEach((n, i) => {
        const a = a0 + step * (i + 0.5);
        const ex = ring.get(n.id);
        ring.set(n.id, { node: n, ang: a, x: geom.cx + Math.cos(a) * geom.R, y: geom.cy + Math.sin(a) * geom.R, _x: ex });
      });
      ang += step * members.length;
      groups.push({ label: members[0].groupLabel || k, a0, a1: ang });
      ang += gaps;
    }
  }

  function setData(plane) {
    nodes = (plane && plane.nodes) || [];
    edges = (plane && plane.edges) || [];
    layoutRing();
    const seen = new Set();
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      seen.add(n.id);
      let a = agents.get(n.id);
      if (!a) {
        const ang = hash01(n.id) * TAU;
        a = { x: geom.cx + Math.cos(ang) * 4, y: geom.cy + Math.sin(ang) * 4, tx: 0, ty: 0, node: n, a: 0 };
        agents.set(n.id, a);
      }
      a.node = n;
    }
    for (const id of agents.keys()) if (!seen.has(id)) agents.delete(id);
    start();
  }

  function pos(id) {
    return ring.get(id) || agents.get(id) || null;
  }

  function computeTargets() {
    const { cx, cy, R } = geom;
    const list = [...agents.values()];
    // active ring neighbours per agent
    const pull = new Map();
    for (const e of edges) {
      if (!(e.active || e.pulse)) continue;
      for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
        if (agents.has(a) && ring.has(b)) {
          const p = pull.get(a) || { x: 0, y: 0, n: 0 };
          const r = ring.get(b); p.x += r.x; p.y += r.y; p.n++; pull.set(a, p);
        }
      }
    }
    const space = Math.max(7, Math.min(16, (R * 1.6) / Math.sqrt(Math.max(1, list.length)) * 0.9));
    for (const a of list) {
      const tier = a.node.tier || 0;
      const rad = R * Math.min(0.78, 0.14 + 0.2 * tier);
      const ang = hash01(a.node.id) * TAU;
      let tx = cx + Math.cos(ang) * rad, ty = cy + Math.sin(ang) * rad;
      const p = pull.get(a.node.id);
      if (p) {
        const px = p.x / p.n, py = p.y / p.n;
        const k = 0.45; // pulled partway toward the tools it is using
        tx = tx + (cx + (px - cx) * 0.7 - tx) * k;
        ty = ty + (cy + (py - cy) * 0.7 - ty) * k;
      }
      a.tx = tx; a.ty = ty;
    }
    // personal space: push targets apart (a few relaxation passes), keep inside the ring
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j];
          let dx = B.tx - A.tx, dy = B.ty - A.ty;
          let d = Math.hypot(dx, dy);
          if (d >= space) continue;
          if (d < 0.01) { const t = hash01(A.node.id + B.node.id) * TAU; dx = Math.cos(t); dy = Math.sin(t); d = 1; }
          const push = (space - d) / 2;
          const ux = dx / d, uy = dy / d;
          A.tx -= ux * push; A.ty -= uy * push; B.tx += ux * push; B.ty += uy * push;
        }
      }
    }
    const maxR = R * 0.9;
    for (const a of list) {
      const dx = a.tx - cx, dy = a.ty - cy, d = Math.hypot(dx, dy);
      if (d > maxR) { a.tx = cx + (dx / d) * maxR; a.ty = cy + (dy / d) * maxR; }
    }
  }

  function frame(now) {
    raf = 0;
    if (destroyed || !running) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    const c = readColors(now);
    computeTargets();
    const k = 1 - Math.exp(-dt * 3.5);
    for (const a of agents.values()) {
      a.x += (a.tx - a.x) * k; a.y += (a.ty - a.y) * k;
      a.a += (1 - a.a) * (1 - Math.exp(-dt * 4));
    }
    draw(c, now);
    raf = requestAnimationFrame(frame);
  }

  function draw(c, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { cx, cy, R } = geom;
    // ring guide
    ctx.globalAlpha = 0.18; ctx.strokeStyle = c.ring; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    // group labels (faint, outside the ring)
    ctx.globalAlpha = 0.55; ctx.fillStyle = c.text; ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const g of groups) {
      const a = (g.a0 + g.a1) / 2;
      const lx = cx + Math.cos(a) * (R + 22), ly = cy + Math.sin(a) * (R + 16);
      ctx.fillText(g.label, Math.max(24, Math.min(W - 24, lx)), Math.max(8, Math.min(H - 8, ly)));
    }
    // edges
    const live = new Set();
    for (const e of edges) {
      const key = e.src + ">" + e.dst + ":" + e.kind;
      const on = e.active || e.pulse;
      const prev = edgeA.get(key) || 0;
      const target = on ? 1 : 0;
      const val = prev + (target - prev) * 0.18;
      if (val < 0.02 && !on) { edgeA.delete(key); continue; }
      edgeA.set(key, val); live.add(key);
      const s = pos(e.src), d = pos(e.dst);
      if (!s || !d) continue;
      const base = e.kind === "reports" ? 0.18 : e.pulse ? 0.8 : 0.5;
      ctx.globalAlpha = base * val;
      ctx.strokeStyle = c.edge;
      ctx.lineWidth = e.kind === "reports" ? 0.8 : 1.2 + Math.min(1.5, Math.log2(1 + (e.count || 0)) * 0.2);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    for (const k of edgeA.keys()) if (!live.has(k)) edgeA.delete(k);
    // ring nodes
    ctx.globalAlpha = 0.85;
    for (const r of ring.values()) {
      ctx.fillStyle = c.ring;
      ctx.beginPath();
      if (r.node.kind === "doc") ctx.rect(r.x - 2.5, r.y - 2.5, 5, 5); else ctx.arc(r.x, r.y, 3, 0, TAU);
      ctx.fill();
    }
    // agents
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.font = "9px system-ui, sans-serif";
    for (const a of agents.values()) {
      const st = a.node.state || "idle";
      const col = c[st] || c.idle;
      const rad = st === "working" ? 4.5 + pulse * 0.8 : 3.8;
      ctx.globalAlpha = a.a * (st === "idle" ? 0.7 : 1);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(a.x, a.y, rad, 0, TAU); ctx.fill();
      ctx.globalAlpha = a.a * 0.8; ctx.fillStyle = c.text;
      ctx.fillText(a.node.label || a.node.id, a.x, a.y + rad + 7);
    }
    ctx.globalAlpha = 1;
  }

  function start() {
    if (running || destroyed || !visible || !onScreen) { if (!running) draw(readColors(performance.now()), performance.now()); return; }
    running = true; last = 0; raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  const onVis = () => { visible = !document.hidden; visible && onScreen ? start() : stop(); };
  document.addEventListener("visibilitychange", onVis);
  const ro = new ResizeObserver(() => { resize(); if (!running) draw(readColors(performance.now()), performance.now()); });
  ro.observe(canvas);
  const io = new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; onScreen && visible ? start() : stop(); });
  io.observe(canvas);
  resize();

  return {
    setData,
    destroy() { destroyed = true; stop(); ro.disconnect(); io.disconnect(); document.removeEventListener("visibilitychange", onVis); },
  };
}
