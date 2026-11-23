// Pure logic for the "Frontier effort comparison" page (/projects/models/effort/): labels, axes, ladders, frontier,
// label placement. No React and no DOM, so `node --test src/models-effort-data.test.mjs` exercises all of it.
// The page reads public/projects/models/data/effort.json (built by projects/model-tracker/build_effort.py).

export const DATA_URL = "/projects/models/data/effort.json";

// Periodic table, name -> symbol. Gemini 4's classes are named after elements (Hydrogen, Carbon, Neon, Argon, ...), and the
// chart labels them with the symbol as a subscript on "Gemini". Every element is listed so a new one (Helium, Xenon, ...)
// is labelled on arrival without a code change.
const SYMBOLS = ("H Hydrogen,He Helium,Li Lithium,Be Beryllium,B Boron,C Carbon,N Nitrogen,O Oxygen,F Fluorine,Ne Neon,Na Sodium,Mg Magnesium,"
  + "Al Aluminium,Al Aluminum,Si Silicon,P Phosphorus,S Sulfur,S Sulphur,Cl Chlorine,Ar Argon,K Potassium,Ca Calcium,Sc Scandium,Ti Titanium,"
  + "V Vanadium,Cr Chromium,Mn Manganese,Fe Iron,Co Cobalt,Ni Nickel,Cu Copper,Zn Zinc,Ga Gallium,Ge Germanium,As Arsenic,Se Selenium,"
  + "Br Bromine,Kr Krypton,Rb Rubidium,Sr Strontium,Y Yttrium,Zr Zirconium,Nb Niobium,Mo Molybdenum,Tc Technetium,Ru Ruthenium,Rh Rhodium,"
  + "Pd Palladium,Ag Silver,Cd Cadmium,In Indium,Sn Tin,Sb Antimony,Te Tellurium,I Iodine,Xe Xenon,Cs Caesium,Cs Cesium,Ba Barium,"
  + "La Lanthanum,Ce Cerium,Pr Praseodymium,Nd Neodymium,Pm Promethium,Sm Samarium,Eu Europium,Gd Gadolinium,Tb Terbium,Dy Dysprosium,"
  + "Ho Holmium,Er Erbium,Tm Thulium,Yb Ytterbium,Lu Lutetium,Hf Hafnium,Ta Tantalum,W Tungsten,Re Rhenium,Os Osmium,Ir Iridium,Pt Platinum,"
  + "Au Gold,Hg Mercury,Tl Thallium,Pb Lead,Bi Bismuth,Po Polonium,At Astatine,Rn Radon,Fr Francium,Ra Radium,Ac Actinium,Th Thorium,"
  + "Pa Protactinium,U Uranium,Np Neptunium,Pu Plutonium,Am Americium,Cm Curium,Bk Berkelium,Cf Californium,Es Einsteinium,Fm Fermium,"
  + "Md Mendelevium,No Nobelium,Lr Lawrencium,Rf Rutherfordium,Db Dubnium,Sg Seaborgium,Bh Bohrium,Hs Hassium,Mt Meitnerium,Ds Darmstadtium,"
  + "Rg Roentgenium,Cn Copernicium,Nh Nihonium,Fl Flerovium,Mc Moscovium,Lv Livermorium,Ts Tennessine,Og Oganesson")
  .split(",").reduce((m, pair) => { const [sym, name] = pair.split(" "); m[name] = sym; return m; }, {});

export const ELEMENT_SYMBOL = SYMBOLS;

// The chart label: a base word with a subscript.
//   OpenAI / Anthropic: the class with its version        Astra_6.2   Fable_5.2   Opus_5.5   Luna_6
//   Gemini 4 classes:   "Gemini" with the element symbol  Gemini_Ar   Gemini_Ne
//   other Gemini:       the class with its version         Gemini Flash_3.8
// `text` is the plain-text form for aria labels and the table.
export function modelLabel(m) {
  if (m.org === "Google") {
    const sym = SYMBOLS[m.class];
    if (sym) return { base: "Gemini", sub: sym, text: `Gemini ${sym}` };
    return { base: `Gemini ${m.class}`, sub: m.version, text: `Gemini ${m.class} ${m.version}` };
  }
  return { base: m.class, sub: m.version, text: `${m.class} ${m.version}` };
}

