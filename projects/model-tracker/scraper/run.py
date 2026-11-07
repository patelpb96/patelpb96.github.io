"""One scheduled run, English-only (PLAN.md, Steps 2).

    python -m scraper.run --dry-run --slot 2026-11-06T02 --now 2026-11-06T02:00:00

--dry-run replays scraper/fixtures/dry_run.json: no network, no AWS, no key. A live run (--live) needs EXA_API_KEY
in the environment, spends real money under the caps in search_params/caps.json, and is not used in Phase 0.

Order of operations per run: kill switch and slot lock -> for each approved English phrase: gate, reserve spend,
search, settle spend -> keep the newest results -> dedupe against the hit ledger -> injection pre-screen ->
750-character triage -> for 'release' hits only: open the page, screen it, extract scores in text.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from . import budget as budget_mod
from . import exa_client, extract, fetch, gate, injection, ledger, lexicon, triage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PARAMS = ROOT / "search_params"


def load_params(params_dir: Path = PARAMS) -> dict:
    lex = lexicon.load_lexicon(params_dir / "lexicon.csv")
    return {
        "caps": json.loads((params_dir / "caps.json").read_text(encoding="utf-8")),
        "exa_params": json.loads((params_dir / "exa_params.json").read_text(encoding="utf-8")),
        "phrases": gate.load_phrases(params_dir / "phrases.csv"),
        "aliases": extract.load_aliases(params_dir / "benchmark_aliases.json"),
        # Only terms that are approved AND unchanged since review; the code itself holds no Chinese text.
        "zh_triage": lexicon.triage_regexes(lex),
        "zh_injection": lexicon.injection_patterns(lex),
    }


def run(slot: str, now: datetime, data_dir: Path, params: dict, models: list[dict], exa, pages,
        triage_judge=None, injection_judge=None, override_requested: bool = False) -> dict:
    caps = params["caps"]
    bud = budget_mod.Budget(data_dir, caps, now)
    bud.start_run(slot)
    run_id = f"run-{slot}"
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    seen = ledger.seen_hashes(data_dir)
    raw, hits, errors, cost, stopped = [], [], [], 0.0, None
    duplicates = 0
    first_body = None

    zh_tri, zh_inj = params.get("zh_triage"), params.get("zh_injection")
    for row in params["phrases"]:
        try:                                          # every phrase, in any language, goes through the Argon gate
            gate.check_phrase(row, override_requested)
            body = exa_client.build_request(row["phrase"], caps, params["exa_params"], now)
            gate.check_request(body, params["phrases"], override_requested)
            reserved = bud.reserve()
        except gate.GateRefused as e:
            errors.append(f"gate: {e}")
            continue
        except budget_mod.RunRefused as e:
            stopped = str(e)
            break
        first_body = first_body or body
        try:
            doc = exa.search(body)
        except exa_client.ExaError as e:
            errors.append(f"{row['param_id']}: {e}")
            continue                                  # the reservation stays: a failed call may still have been billed
        actual = exa_client.cost_of(doc)
        bud.settle(reserved, actual)
        cost += reserved if actual is None else actual
        raw.append({"run_id": run_id, "param_id": row["param_id"], "request": body, "response": doc})

        for r in exa_client.newest(doc.get("results", []), caps["keep_newest"]):
            h = exa_client.url_hash(r["url"])
            if h in seen:
                duplicates += 1
                continue
            seen.add(h)
            text = r.get("text") or ""
            inj = injection.screen(text[: caps["triage_chars"]], injection_judge, extra=zh_inj)
            tri = triage.triage(text, caps["triage_chars"], triage_judge, zh=zh_tri)
            hits.append({
                "hit_id": f"{run_id}:{h[:10]}", "run_id": run_id, "param_id": row["param_id"], "url_hash": h,
                "url": r["url"], "domain": urlsplit(r["url"]).hostname or "", "published_at": r.get("publishedDate") or "",
                "verdict": "quarantined" if inj["flagged"] else tri["verdict"], "reasons": "; ".join(tri["reasons"]),
                "injection_flag": inj["flagged"], "injection_reasons": "; ".join(inj["reasons"]),
                "fetch_status": "", "first_seen_at": stamp,
            })

    candidates, fetched = [], 0
    for hit in hits:
        if hit["verdict"] != "release":
            continue
        if fetched >= caps.get("max_fetches_per_run", 5):
            hit["fetch_status"] = "skipped: fetch cap"
            continue
        fetched += 1
        page = pages.get(hit["url"])
        if page is None:
            hit["fetch_status"] = "unavailable"
            continue
        inj = injection.screen(page, injection_judge, extra=zh_inj)
        if inj["flagged"]:
            hit.update(verdict="quarantined", injection_flag=True, injection_reasons="; ".join(inj["reasons"]), fetch_status="quarantined")
            continue
        found = extract.extract_in_text(page, params["aliases"], models)
        hit["fetch_status"] = f"ok: {len(found)} candidate(s)"
        candidates += [{"run_id": run_id, "hit_id": hit["hit_id"], "url": hit["url"], **c} for c in found]

    ledger.write_raw(data_dir, run_id, now, raw)
    ledger.append_csv(Path(data_dir) / "hits.csv", ledger.HIT_COLUMNS, hits)
    if candidates:
        ledger.append_csv(Path(data_dir) / "candidates.csv", ledger.CANDIDATE_COLUMNS, candidates)
    summary = {
        "run_id": run_id, "slot": slot, "started_at": stamp, "mode": "explore", "exa_calls": bud.calls_this_run,
        "cost_usd": round(cost, 6), "window_start": (first_body or {}).get("startPublishedDate", ""), "window_end": stamp,
        "new_hits": len(hits), "duplicates": duplicates, "quarantined": sum(h["verdict"] == "quarantined" for h in hits),
        "unsure": sum(h["verdict"] == "unsure" for h in hits), "candidates": len(candidates), "errors": len(errors),
    }
    ledger.append_csv(Path(data_dir) / "runs.csv", ledger.RUN_COLUMNS, [summary])
    return {**summary, "stopped": stopped, "error_messages": errors, "hits": hits, "candidate_rows": candidates}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slot", required=True, help="e.g. 2026-11-06T02 (UTC date + hour); also the lock key")
    ap.add_argument("--now", help="UTC time of the run, ISO format (default: the current time)")
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="replay fixtures; no network")
    mode.add_argument("--live", action="store_true", help="REAL Exa calls (needs EXA_API_KEY); spends money")
    ap.add_argument("--fixtures", type=Path, default=HERE / "fixtures" / "dry_run.json")
    args = ap.parse_args(argv)

    now = datetime.fromisoformat(args.now).replace(tzinfo=None) if args.now else datetime.now(timezone.utc).replace(tzinfo=None)
    params = load_params()
    seed_models = json.loads((ROOT.parent.parent / "public" / "projects" / "models" / "data" / "latest.json").read_text(encoding="utf-8"))["models"]
    if args.dry_run:
        fx = json.loads(args.fixtures.read_text(encoding="utf-8"))
        exa, pages, models = exa_client.FixtureExa(fx["exa"]), fetch.FixturePages(fx["pages"]), fx["models"] + seed_models
    else:
        exa, pages, models = exa_client.LiveExa(), fetch.LivePages(), seed_models
    try:
        res = run(args.slot, now, args.data_dir, params, models, exa, pages)
    except budget_mod.RunRefused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    print(json.dumps({k: v for k, v in res.items() if k not in {"hits", "candidate_rows"}}, indent=1))
    for h in res["hits"]:
        print(f"  {h['verdict']:<12} {h['published_at'][:16]:<16} {h['url']}  [{h['reasons'] or h['injection_reasons']}]")
    for c in res["candidate_rows"]:
        print(f"  candidate    {c['benchmark_id']}={c['value']} model={c['model_id']} ({c['status']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
