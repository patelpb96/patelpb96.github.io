// Compact, read-only "plane" renderer (canvas 2D drawing a small 3D scene, no dependencies).
//
// Non-agent nodes (tools, docs) sit on the surface of a sphere as small squares, each group in one
// contiguous band. Agents live inside it: tier 0 near the centre, higher tiers further out, pulled
// toward the surface nodes they have active/pulsing edges to and repelling each other. Edges are
// drawn only while active or pulsing. The sphere turns slowly (toggle with setSpin) and can be
// dragged; things further away are drawn smaller and dimmer. Everything eases; nothing jumps.
// Colours come from CSS variables on the canvas (--np-working, --np-idle, --np-done, --np-ring,
// --np-square, --np-edge, --np-text).

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPIN = 0.12;             // radians per second while spinning
const NEAR = 0.3;              // alpha at the very back of the sphere (1 at the front)

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// A stable unit direction for an id.
function dirOf(id) {
  const z = 2 * hash01(id) - 1, t = hash01(id + "~") * TAU, r = Math.sqrt(1 - z * z);
  return [Math.cos(t) * r, z, Math.sin(t) * r];
}

export function createPlane(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  let W = 300, H = 300, dpr = 1;
  let nodes = [];            // incoming data
  let edges = [];
  const agents = new Map();  // id -> { p: [x,y,z], t: [x,y,z], node, a }  (unit-sphere coordinates)
  const shell = new Map();   // id -> { p: [x,y,z], node }
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
    geom = { cx: W / 2, cy: H / 2, R: Math.min(W, H) * 0.38 };
  }

  // Fibonacci sphere over the sorted list, so each group fills one contiguous band.
  function layoutShell() {
    const fixed = nodes.filter((n) => n.kind !== "agent")
      .sort((a, b) => (a.group || "").localeCompare(b.group || "", undefined, { numeric: true }) ||
        a.id.localeCompare(b.id, undefined, { numeric: true }));
    shell.clear(); groups = [];
    const N = Math.max(1, fixed.length);
    const at = (i) => {
      const y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(Math.max(0, 1 - y * y)), t = i * GOLDEN;
      return [Math.cos(t) * r, y, Math.sin(t) * r];
    };
    fixed.forEach((n, i) => shell.set(n.id, { node: n, p: at(i) }));
    const keys = [...new Set(fixed.map((n) => n.group || ""))];
    for (const k of keys) {
      const idx = fixed.map((n, i) => ((n.group || "") === k ? i : -1)).filter((i) => i >= 0);
      const mid = idx[Math.floor(idx.length / 2)];
      const p = at(mid);
      groups.push({ label: fixed[mid].groupLabel || k, p: [p[0] * 1.18, p[1] * 1.18, p[2] * 1.18] });
    }
  }

  function setData(plane) {
    nodes = (plane && plane.nodes) || [];
    edges = (plane && plane.edges) || [];
    layoutShell();
    const seen = new Set();
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      seen.add(n.id);
      let a = agents.get(n.id);
      if (!a) {
        const d = dirOf(n.id);
        a = { p: [d[0] * 0.03, d[1] * 0.03, d[2] * 0.03], t: [0, 0, 0], node: n, a: 0 };
        agents.set(n.id, a);
      }
      a.node = n;
    }
    for (const id of agents.keys()) if (!seen.has(id)) agents.delete(id);
    start();
  }

  function computeTargets() {
    const list = [...agents.values()];
    const pull = new Map();   // agent id -> summed directions of the surface nodes it is using
    for (const e of edges) {
      if (!(e.active || e.pulse)) continue;
      for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
        if (agents.has(a) && shell.has(b)) {
          const q = pull.get(a) || [0, 0, 0, 0];
          const s = shell.get(b).p; q[0] += s[0]; q[1] += s[1]; q[2] += s[2]; q[3]++; pull.set(a, q);
        }
      }
    }
    const space = Math.max(0.09, Math.min(0.2, 1.1 / Math.cbrt(Math.max(1, list.length))));
    for (const a of list) {
      const rad = Math.min(0.78, 0.14 + 0.2 * (a.node.tier || 0));
      const d = dirOf(a.node.id);
      const t = [d[0] * rad, d[1] * rad, d[2] * rad];
      const q = pull.get(a.node.id);
      if (q) {
        const k = 0.45; // pulled partway toward the tools it is using
        for (let i = 0; i < 3; i++) t[i] += ((q[i] / q[3]) * 0.7 - t[i]) * k;
      }
      a.t = t;
    }
    // personal space: push targets apart (a few relaxation passes), keep inside the sphere
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i].t, B = list[j].t;
          let dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
          let d = Math.hypot(dx, dy, dz);
          if (d >= space) continue;
          if (d < 1e-4) { [dx, dy, dz] = dirOf(list[i].node.id + list[j].node.id); d = 1; }
          const push = (space - d) / 2 / d;
          A[0] -= dx * push; A[1] -= dy * push; A[2] -= dz * push;
          B[0] += dx * push; B[1] += dy * push; B[2] += dz * push;
        }
      }
    }
    for (const a of list) {
      const d = Math.hypot(...a.t);
      if (d > 0.88) a.t = a.t.map((v) => (v / d) * 0.88);
    }
  }

  // Rotate (yaw about y, then pitch about x), then a gentle perspective. depth: 0 back .. 1 front.
  function project(p) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy;
    const y2 = p[1] * cp - z1 * sp, z2 = p[1] * sp + z1 * cp;
    const f = 3.2 / (3.2 - z2);
    const { cx, cy: ccy, R } = geom;
    return { x: cx + x1 * R * f, y: ccy - y2 * R * f, f, depth: (z2 + 1) / 2 };
  }
  const fade = (depth) => NEAR + (1 - NEAR) * Math.max(0, Math.min(1, depth));

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

  function draw(c, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { cx, cy, R } = geom;
    // perimeter (the sphere's outline) and its equator
    ctx.globalAlpha = 0.18; ctx.strokeStyle = c.ring; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.1; ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * TAU, q = project([Math.cos(t), 0, Math.sin(t)]);
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    }
    ctx.stroke();
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
      const dim = fade(q.depth);
      if (s) {
        const h = 2.6 * q.f;
        ctx.globalAlpha = 0.9 * dim; ctx.fillStyle = c.square;
        ctx.fillRect(q.x - h, q.y - h, h * 2, h * 2);
        continue;
      }
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
