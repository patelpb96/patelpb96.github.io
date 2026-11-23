// Phone layout helpers for the model tracker's charts. Below NARROW px the charts switch to their phone layout: the scatter
// zooms to the top tier with every logo named, the effort view shows a panel per company zoomed to its own data, and both put
// the vertical axis title above the plot. The desktop page is untouched.
import { useEffect, useState } from "react";

export const NARROW = 560;

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
