// Compact, read-only "plane" renderer (canvas 2D drawing a small 3D scene, no dependencies).
//
// Three concentric strata. Tools sit on the surface of the main sphere as small squares, in one
// contiguous band. Docs sit one shell further out (DOC_SHELL times the radius), still squares and
// in the direction they would have had on the main sphere, so each doctype keeps one band. Agents
// sit on the surface of a small inner ball (AGENT_BALL times the radius), spread by tier then id,
// and each may slide a little way (at most WANDER radians) from its spot toward the surface nodes
// it has active/pulsing edges to. Edges are drawn only while active or pulsing. The scene turns
// slowly (toggle with setSpin) and can be dragged; things further away are drawn smaller and
// dimmer. Everything eases; nothing jumps. Colours come from CSS variables on the canvas
// (--np-working, --np-idle, --np-done, --np-ring, --np-square, --np-edge, --np-text).

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPIN = 0.12;             // radians per second while spinning
const NEAR = 0.3;              // alpha at the very back (1 at the front)
const EYE = 3.2;               // camera distance in main-sphere radii (sets the perspective)
const DOC_SHELL = 1.3;         // docs sit on a shell of this radius, in main-sphere radii
const AGENT_BALL = 0.3;        // agents sit on a ball of this radius, in main-sphere radii
const WANDER = 0.35;           // radians an agent may slide from its spot toward what it is using
const LABEL_GAP = 0.18;        // group labels sit this far outside their shell, in main-sphere radii

// Point i of N on a Fibonacci sphere: unit directions, evenly spread, in order from top to bottom.
function fib(i, N) {
  const y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(Math.max(0, 1 - y * y)), t = i * GOLDEN;
  return [Math.cos(t) * r, y, Math.sin(t) * r];
}
const scale = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(v) { const d = Math.hypot(v[0], v[1], v[2]); return d > 1e-9 ? scale(v, 1 / d) : null; }

// Turn unit direction `from` toward unit direction `to`, by at most `max` radians.
function lean(from, to, max) {
  const c = Math.max(-1, Math.min(1, dot(from, to)));
  if (Math.acos(c) <= max) return to;
  const perp = unit([to[0] - from[0] * c, to[1] - from[1] * c, to[2] - from[2] * c]);
  if (!perp) return from;   // straight behind: no side to lean to
  const cm = Math.cos(max), sm = Math.sin(max);
  return [from[0] * cm + perp[0] * sm, from[1] * cm + perp[1] * sm, from[2] * cm + perp[2] * sm];
}

