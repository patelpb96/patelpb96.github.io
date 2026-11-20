"""Validate seed/effort/effort_obs.csv and write the static file the "Frontier effort comparison" page reads.

    python projects/model-tracker/build_effort.py            # validate, then write public/projects/models/data/effort.json
    python projects/model-tracker/build_effort.py --check    # validate only (exit 1 on any error)

Stdlib only. Deterministic like build_snapshot.py: the same CSV always gives the same bytes (no wall-clock stamp).
For each (model, effort) the newest observation wins. A model is "live" when it was seen on the newest day in the file;
one AA has stopped listing keeps its last ladder and is flagged live=false with the day it was last seen.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from scraper import aa_effort as ae

HERE = Path(__file__).resolve().parent
DEFAULT_SEED = HERE / "seed"
DEFAULT_OUT = HERE.parent.parent / "public" / "projects" / "models" / "data" / "effort.json"

SOURCE = {"name": "Artificial Analysis", "url": "https://artificialanalysis.ai/"}
NOTE = ("Every number is Artificial Analysis's own measurement of one reasoning-effort setting of one model, copied as published "
        "(artificialanalysis.ai). Cost and time are what it took to run AA's Intelligence Index tasks at that setting, so they "
        "move with how much the model thinks. A model AA has stopped listing keeps its last published setting and is marked "
        "as not live. Effort names differ between labs (Gemini stops at high, Claude and GPT go to max), so compare ladders "
        "for shape rather than matching names one to one. More effort does not always score higher.")


def _bool(v: str) -> bool:
    return v.strip().lower() == "true"


def load(seed: Path, errors: list[str]) -> tuple[list[dict], dict[str, dict]]:
    try:
        rows = ae.read(seed)
    except ValueError as e:
        errors.append(str(e))
        return [], {}
    bench = {}
    path = Path(seed) / "benchmarks.csv"
    with path.open(newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            bench[r["benchmark_id"]] = r
    seen = set()
    for i, r in enumerate(rows, start=2):
        where = f"{ae.SEED_FILE} line {i}"
        if r["obs_id"] in seen:
            errors.append(f"{where}: duplicate obs_id {r['obs_id']}")
        seen.add(r["obs_id"])
        if not r["observed_at"][:4].isdigit():
            errors.append(f"{where}: observed_at={r['observed_at']!r} is not a date")
        if not r["aa_intelligence_index"]:
            errors.append(f"{where}: {r['model_id']} {r['effort']} has no Intelligence Index")
        for m in ae.METRICS:
            if r[m] == "":
                continue
            try:
                float(r[m])
            except ValueError:
                errors.append(f"{where}: {m}={r[m]!r} is not a number")
    for m in ae.METRICS:
        if m not in bench:
            errors.append(f"benchmarks.csv: no entry for {m}")
    return rows, bench


def build(seed: Path = DEFAULT_SEED, out: Path | None = DEFAULT_OUT) -> dict:
    errors: list[str] = []
    rows, bench = load(Path(seed), errors)
    if errors:
        raise ValueError("; ".join(errors[:8]) + (f" (+{len(errors) - 8} more)" if len(errors) > 8 else ""))
    as_of = max((r["observed_at"] for r in rows), default="")

    newest: dict[tuple, dict] = {}
    for r in rows:
        k = (r["model_id"], r["effort"])
        if k not in newest or (r["observed_at"], r["obs_id"]) > (newest[k]["observed_at"], newest[k]["obs_id"]):
            newest[k] = r
    by_model: dict[str, list[dict]] = {}
    for r in newest.values():
        by_model.setdefault(r["model_id"], []).append(r)

    models = []
    used = set()
    for mid, pts in by_model.items():
        pts.sort(key=lambda r: (ae.effort_rank(r["effort"]), r["effort"]))
        # A ladder is read as of the day the model was last listed; settings AA dropped earlier are not mixed in.
        last = max(p["observed_at"] for p in pts)
        pts = [p for p in pts if p["observed_at"] == last]
        head = pts[0]
        points = []
        for p in pts:
            values = {m: float(p[m]) for m in ae.METRICS if p[m] != ""}
            used.update(values)
            points.append({"effort": p["effort"], "observed_at": p["observed_at"], "values": values})
        models.append({"model_id": mid, "org": head["org"], "class": head["class"], "version": head["version"],
                       "display_name": head["display_name"], "live": last == as_of, "last_seen": last, "points": points})
    models.sort(key=lambda m: (m["org"], m["class"], ae.version_key(m["version"])))

    metrics = [{"id": b["benchmark_id"], "name": b["name"], "category": b["category"], "unit": b["unit"],
                "higher_is_better": _bool(b["higher_is_better"]), "blurb": b["blurb"]}
               for m in ae.METRICS if m in used for b in [bench[m]]]
    data = {"title": "Frontier effort comparison", "as_of": as_of, "source": SOURCE, "note": NOTE,
            "effort_order": ae.EFFORT_ORDER, "metrics": metrics, "models": models,
            "counts": {"models": len(models), "live": sum(1 for m in models if m["live"]),
                       "settings": sum(len(m["points"]) for m in models)}}
    if out is not None:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return data


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="validate only")
    ap.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    try:
        data = build(args.seed, None if args.check else args.out)
    except ValueError as e:
        print(f"effort seed invalid: {e}", file=sys.stderr)
        return 1
    print(data["counts"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
