"""Effort ladders for the "Frontier effort comparison" page (/projects/models/effort/).

Artificial Analysis lists every reasoning-effort setting of a model as its own leaderboard row ("Claude Opus 5.5 (Low)",
"... (Medium)", "... (Max)"). The main page keeps only the best row per model (aa_source.select); this module keeps every
row of the frontier families Preet tracks:

    OpenAI     GPT-6 and later          (Luna, Terra, Sol, Astra, and whatever is added next)
    Anthropic  Claude 5 and later       (Haiku, Sonnet, Opus, Fable, Mythos, ...)
    Google     Gemini 3.8 and later     (3.8 Flash, and the 4 series named after elements: Hydrogen, Carbon, Neon, Argon, ...)

Selection is by name pattern, not a fixed list, so a new member of a family (GPT-6.3 Sol, Gemini 4 Helium, Claude Mythos 5.5)
appears on its own the first time AA lists it. Special builds ("Astra for Law 6.2", "GPT-6 Sol (Daybreak Blue, max)") do not
match the patterns and stay out.

    python -m scraper.aa_effort refresh [--html F]   one GET (or a saved page) -> seed/effort/effort_obs.csv, append-only
    python -m scraper.aa_effort backfill             models AA has already dropped: their last single row from seed/aa/

Numbers are copied as published; nothing is estimated. A model AA stops listing keeps its last ladder in the history, and the
page marks it as no longer live.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from scraper import aa_source as aa

ROOT = Path(__file__).resolve().parent.parent
SEED_FILE = "effort/effort_obs.csv"

# Lowest to highest. "default" is a model that publishes one unlabelled reasoning setting; it is not part of the ladder.
EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
EFFORT_ALIAS = {"non-reasoning": "none", "reasoning": "default", "adaptive": "default", "default": "default", "": "default"}

_CLASS = r"([A-Z][\w-]*(?: [A-Z][\w-]*)*)"
# creator -> (pattern on the effort-free name, how to read it, minimum version as a tuple)
FAMILIES = {
    "OpenAI": (re.compile(rf"^GPT-(\d+(?:\.\d+)?) {_CLASS}$"), lambda m: (m.group(1), m.group(2)), (6,)),
    "Anthropic": (re.compile(rf"^Claude {_CLASS} (\d+(?:\.\d+)?)$"), lambda m: (m.group(2), m.group(1)), (5,)),
    "Google": (re.compile(rf"^Gemini (\d+(?:\.\d+)?) {_CLASS}$"), lambda m: (m.group(1), m.group(2)), (3, 8)),
}

# One column per number the page can plot. The Index, cost and time come first; the rest are AA's per-evaluation scores.
METRICS = ["aa_intelligence_index", "aa_cost_per_task", "aa_time_per_task", "aa_omniscience"] + \
    list(dict.fromkeys(bid for bid, _ in aa.SCORES.values()))
COLUMNS = ["obs_id", "model_id", "org", "class", "version", "display_name", "effort", "observed_at"] + METRICS


def version_key(v: str) -> tuple:
    return tuple(int(p) for p in v.split("."))


def effort_key(label: str) -> str:
    k = (label or "").strip().lower()
    return EFFORT_ALIAS.get(k, k)


def effort_rank(key: str) -> int:
    return EFFORT_ORDER.index(key) if key in EFFORT_ORDER else len(EFFORT_ORDER)


def classify(creator: str, base: str) -> dict | None:
    """('Anthropic', 'Claude Opus 5.5') -> {'org', 'class', 'version', 'display_name'}; None when it is not a tracked family."""
    rule = FAMILIES.get(creator)
    if not rule:
        return None
    pattern, read, minimum = rule
    m = pattern.match(base)
    if not m:
        return None
    version, cls = read(m)
    if version_key(version) < minimum:
        return None
    return {"org": creator, "class": cls, "version": version, "display_name": base}


def _sig(v: float, digits: int) -> str:
    return f"{float(f'{v:.{digits}g}'):g}"


def _num(v):
    return aa._num(v)


def metrics_of(rec: dict) -> dict[str, str]:
    """The record's plottable numbers as CSV text (blank when AA does not publish one)."""
    out = {m: "" for m in METRICS}
    idx, cost, t, omni = (_num(rec.get(k)) for k in ("intelligenceIndex", "intelligenceIndexCostPerTask",
                                                      "intelligenceIndexTimePerTask", "omniscience"))
    if idx is not None:
        out["aa_intelligence_index"] = f"{round(idx, 1)}"
    if cost is not None:
        out["aa_cost_per_task"] = _sig(cost, 4)             # small costs (a cent) must not round to zero
    if t is not None:
        out["aa_time_per_task"] = _sig(t / 60, 3)            # AA publishes seconds; the page shows minutes
    if omni is not None:
        out["aa_omniscience"] = f"{round(omni, 1)}"
    for key, (bid, mult) in aa.SCORES.items():
        v = _num((rec.get("scores") or {}).get(key))
        if v is not None:
            out[bid] = f"{round(v * mult, 1)}"
    return out


