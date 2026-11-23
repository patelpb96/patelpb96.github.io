// Phone layouts for the model tracker's charts, as switchable previews. Each variant only changes charts drawn narrower
// than NARROW px; the desktop page is untouched. Pick one with ?m=a|b|c (remembered per viewer) or the switch the
// dev server shows above the page; "off" is the layout the live site has today.
import { useEffect, useState } from "react";

export const NARROW = 560;
export const MOBILE_VARIANTS = [
  ["off", "Today"],
  ["a", "A · Spotlight"],
  ["b", "B · Top tier"],
  ["c", "C · Rows"],
];
const KEY = "models-mobile";
const EVT = "models-mobile-change";
const valid = (v) => MOBILE_VARIANTS.some(([id]) => id === v);

function readVariant() {
  try {
    const q = new URLSearchParams(window.location.search).get("m");
    if (valid(q)) { localStorage.setItem(KEY, q); return q; }
    const s = localStorage.getItem(KEY);
    if (valid(s)) return s;
  } catch { /* storage blocked: fall through to the default */ }
  return "off";
}

// One variant shared by both views (the models tab and the lazy effort tab), kept in step through a window event.
export function useMobileVariant() {
  const [v, setV] = useState(readVariant);
  useEffect(() => {
    const on = (e) => setV(e.detail);
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  const set = (next) => {
    try { localStorage.setItem(KEY, next); } catch { /* keep the in-memory choice */ }
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("m", next);
      window.history.replaceState(null, "", u);
    } catch { /* the URL is a convenience */ }
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }));
  };
  return [v, set];
}

// True while the viewport is phone-sized; drives choices made before a chart has measured itself (layout defaults).
export function useNarrow() {
  const q = `(max-width: ${NARROW - 1}px)`;
  const [n, setN] = useState(() => typeof window !== "undefined" && window.matchMedia && window.matchMedia(q).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(q);
    const on = () => setN(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return n;
}

// A model is superseded when the same company lists a newer version of the same line: GPT-6.2 Astra replaces GPT-6 Astra,
// Claude Fable 5.2 replaces 5.1, Qwen4 Max replaces Qwen3.8 Max (0902). The line is the name with its numbers and any
// bracketed suffix removed; the version is the first number in the name. Release dates are mostly missing from the data,
// so this is the only "older" signal that does not guess.
const lineOf = (name) => name.replace(/\(.*?\)/g, "").replace(/[\d.]+/g, "").replace(/[\s-]+/g, " ").trim().toLowerCase();
const versionOf = (name) => (name.match(/\d+(?:\.\d+)*/) || ["0"])[0].split(".").map(Number);
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
};
export function supersededIds(models) {
  const best = new Map();
  for (const m of models) {
    const k = `${m.org}|${lineOf(m.display_name)}`;
    const cur = best.get(k);
    if (!cur || cmp(versionOf(m.display_name), versionOf(cur.display_name)) > 0) best.set(k, m);
  }
  return new Set(models.filter((m) => best.get(`${m.org}|${lineOf(m.display_name)}`) !== m).map((m) => m.model_id));
}

// A short on-chart name: "Claude Fable 5.2" -> "Fable 5.2", "GPT-6.2 Astra" -> "Astra 6.2", "Gemini 4 Neon" -> "Gemini Neon".
export function shortName(name) {
  let m = name.match(/^GPT-([\d.]+)\s+(.+)$/);
  if (m) return `${m[2]} ${m[1]}`;
  m = name.match(/^Gemini\s+4\s+(.+)$/);
  if (m) return `Gemini ${m[1]}`;
  const s = name.replace(/^Claude\s+/, "").replace(/\s*\(.*?\)/, "");
  return s.length > 15 ? `${s.slice(0, 14)}…` : s;
}

// Rough width of a label in px, erring long (bold serif averages about 0.6 em per character).
export const labelWidth = (text, fs) => text.length * fs * 0.64 + 8;

// After placeLabels: pull any label that would run off either edge back inside by flipping its side, then drop any label
// that still lands on another one (a phone has no room to nudge further; tapping the mark still names it).
export function keepInside(placed, items, W, pad = 4, gap = 13) {
  const kept = [];
  for (const it of [...items].sort((a, b) => a.y - b.y)) {      // top of the chart (the higher score) keeps its label first
    let at = placed.get(it.id);
    if (!at) continue;
    const x0 = at.anchor === "start" ? at.x : at.x - it.w;
    if (x0 + it.w > W - pad) at = { ...at, x: it.x - 9, anchor: "end" };
    else if (x0 < pad) at = { ...at, x: it.x + 9, anchor: "start" };
    const box = { x0: at.anchor === "start" ? at.x : at.x - it.w, w: it.w, y: at.y };
    if (kept.some((k) => Math.abs(k.y - box.y) < gap && k.x0 < box.x0 + box.w && box.x0 < k.x0 + k.w)) placed.delete(it.id);
    else { placed.set(it.id, at); kept.push(box); }
  }
  return placed;
}
