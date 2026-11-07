"""Human review of score candidates (PLAN.md step 4: candidate -> observation).

The scraper only ever writes rows to data/candidates.csv. Nothing there reaches the page until a person accepts it:

    python -m scraper.review list
    python -m scraper.review accept 3f9a1c2e --provenance third_party --effort High
    python -m scraper.review reject 3f9a1c2e --note "rumour page"

`accept` appends one row to seed/score_obs.csv (origin = scraped), validates the whole seed with build_snapshot, and
only then keeps the row and regenerates public/projects/models/data/latest.json. A row that fails validation is
removed again. Every decision is logged to data/decisions.csv, so a candidate is never offered twice. Nothing here
deploys anything or touches the network.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from . import ledger

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DECISION_COLUMNS = ["cand_id", "decision", "decided_at", "obs_id", "note"]


class ReviewError(Exception):
    pass


def cand_id(c: dict) -> str:
    """Stable short id for a candidate row (same hit, benchmark and value always give the same id)."""
    return hashlib.sha256(f"{c['hit_id']}|{c['benchmark_id']}|{c['value']}".encode()).hexdigest()[:8]


def _read(path: Path) -> list[dict]:
    if not Path(path).exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def decisions(data_dir: Path) -> dict[str, dict]:
    return {d["cand_id"]: d for d in _read(Path(data_dir) / "decisions.csv")}


def pending(data_dir: Path) -> list[dict]:
    done = decisions(data_dir)
    out = []
    for c in _read(Path(data_dir) / "candidates.csv"):
        c["cand_id"] = cand_id(c)
        if c["cand_id"] not in done:
            out.append(c)
    return out


def _find(data_dir: Path, wanted: str) -> dict:
    cands = [c for c in pending(data_dir) if c["cand_id"].startswith(wanted)]
    if not cands:
        raise ReviewError(f"no pending candidate matches {wanted!r} (already decided, or not in candidates.csv)")
    if len(cands) > 1:
        raise ReviewError(f"{wanted!r} matches {len(cands)} candidates; give more characters")
    return cands[0]


def _clean_url(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}{p.path}"                    # tracking parameters stay out of the public source link


def _next_obs_id(rows: list[dict]) -> str:
    nums = [int(m.group(1)) for r in rows if (m := re.fullmatch(r"s(\d+)", r["obs_id"]))]
    return f"s{(max(nums) + 1 if nums else 1):03d}"


def accept(cid: str, data_dir: Path, seed: Path, now: datetime, *, provenance: str, effort: str = "", model: str | None = None,
           reported_date: str | None = None, source_name: str | None = None, out: Path | None = None) -> str:
    import build_snapshot as bs                                   # lives one level up; run from projects/model-tracker

    cand = _find(data_dir, cid)
    model_id = model or cand["model_id"]
    if not model_id:
        raise ReviewError("this candidate has no model; pass --model <model_id> (it must already exist in seed/models.csv)")
    hit = next((h for h in _read(Path(data_dir) / "hits.csv") if h["hit_id"] == cand["hit_id"]), {})
    path = Path(seed) / "score_obs.csv"
    before = path.read_text(encoding="utf-8")
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    value = float(cand["value"])
    for r in rows:
        if r["model_id"] == model_id and r["benchmark_id"] == cand["benchmark_id"] and r["value"] and float(r["value"]) == value \
                and r["source_url"] == _clean_url(cand["url"]):
            raise ReviewError(f"already recorded as {r['obs_id']}")
    date = reported_date or (hit.get("published_at") or "")[:10] or now.strftime("%Y-%m-%d")
    obs_id = _next_obs_id(rows)
    row = {
        "obs_id": obs_id, "model_id": model_id, "benchmark_id": cand["benchmark_id"], "value": cand["value"], "status": "observed",
        "reported_date": date, "observed_at": now.strftime("%Y-%m-%d"), "effort": effort, "shots": "", "tools": "",
        "provenance": provenance, "source_name": source_name or (urlsplit(cand["url"]).hostname or ""),
        "source_url": _clean_url(cand["url"]), "origin": "scraped",
    }
    with open(path, "a", newline="", encoding="utf-8") as f:
        if not before.endswith("\n"):
            f.write("\n")
        csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else list(row), lineterminator="\n").writerow(row)
    snapshot, errors = bs.build(Path(seed))
    if errors:
        path.write_text(before, encoding="utf-8")                  # a row that does not validate never stays
        raise ReviewError("seed would be invalid, row removed: " + "; ".join(errors[:3]))
    if out is not None:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(_dump(snapshot), encoding="utf-8")        # same format build_snapshot.main writes
    ledger.append_csv(Path(data_dir) / "decisions.csv", DECISION_COLUMNS, [{
        "cand_id": cand["cand_id"], "decision": "accepted", "decided_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "obs_id": obs_id, "note": ""}])
    return obs_id


def _dump(snapshot: dict) -> str:
    import json
    return json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n"


def reject(cid: str, data_dir: Path, now: datetime, note: str = "") -> None:
    cand = _find(data_dir, cid)
    ledger.append_csv(Path(data_dir) / "decisions.csv", DECISION_COLUMNS, [{
        "cand_id": cand["cand_id"], "decision": "rejected", "decided_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "obs_id": "", "note": note}])


def main(argv=None) -> int:
    import build_snapshot as bs

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data")
    ap.add_argument("--seed", type=Path, default=bs.DEFAULT_SEED)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    a = sub.add_parser("accept")
    a.add_argument("cand_id")
    a.add_argument("--provenance", required=True, choices=sorted(bs.PROVENANCE))
    a.add_argument("--effort", default="")
    a.add_argument("--model")
    a.add_argument("--date", help="reported date YYYY-MM-DD (default: the hit's published date)")
    a.add_argument("--source-name")
    r = sub.add_parser("reject")
    r.add_argument("cand_id")
    r.add_argument("--note", default="")
    args = ap.parse_args(argv)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    try:
        if args.cmd == "list":
            rows = pending(args.data_dir)
            for c in rows:
                print(f"{c['cand_id']}  {c['benchmark_id']:<22} {c['value']:>6}  {c['model_id'] or '(no model)':<34} [{c['status']}]  {c['url']}")
                print(f"          ...{c['snippet']}...")
            print(f"{len(rows)} pending")
        elif args.cmd == "accept":
            obs = accept(args.cand_id, args.data_dir, args.seed, now, provenance=args.provenance, effort=args.effort,
                         model=args.model, reported_date=args.date, source_name=args.source_name, out=bs.DEFAULT_OUT)
            print(f"accepted as {obs}; seed validated; {bs.DEFAULT_OUT} regenerated (not deployed)")
        else:
            reject(args.cand_id, args.data_dir, now, args.note)
            print("rejected")
    except ReviewError as e:
        print(f"review: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