export function createPlane(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  let W = 300, H = 300, dpr = 1;
  let nodes = [];            // incoming data
  let edges = [];
  const agents = new Map();  // id -> { p: [x,y,z], t: [x,y,z], anchor: unit dir, node, a }  (main-sphere radii)
  const shell = new Map();   // id -> { d: unit dir, p: [x,y,z], node }
  const edgeA = new Map();   // key -> alpha (eased)
  let groups = [];           // [{label, p}]
  let raf = 0, last = 0, running = false, visible = true, onScreen = true, destroyed = false;
  let colors = null, colorsAt = 0;
  let geom = { cx: 0, cy: 0, R: 100 };
  let yaw = 0.6, pitch = -0.35, spin = opts.spin ?? true;
  let drag = null;

  function readColors(now) {
    if (colors && now - colorsAt < 1500) return colors;
    const cs = getComputedStyle(canvas);
    const g = (n, d) => cs.getPropertyValue(n).trim() || d;
    colors = {
      working: g("--np-working", "#e8a33d"), idle: g("--np-idle", "#8a8f98"), done: g("--np-done", "#4caf7d"),
      ring: g("--np-ring", "#8a8f98"), square: g("--np-square", "#f4f1ea"),
      edge: g("--np-edge", "#e8a33d"), text: g("--np-text", "#8a8f98"),
    };
    colorsAt = now;
    return colors;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(120, r.width); H = Math.max(120, r.height);
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    geom = { cx: W / 2, cy: H / 2, R: Math.min(W, H) * 0.3 };   // leaves room for the outer shell
  }

  // One Fibonacci sphere over the sorted list, so each group fills one contiguous band of
  // directions; a doc then moves one stratum out along its direction, which keeps its band whole.
  function layoutShell() {
    const fixed = nodes.filter((n) => n.kind !== "agent")
      .sort((a, b) => (a.group || "").localeCompare(b.group || "", undefined, { numeric: true }) ||
        a.id.localeCompare(b.id, undefined, { numeric: true }));
    shell.clear(); groups = [];
    const N = Math.max(1, fixed.length);
    const radiusOf = (n) => (n.kind === "doc" ? DOC_SHELL : 1);
    fixed.forEach((n, i) => { const d = fib(i, N); shell.set(n.id, { node: n, d, p: scale(d, radiusOf(n)) }); });
    const keys = [...new Set(fixed.map((n) => n.group || ""))];
    for (const k of keys) {
      const idx = fixed.map((n, i) => ((n.group || "") === k ? i : -1)).filter((i) => i >= 0);
      const mid = idx[Math.floor(idx.length / 2)];
      groups.push({ label: fixed[mid].groupLabel || k, p: scale(fib(mid, N), radiusOf(fixed[mid]) + LABEL_GAP) });
    }
  }

  function setData(plane) {
    nodes = (plane && plane.nodes) || [];
    edges = (plane && plane.edges) || [];
    layoutShell();
    // agents: one Fibonacci spread over the ball, lowest tier first so each tier sits together
    const list = nodes.filter((n) => n.kind === "agent")
      .sort((a, b) => (a.tier || 0) - (b.tier || 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const seen = new Set();
    list.forEach((n, i) => {
      seen.add(n.id);
      const anchor = fib(i, list.length);
      let a = agents.get(n.id);
      if (!a) {   // a new agent emerges from the centre and fades in
        a = { p: scale(anchor, 0.03), t: scale(anchor, AGENT_BALL), a: 0 };
        agents.set(n.id, a);
      }
      a.node = n; a.anchor = anchor;
    });
    for (const id of agents.keys()) if (!seen.has(id)) agents.delete(id);
    start();
  }

  // Each agent's target: its spot on the ball, leaned toward the surface nodes it is actively using
  // (the mean of their directions, so scattered ones pull less), never more than WANDER radians.
  function computeTargets() {
    const pull = new Map();   // agent id -> summed directions of the surface nodes it is using
    for (const e of edges) {
      if (!(e.active || e.pulse)) continue;
      for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
        if (agents.has(a) && shell.has(b)) {
          const q = pull.get(a) || [0, 0, 0, 0];
          const s = shell.get(b).d; q[0] += s[0]; q[1] += s[1]; q[2] += s[2]; q[3]++; pull.set(a, q);
        }
      }
    }
    for (const [id, a] of agents) {
      const q = pull.get(id);
      const want = q && unit([a.anchor[0] + q[0] / q[3], a.anchor[1] + q[1] / q[3], a.anchor[2] + q[2] / q[3]]);
      a.t = scale(want ? lean(a.anchor, want, WANDER) : a.anchor, AGENT_BALL);
    }
  }

  // Rotate (yaw about y, then pitch about x), then a gentle perspective from EYE radii away.
  // depth: 0 at the back of the main sphere .. 1 at its front (the outer shell goes a bit beyond).
  function project(p) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy;
    const y2 = p[1] * cp - z1 * sp, z2 = p[1] * sp + z1 * cp;
    const f = EYE / (EYE - z2);
    const { cx, cy: ccy, R } = geom;
    return { x: cx + x1 * R * f, y: ccy - y2 * R * f, f, depth: (z2 + 1) / 2 };
  }
  const fade = (depth) => NEAR + (1 - NEAR) * Math.max(0, Math.min(1, depth));
  // Screen radius of a sphere's outline: seen from EYE radii away its silhouette is a little wider
  // than the sphere itself (noticeably so for the outer shell), so the squares stay inside the ring.
  const silhouette = (r) => geom.R * r / Math.sqrt(1 - (r / EYE) ** 2);

  function frame(now) {
    raf = 0;
    if (destroyed || !running) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    if (spin && !drag) yaw += SPIN * dt;
    const c = readColors(now);
    computeTargets();
    const k = 1 - Math.exp(-dt * 3.5);
    for (const a of agents.values()) {
      for (let i = 0; i < 3; i++) a.p[i] += (a.t[i] - a.p[i]) * k;
      a.a += (1 - a.a) * (1 - Math.exp(-dt * 4));
    }
    draw(c, now);
    raf = requestAnimationFrame(frame);
  }

  // The three strata, faint: the agents' ball, the main sphere with its equator, and the docs'
  // shell (dashed). The equator turns with the scene; the half facing away is dimmer.
  function drawStrata(c) {
    const { cx, cy } = geom;
    ctx.strokeStyle = c.ring; ctx.lineWidth = 1; ctx.globalAlpha = 0.18;
    for (const [r, dash] of [[AGENT_BALL, []], [1, []], [DOC_SHELL, [3, 4]]]) {
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.arc(cx, cy, silhouette(r), 0, TAU); ctx.stroke();
    }
    ctx.setLineDash([]);
    const front = new Path2D(), back = new Path2D();
    let prev = null;
    for (let i = 0; i <= 64; i++) {
      const q = project([Math.cos((i / 64) * TAU), 0, Math.sin((i / 64) * TAU)]);
      if (prev) {
        const path = prev.depth + q.depth > 1 ? front : back;   // nearer than the centre, or not
        path.moveTo(prev.x, prev.y); path.lineTo(q.x, q.y);
      }
      prev = q;
    }
    ctx.globalAlpha = 0.1; ctx.stroke(front);
    ctx.globalAlpha = 0.04; ctx.stroke(back);
  }

  function draw(c, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawStrata(c);
    // group labels (faint, just outside the band, dimmer at the back)
    ctx.fillStyle = c.text; ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const g of groups) {
      const q = project(g.p);
      ctx.globalAlpha = 0.55 * fade(q.depth) * fade(q.depth);
      ctx.fillText(g.label, Math.max(24, Math.min(W - 24, q.x)), Math.max(8, Math.min(H - 8, q.y)));
    }
    const proj = new Map();
    for (const [id, s] of shell) proj.set(id, project(s.p));
    for (const [id, a] of agents) proj.set(id, project(a.p));
    // edges
    const live = new Set();
    for (const e of edges) {
      const key = e.src + ">" + e.dst + ":" + e.kind;
      const on = e.active || e.pulse;
      const prev = edgeA.get(key) || 0;
      const val = prev + ((on ? 1 : 0) - prev) * 0.18;
      if (val < 0.02 && !on) { edgeA.delete(key); continue; }
      edgeA.set(key, val); live.add(key);
      const s = proj.get(e.src), d = proj.get(e.dst);
      if (!s || !d) continue;
      const base = e.kind === "reports" ? 0.18 : e.pulse ? 0.8 : 0.5;
      ctx.globalAlpha = base * val * fade((s.depth + d.depth) / 2);
      ctx.strokeStyle = c.edge;
      ctx.lineWidth = e.kind === "reports" ? 0.8 : 1.2 + Math.min(1.5, Math.log2(1 + (e.count || 0)) * 0.2);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    for (const k of edgeA.keys()) if (!live.has(k)) edgeA.delete(k);
    // nodes, back to front
    const items = [];
    for (const [id, s] of shell) items.push({ q: proj.get(id), shell: s });
    for (const [id, a] of agents) items.push({ q: proj.get(id), agent: a });
    items.sort((u, v) => u.q.depth - v.q.depth);
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.font = "9px system-ui, sans-serif";
    for (const { q, shell: s, agent: a } of items) {
      if (s) {
        const h = 2.6 * q.f;
        ctx.globalAlpha = 0.9 * fade(q.depth); ctx.fillStyle = c.square;
        ctx.fillRect(q.x - h, q.y - h, h * 2, h * 2);
        continue;
      }
      // the ball is small, so an agent fades by its place on the ball rather than in the whole scene
      const dim = fade((q.depth - 0.5) / AGENT_BALL + 0.5);
      const st = a.node.state || "idle";
      const rad = (st === "working" ? 4.5 + pulse * 0.8 : 3.8) * q.f;
      ctx.globalAlpha = a.a * dim * (st === "idle" ? 0.7 : 1);
      ctx.fillStyle = c[st] || c.idle;
      ctx.beginPath(); ctx.arc(q.x, q.y, rad, 0, TAU); ctx.fill();
      ctx.globalAlpha = a.a * 0.8 * dim; ctx.fillStyle = c.text;
      ctx.fillText(a.node.label || a.node.id, q.x, q.y + rad + 7);
    }
    ctx.globalAlpha = 1;
  }

  function redraw() { const t = performance.now(); draw(readColors(t), t); }
  function start() {
    if (running || destroyed || !visible || !onScreen) { if (!running) redraw(); return; }
    running = true; last = 0; raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  // Drag to turn: sideways turns about the vertical axis, up/down tilts (clamped so it never flips).
  const onDown = (e) => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    if (!drag) return;
    const s = 2.4 / Math.max(120, Math.min(W, H));
    yaw = drag.yaw + (e.clientX - drag.x) * s;
    pitch = Math.max(-1.3, Math.min(1.3, drag.pitch + (e.clientY - drag.y) * s));
    if (!running) redraw();
  };
  const onUp = () => { drag = null; };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  const onVis = () => { visible = !document.hidden; visible && onScreen ? start() : stop(); };
  document.addEventListener("visibilitychange", onVis);
  const ro = new ResizeObserver(() => { resize(); if (!running) redraw(); });
  ro.observe(canvas);
  const io = new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; onScreen && visible ? start() : stop(); });
  io.observe(canvas);
  resize();

  return {
    setData,
    setSpin(on) { spin = !!on; },
    destroy() {
      destroyed = true; stop(); ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    },
  };
}
