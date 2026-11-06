"""Validate the seed CSVs and write the static snapshot the models page reads.

    python projects/model-tracker/build_snapshot.py            # validate, then write the snapshot
    python projects/model-tracker/build_snapshot.py --check    # validate only (exit 1 on any error)

Stdlib only. Deterministic: the same CSVs always give the same bytes (no wall-clock stamp), so a
git diff of the snapshot shows exactly what changed. The checks below are the deterministic rules
from PLAN.md; the pipeline's loader must apply the same ones before anything reaches Snowflake.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SEED = HERE / "seed"
DEFAULT_OUT = HERE.parent.parent / "public" / "projects" / "models" / "data" / "latest.json"

PROVENANCE = {"self_reported", "third_party", "third_party_aggregator", "community", "manual_entry"}
ORIGIN = {"scraped", "manual"}
STATUS = {"observed", "not_observed"}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$")

TABLES = {
    "models": ["model_id", "org", "family", "version_label", "display_name", "class", "open_weights", "release_date", "origin"],
    "benchmarks": ["benchmark_id", "name", "version", "category", "blurb", "higher_is_better", "unit"],
    "score_obs": ["obs_id", "model_id", "benchmark_id", "value", "status", "reported_date", "observed_at", "effort",
                  "shots", "tools", "provenance", "source_name", "source_url", "origin"],
    "price_obs": ["obs_id", "model_id", "provider", "input_per_1m", "output_per_1m", "blended_3to1_per_1m",
                  "reported_date", "observed_at", "provenance", "source_name", "source_url", "origin"],
    "speed_obs": ["obs_id", "model_id", "provider", "tok_per_s", "reported_date", "observed_at", "provenance",
                  "source_name", "source_url", "origin"],
}


def read_csv(path: Path, columns: list[str], errors: list[str]) -> list[dict]:
    if not path.exists():
        errors.append(f"{path.name}: missing")
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != columns:
            errors.append(f"{path.name}: header is {reader.fieldnames}, expected {columns}")
            return []
        return [{k: (v or "").strip() for k, v in row.items()} for row in reader]


def number(row: dict, field: str, where: str, errors: list[str]) -> float | None:
    raw = row[field]
    if raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        errors.append(f"{where}: {field}={raw!r} is not a number")
        return None


def check_common(row: dict, where: str, history_start: str, errors: list[str]) -> None:
    if row["provenance"] not in PROVENANCE:
        errors.append(f"{where}: provenance {row['provenance']!r} not in {sorted(PROVENANCE)}")
    if row["origin"] not in ORIGIN:
        errors.append(f"{where}: origin {row['origin']!r} not in {sorted(ORIGIN)}")
    if not DATE.match(row["observed_at"]):
        errors.append(f"{where}: observed_at {row['observed_at']!r} is not a date")
    if row["reported_date"]:
        if not DATE.match(row["reported_date"]):
            errors.append(f"{where}: reported_date {row['reported_date']!r} is not a date")
        elif row["reported_date"][:10] < history_start:
            errors.append(f"{where}: reported_date {row['reported_date']} is before history_start {history_start}")
    if row["source_url"] and not row["source_url"].startswith("https://"):
        errors.append(f"{where}: source_url must be https")


def build(seed: Path) -> tuple[dict | None, list[str]]:
    errors: list[str] = []
    meta = json.loads((seed / "meta.json").read_text(encoding="utf-8"))
    history_start = meta["history_start"]
    data = {name: read_csv(seed / f"{name}.csv", cols, errors) for name, cols in TABLES.items()}

    model_ids, bench_ids, obs_ids = set(), set(), set()
    for m in data["models"]:
        where = f"models[{m['model_id']}]"
        if not m["model_id"] or m["model_id"] in model_ids:
            errors.append(f"{where}: empty or duplicate model_id")
        model_ids.add(m["model_id"])
        if m["origin"] not in ORIGIN:
            errors.append(f"{where}: origin {m['origin']!r}")
        if m["open_weights"] not in {"true", "false", ""}:
            errors.append(f"{where}: open_weights must be true, false or blank")
        if m["release_date"] and not DATE.match(m["release_date"]):
            errors.append(f"{where}: release_date {m['release_date']!r}")
    for b in data["benchmarks"]:
        where = f"benchmarks[{b['benchmark_id']}]"
        if not b["benchmark_id"] or b["benchmark_id"] in bench_ids:
            errors.append(f"{where}: empty or duplicate benchmark_id")
        bench_ids.add(b["benchmark_id"])
        if b["higher_is_better"] not in {"true", "false"}:
            errors.append(f"{where}: higher_is_better must be true or false")

    scores, prices, speeds = [], [], []
    for r in data["score_obs"]:
        where = f"score_obs[{r['obs_id']}]"
        if not r["obs_id"] or r["obs_id"] in obs_ids:
            errors.append(f"{where}: empty or duplicate obs_id")
        obs_ids.add(r["obs_id"])
        if r["model_id"] not in model_ids:
            errors.append(f"{where}: unknown model_id {r['model_id']!r}")
        if r["benchmark_id"] not in bench_ids:
            errors.append(f"{where}: unknown benchmark_id {r['benchmark_id']!r}")
        if r["status"] not in STATUS:
            errors.append(f"{where}: status {r['status']!r}")
        value = number(r, "value", where, errors)
        if r["status"] == "observed" and value is None:
            errors.append(f"{where}: observed but no value")
        if r["status"] == "not_observed" and value is not None:
            errors.append(f"{where}: not_observed must have a blank value")
        check_common(r, where, history_start, errors)
        scores.append({**r, "value": value})
    for r in data["price_obs"]:
        where = f"price_obs[{r['obs_id']}]"
        if not r["obs_id"] or r["obs_id"] in obs_ids:
            errors.append(f"{where}: empty or duplicate obs_id")
        obs_ids.add(r["obs_id"])
        if r["model_id"] not in model_ids:
            errors.append(f"{where}: unknown model_id {r['model_id']!r}")
        vals = {f: number(r, f, where, errors) for f in ("input_per_1m", "output_per_1m", "blended_3to1_per_1m")}
        if all(v is None for v in vals.values()):
            errors.append(f"{where}: no price at all (leave the row out instead)")
        if any(v is not None and v < 0 for v in vals.values()):
            errors.append(f"{where}: negative price")
        check_common(r, where, history_start, errors)
        prices.append({**r, **vals})
    for r in data["speed_obs"]:
        where = f"speed_obs[{r['obs_id']}]"
        if not r["obs_id"] or r["obs_id"] in obs_ids:
            errors.append(f"{where}: empty or duplicate obs_id")
        obs_ids.add(r["obs_id"])
        if r["model_id"] not in model_ids:
            errors.append(f"{where}: unknown model_id {r['model_id']!r}")
        tps = number(r, "tok_per_s", where, errors)
        if tps is None or tps <= 0:
            errors.append(f"{where}: tok_per_s must be a positive number")
        check_common(r, where, history_start, errors)
        speeds.append({**r, "tok_per_s": tps})

    if errors:
        return None, errors

    models = [{**m, "open_weights": {"true": True, "false": False, "": None}[m["open_weights"]],
               "release_date": m["release_date"] or None} for m in data["models"]]
    benchmarks = [{**b, "higher_is_better": b["higher_is_better"] == "true", "version": b["version"] or None}
                  for b in data["benchmarks"]]
    key = lambda r: (r["observed_at"], r["obs_id"])  # noqa: E731
    snapshot = {
        "schema": 1,
        "history_start": history_start,
        "note": meta["note"],
        "models": sorted(models, key=lambda m: m["model_id"]),
        "benchmarks": benchmarks,  # file order is display order (headline benchmark first)
        "scores": sorted(scores, key=key),
        "prices": sorted(prices, key=key),
        "speeds": sorted(speeds, key=key),
    }
    return snapshot, []


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="validate only; write nothing")
    args = ap.parse_args(argv)

    snapshot, errors = build(args.seed)
    if errors:
        print(f"{len(errors)} problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    counts = {k: len(snapshot[k]) for k in ("models", "benchmarks", "scores", "prices", "speeds")}
    if args.check:
        print("ok", counts)
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", args.out, counts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
