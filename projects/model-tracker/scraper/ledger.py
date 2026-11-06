"""Local, append-only run records under data/ (git-ignored, private; the Lambda will use a private bucket).

  data/raw/YYYY/MM/DD/<run_id>.jsonl   every Exa request and response, one JSON object per line
  data/hits.csv                        one row per new URL (dedupe key: url_hash)
  data/candidates.csv                  score candidates awaiting review; never written to the seed tables
  data/runs.csv                        one row per run
Raw responses contain article text: they stay private and are never published.
"""
from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

HIT_COLUMNS = ["hit_id", "run_id", "param_id", "url_hash", "url", "domain", "published_at", "verdict", "reasons",
               "injection_flag", "injection_reasons", "fetch_status", "first_seen_at"]
CANDIDATE_COLUMNS = ["run_id", "hit_id", "benchmark_id", "value", "model_id", "status", "snippet", "url"]
RUN_COLUMNS = ["run_id", "slot", "started_at", "mode", "exa_calls", "cost_usd", "window_start", "window_end",
               "new_hits", "duplicates", "quarantined", "unsure", "candidates", "errors"]


def append_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, lineterminator="\n", extrasaction="raise")
        if new:
            w.writeheader()
        w.writerows(rows)


def seen_hashes(data_dir: Path) -> set[str]:
    path = Path(data_dir) / "hits.csv"
    if not path.exists():
        return set()
    with path.open(newline="", encoding="utf-8") as fh:
        return {row["url_hash"] for row in csv.DictReader(fh)}


def write_raw(data_dir: Path, run_id: str, now: datetime, records: list[dict]) -> Path:
    path = Path(data_dir) / "raw" / now.strftime("%Y/%m/%d") / f"{run_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as fh:        # 'x': a run id is never written twice
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return path
