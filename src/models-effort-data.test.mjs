// node --test src/models-effort-data.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  modelLabel, ELEMENT_SYMBOL, allEfforts, yMetrics, visiblePoints, frontier, newestPerClass, logTicks, niceTicks,
  placeLabels, ladderGain, fmtValue, fmtX, LADDER,
} from "./models-effort-data.js";

const model = (org, cls, version, points = []) => ({ model_id: `${org}/${cls}-${version}`, org, class: cls, version, display_name: `${cls} ${version}`, live: true, last_seen: "2026-11-20", points });
const pt = (effort, y, x) => ({ effort, observed_at: "2026-11-20", values: { aa_intelligence_index: y, aa_cost_per_task: x } });
const IDS = { xId: "aa_cost_per_task", yId: "aa_intelligence_index" };

test("labels: class with version, Gemini 4 classes by atomic symbol", () => {
  assert.deepEqual(modelLabel(model("OpenAI", "Astra", "6.2")), { base: "Astra", sub: "6.2", text: "Astra 6.2" });
  assert.deepEqual(modelLabel(model("OpenAI", "Luna", "6")), { base: "Luna", sub: "6", text: "Luna 6" });
  assert.deepEqual(modelLabel(model("Anthropic", "Fable", "5.1")), { base: "Fable", sub: "5.1", text: "Fable 5.1" });
  assert.deepEqual(modelLabel(model("Anthropic", "Mythos", "5.5")), { base: "Mythos", sub: "5.5", text: "Mythos 5.5" });
  for (const [cls, sym] of [["Hydrogen", "H"], ["Carbon", "C"], ["Neon", "Ne"], ["Argon", "Ar"], ["Helium", "He"], ["Xenon", "Xe"]]) {
    assert.deepEqual(modelLabel(model("Google", cls, "4")), { base: "Gemini", sub: sym, text: `Gemini ${sym}` });
  }
  assert.deepEqual(modelLabel(model("Google", "Flash", "3.8")), { base: "Gemini Flash", sub: "3.8", text: "Gemini Flash 3.8" });
});

test("the periodic table is complete", () => {
  assert.equal(new Set(Object.values(ELEMENT_SYMBOL)).size, 118);
  assert.equal(ELEMENT_SYMBOL.Oganesson, "Og");
  assert.equal(ELEMENT_SYMBOL.Aluminum, ELEMENT_SYMBOL.Aluminium);
});

test("visible points need the effort switched on and both axis numbers", () => {
  const m = model("OpenAI", "Luna", "6", [pt("none", 9, 0.07), pt("low", 10, 0.005), pt("max", 28, null), pt("high", null, 0.07)]);
  const got = visiblePoints(m, { ...IDS, efforts: new Set(["none", "low", "max", "high"]) });
  assert.deepEqual(got.map((p) => p.effort), ["none", "low"]);                // max has no cost, high has no score
  const only = visiblePoints(m, { ...IDS, efforts: new Set(["low"]) });
  assert.deepEqual(only.map((p) => [p.effort, p.x, p.y]), [["low", 0.005, 10]]);
});

test("the frontier keeps points nothing else beats on both cost and score", () => {
  const a = { x: 1, y: 10 }, b = { x: 2, y: 30 }, c = { x: 3, y: 20 }, d = { x: 5, y: 40 }, e = { x: 5, y: 40 };
  assert.deepEqual(frontier([a, b, c, d]), [a, b, d]);                        // c is dearer and worse than b
  assert.equal(frontier([d, e]).length, 2);                                   // identical points do not knock each other out
});

test("newest version of each class", () => {
  const ms = [model("OpenAI", "Astra", "6"), model("OpenAI", "Astra", "6.2"), model("OpenAI", "Sol", "6.1"), model("OpenAI", "Sol", "6.2"),
    model("OpenAI", "Sol", "6.10"), model("Anthropic", "Fable", "5.1"), model("Anthropic", "Fable", "5.2"), model("Google", "Neon", "4")];
  const keep = newestPerClass(ms);
  assert.deepEqual([...keep].sort(), ["Anthropic/Fable-5.2", "Google/Neon-4", "OpenAI/Astra-6.2", "OpenAI/Sol-6.10"]);   // 6.10 is after 6.2
});