export const LAB_COLOR = { OpenAI: "var(--s3)", Anthropic: "var(--s2)", Google: "var(--s1)" };
export const labColor = (org) => LAB_COLOR[org] || "var(--s8)";

// Effort levels: name on screen and the half-side of the marker (bigger square = more effort).
export const EFFORT = {
  none: { label: "No reasoning", half: 3.5 }, minimal: { label: "Minimal", half: 3.5 }, low: { label: "Low", half: 4 },
  medium: { label: "Medium", half: 5 }, high: { label: "High", half: 6 }, xhigh: { label: "X-high", half: 6.75 },
  max: { label: "Max", half: 7.5 }, default: { label: "Default setting", half: 5 },
};
export const effortLabel = (e) => (EFFORT[e] ? EFFORT[e].label : e);
export const effortHalf = (e) => (EFFORT[e] ? EFFORT[e].half : 5);
// The ladder is the line through a model's settings; "no reasoning" and a lab's single unlabelled setting stand alone.
export const LADDER = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function allEfforts(data) {
  const present = new Set(data.models.flatMap((m) => m.points.map((p) => p.effort)));
  const known = data.effort_order.filter((e) => present.has(e));
  return [...known, ...[...present].filter((e) => !known.includes(e)).sort()];
}

export const X_OPTIONS = [["aa_cost_per_task", "Cost per task"], ["aa_time_per_task", "Time per task"]];
const NOT_Y = new Set(["cost", "speed", "latency", "spec"]);
export const yMetrics = (data) => data.metrics.filter((m) => m.higher_is_better && !NOT_Y.has(m.category));

export function fmtValue(metric, v) {
  if (v == null) return "";
  const u = metric && metric.unit;
  if (u === "USD") return v >= 10 ? `$${v.toFixed(1)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toPrecision(2)}`;
  if (u === "minutes") return `${v.toFixed(1)} min`;
  if (u === "%") return `${v.toFixed(1)}%`;
  if (u === "Elo") return `${Math.round(v)}`;
  if (u === "ln") return v.toFixed(2);              // the superscore is a log: two decimals, as on the main page
  return v.toFixed(1);
}
export const fmtX = (xId, v) => fmtValue({ unit: xId === "aa_cost_per_task" ? "USD" : "minutes" }, v);

// A model's settings that can be drawn: the effort is switched on, and both axes have a number for it.
export function visiblePoints(model, { xId, yId, efforts }) {
  return model.points
    .filter((p) => efforts.has(p.effort) && p.values[xId] > 0 && p.values[yId] != null)
    .map((p) => ({ model, effort: p.effort, observed_at: p.observed_at, x: p.values[xId], y: p.values[yId], values: p.values }));
}

// Efficient frontier over every visible setting of every model: nothing else is as cheap (or quick) and scores as well.
export function frontier(pts) {
  return pts
    .filter((p) => !pts.some((q) => q !== p && q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y)))
    .sort((a, b) => a.x - b.x);
}

const versionKey = (v) => v.split(".").map(Number);
function newer(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
// The newest version of each (company, class): Astra 6.2 but not Astra 6, Sol 6.2 but not Sol 6.1.
export function newestPerClass(models) {
  const best = new Map();
  for (const m of models) {
    const k = `${m.org}|${m.class}`;
    if (!best.has(k) || newer(m.version, best.get(k).version)) best.set(k, m);
  }
  return new Set([...best.values()].map((m) => m.model_id));
}

// Round-number ticks for a linear axis.
export function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / Math.max(1, n - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

// Ticks for a log axis: 1-2-5 per decade when there is room, thinner when there is not.
export function logTicks(lo, hi, max = 9) {
  const sets = [[1, 2, 5], [1, 3], [1]];
  const pick = (mults) => {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)); e++) {
      for (const m of mults) {
        const t = +(m * 10 ** e).toPrecision(3);
        if (t >= lo && t <= hi) out.push(t);
      }
    }
    return out;
  };
  for (const s of sets) { const t = pick(s); if (t.length <= max && t.length >= 2) return t; }
  return pick([1]);
}