def ladders(recs: list[dict], day: str) -> list[dict]:
    """One row per (model, effort) for every tracked-family record AA lists, with an Intelligence Index."""
    best: dict[tuple, dict] = {}
    for rec in recs:
        if rec.get("deprecated") or not isinstance(rec.get("intelligenceIndex"), (int, float)):
            continue
        base, label = aa.base_name(rec["name"])
        info = classify(rec.get("modelCreatorName") or "", base)
        if not info:
            continue
        prefix, _ = aa.creator(rec)
        model_id = f"{prefix}/{aa.slugify(base)}"
        effort = effort_key(label)
        row = {"obs_id": f"effort-{day}-{model_id}-{effort}", "model_id": model_id, **info,
               "effort": effort, "observed_at": day, **metrics_of(rec)}
        cur = best.get((model_id, effort))
        if cur is None or float(row["aa_intelligence_index"]) > float(cur["aa_intelligence_index"]):
            best[(model_id, effort)] = row
    return sorted(best.values(), key=lambda r: (r["org"], r["class"], version_key(r["version"]), effort_rank(r["effort"])))


def read(seed: Path) -> list[dict]:
    path = Path(seed) / SEED_FILE
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != COLUMNS:
            raise ValueError(f"{SEED_FILE}: header is {reader.fieldnames}, expected {COLUMNS}")
        return list(reader)


def write(seed: Path, rows: list[dict]) -> int:
    """Append rows whose obs_id is new (a same-day rerun is a no-op). Returns how many were added."""
    path = Path(seed) / SEED_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    old = read(seed)
    have = {r["obs_id"] for r in old}
    new = [r for r in rows if r["obs_id"] not in have]
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows({k: r.get(k, "") for k in COLUMNS} for r in old + new)
    return len(new)


def refresh(recs: list[dict], day: str, seed: Path) -> dict:
    rows = ladders(recs, day)
    return {"rows": len(rows), "models": len({r["model_id"] for r in rows}), "added": write(seed, rows)}


def backfill(seed: Path) -> dict:
    """Models AA no longer lists, from the main seed's history: each one's latest day, at the single effort it was kept at.

    Only models with no effort rows yet are added, so once a live ladder exists it is never overwritten by this."""
    seed = Path(seed)
    have = {r["model_id"] for r in read(seed)}
    with (seed / "aa" / "models.csv").open(newline="", encoding="utf-8") as fh:
        models = {r["model_id"]: r for r in csv.DictReader(fh)}
    by_model: dict[str, list[dict]] = {}
    with (seed / "aa" / "score_obs.csv").open(newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["model_id"] in models and r["status"] == "observed":
                by_model.setdefault(r["model_id"], []).append(r)
    rows = []
    for mid, obs in sorted(by_model.items()):
        m = models[mid]
        info = classify(m["org"], m["display_name"])
        if not info or mid in have:
            continue
        last = max(o["observed_at"] for o in obs)
        today = [o for o in obs if o["observed_at"] == last]
        row = {"obs_id": f"effort-{last}-{mid}-{effort_key(today[0]['effort'])}", "model_id": mid, **info,
               "effort": effort_key(today[0]["effort"]), "observed_at": last, **{k: "" for k in METRICS}}
        for o in today:
            if o["benchmark_id"] in row and o["value"] != "":
                row[o["benchmark_id"]] = o["value"]
        if row["aa_intelligence_index"]:
            rows.append(row)
    return {"rows": len(rows), "models": sorted({r["model_id"] for r in rows}), "added": write(seed, rows)}


def main(argv=None) -> int:
    sys.path.insert(0, str(ROOT))
    import build_effort as be
    import build_snapshot as bs

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("refresh")
    r.add_argument("--html", type=Path, help="parse a saved page instead of fetching")
    r.add_argument("--day", help="observation date (default: today, UTC)")
    sub.add_parser("backfill")
    args = ap.parse_args(argv)
    if args.cmd == "backfill":
        out = backfill(bs.DEFAULT_SEED)
    else:
        html = args.html.read_text(encoding="utf-8", errors="replace") if args.html else aa.fetch_html()
        day = args.day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        out = refresh(aa.records(html), day, bs.DEFAULT_SEED)
    out["built"] = be.build(bs.DEFAULT_SEED)["counts"]
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