test("log ticks stay round and thin out when room is short", () => {
  assert.deepEqual(logTicks(0.8, 30), [1, 2, 5, 10, 20]);
  const wide = logTicks(0.004, 40, 9);
  assert.ok(wide.length <= 9 && wide.length >= 2, wide.join(","));
  assert.ok(wide.every((t) => t >= 0.004 && t <= 40));
  assert.deepEqual(logTicks(0.004, 40, 4), [0.01, 0.1, 1, 10]);
});

test("nice ticks cover the range", () => {
  const t = niceTicks(9.4, 64.6, 6);
  assert.ok(t[0] <= 9.4 && t[t.length - 1] >= 64.6);
});

test("labels do not overlap and stay on the chart", () => {
  const items = [{ id: "a", x: 100, y: 100, w: 60 }, { id: "b", x: 110, y: 104, w: 60 }, { id: "c", x: 105, y: 108, w: 60 }, { id: "far", x: 500, y: 102, w: 60 }];
  const out = placeLabels(items, { gap: 16, width: 520, top: 10, bottom: 400 });
  const ys = ["a", "b", "c"].map((k) => out.get(k).y).sort((p, q) => p - q);
  assert.ok(ys[1] - ys[0] >= 16 && ys[2] - ys[1] >= 16, ys.join(","));
  assert.equal(out.get("far").anchor, "end");                                 // 500 + 70 > 514: flips to the left of its point
  assert.equal(out.get("far").y, 102);                                        // different part of the chart: not pushed
  assert.equal(out.get("a").moved, false);
  assert.equal(out.get("c").moved, true);
});

test("ladder gain skips settings outside the ladder", () => {
  const m = model("OpenAI", "Luna", "6", [pt("none", 9.4, 0.07), pt("low", 9.7, 0.005), pt("max", 27.9, 0.152)]);
  const g = ladderGain(visiblePoints(m, { ...IDS, efforts: new Set(["none", "low", "max"]) }));
  assert.equal(g.lo.effort, "low");
  assert.equal(g.hi.effort, "max");
  assert.ok(Math.abs(g.dy - 18.2) < 1e-9);
  assert.ok(Math.abs(g.mult - 30.4) < 1e-9);
  assert.equal(ladderGain(visiblePoints(m, { ...IDS, efforts: new Set(["none", "low"]) })), null);   // one ladder point is no ladder
  assert.ok(LADDER.has("xhigh") && !LADDER.has("none") && !LADDER.has("default"));
});

test("number formats", () => {
  assert.equal(fmtValue({ unit: "USD" }, 26.54), "$26.5");
  assert.equal(fmtValue({ unit: "USD" }, 3.998), "$4.00");
  assert.equal(fmtValue({ unit: "USD" }, 0.005115), "$0.0051");
  assert.equal(fmtValue({ unit: "%" }, 63.04), "63.0%");
  assert.equal(fmtValue({ unit: "Elo" }, 1812.4), "1812");
  assert.equal(fmtX("aa_time_per_task", 25.7), "25.7 min");
});

// The committed data file: what the page loads must be usable by this logic.
const data = JSON.parse(fs.readFileSync(new URL("../public/projects/models/data/effort.json", import.meta.url), "utf8"));

test("the committed data has the three labs, every effort in order, and an Index to plot", () => {
  assert.deepEqual([...new Set(data.models.map((m) => m.org))].sort(), ["Anthropic", "Google", "OpenAI"]);
  const efforts = allEfforts(data);
  assert.deepEqual(efforts.filter((e) => data.effort_order.includes(e)), data.effort_order.filter((e) => efforts.includes(e)));
  assert.ok(yMetrics(data).some((m) => m.id === "aa_intelligence_index"));
  assert.ok(!yMetrics(data).some((m) => m.id === "aa_cost_per_task" || m.id === "aa_time_per_task"));
  for (const m of data.models) {
    const label = modelLabel(m);
    assert.ok(label.base && label.sub, m.model_id);
    assert.ok(m.points.length >= 1);
  }
  const live = data.models.filter((m) => m.live);
  assert.ok(live.length >= 8, "most models are live");
});