// Places each label beside its point and keeps it off the other labels AND off every marker. Tries, in order, right, above-right
// and below-right (left first when the label would run off the right edge), then the same on the other side; if every spot is
// taken it nudges down from the first choice. `items`: {id, x, y, w}; `obstacles`: {id, x, y, r} marker boxes (a label ignores its
// own marker). Returns Map id -> {x, y, anchor, moved}; `moved` is true when the label sits away from its point enough to want a leader.
export function placeLabels(items, { gap, width, top, bottom, edge = 6, obstacles = [] }) {
  const placed = [];
  const out = new Map();
  const clampY = (y) => Math.min(Math.max(y, top), bottom);
  const hitsMarker = (id, x0, w, y) => obstacles.some((o) => o.id !== id && o.x > x0 - o.r && o.x < x0 + w + o.r && o.y > y - gap + 3 - o.r && o.y < y + 3 + o.r);
  const clash = (id, x0, w, y) => placed.some((p) => Math.abs(p.y - y) < gap && p.x0 < x0 + w && x0 < p.x0 + p.w) || hitsMarker(id, x0, w, y);
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const right = { x: it.x + 10, anchor: "start", x0: it.x + 10 };
    const left = { x: it.x - 10, anchor: "end", x0: it.x - 10 - it.w };
    const sides = it.x + 10 + it.w > width - edge ? [left, right] : [right, left];
    let spot = null;
    for (const s of sides) {
      for (const dy of [0, -gap, gap]) {
        const y = clampY(it.y + dy);
        if (!clash(it.id, s.x0, it.w, y)) { spot = { s, y }; break; }
      }
      if (spot) break;
    }
    if (!spot) {
      const s = sides[0];
      let y = it.y;
      for (let guard = 0; guard < 60; guard++) {
        const hit = placed.find((p) => Math.abs(p.y - y) < gap && p.x0 < s.x0 + it.w && s.x0 < p.x0 + p.w);
        if (!hit) break;
        y = hit.y + gap;
      }
      spot = { s, y: clampY(y) };
    }
    placed.push({ x0: spot.s.x0, w: it.w, y: spot.y });
    out.set(it.id, { x: spot.s.x, y: spot.y, anchor: spot.s.anchor, moved: Math.abs(spot.y - it.y) > 5 });
  }
  return out;
}

// Axis domain for a set of points: log-x bounds and the raw y bounds (the chart rounds y to tick values).
export function domainOf(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const pad = Math.max((ymax - ymin) * 0.06, 1);
  return {
    xlo: Math.min(...xs) * 0.8, xhi: Math.max(...xs) * 1.3,
    lo: ymin >= 0 ? Math.max(0, ymin - pad) : ymin - pad,
    hi: ymax <= 100 ? Math.min(100, ymax + pad) : ymax + pad,
  };
}

// The efficient frontier as a staircase: at each cost, the best score you can have for that much or less.
export function stairPath(front, fx, fy) {
  return front.map((p, i) => (i === 0 ? `M${fx(p.x)} ${fy(p.y)}` : `H${fx(p.x)}V${fy(p.y)}`)).join("");
}

// One marker shape per company (hue alone would not separate red from green): square, diamond, triangle. All sharp-cornered.
export const LAB_SHAPE = { OpenAI: "square", Anthropic: "diamond", Google: "triangle" };
export function markPath(shape, h) {
  if (shape === "diamond") { const k = h * 1.35; return `M0 ${-k}L${k} 0L0 ${k}L${-k} 0Z`; }
  if (shape === "triangle") { const k = h * 1.3; return `M0 ${-k}L${k * 0.95} ${k * 0.75}L${-k * 0.95} ${k * 0.75}Z`; }
  return `M${-h} ${-h}H${h}V${h}H${-h}Z`;
}
export const EFFORT_SHORT = { none: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhigh", max: "max", default: "default" };

// Distance from point (px, py) to the segment (x1, y1)-(x2, y2).
export function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Table helpers: the gain from a model's lowest setting to its highest, and what that cost.
export function ladderGain(pts) {
  const line = pts.filter((p) => LADDER.has(p.effort));
  if (line.length < 2) return null;
  const lo = line[0], hi = line[line.length - 1];
  return { lo, hi, dy: hi.y - lo.y, mult: hi.x / lo.x };
}
