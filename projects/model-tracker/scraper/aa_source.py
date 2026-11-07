"""Artificial Analysis as the reference source (source of truth, not a detector).

https://artificialanalysis.ai/leaderboards/models is server-rendered and embeds, in its Next.js flight payload, one
compact record per model variant: creator, open-weights flag, context window, the Intelligence Index, ~18 evaluation
scores, cost and time per Index task, prices, output speed and time to first token. One plain HTTP GET (no Exa call,
no browser) gives all of it, so every run rescans it and appends observations, even when values are unchanged.

    python -m scraper.aa_source refresh            fetch the page, write seed/aa/*.csv (append-only), print a summary
    python -m scraper.aa_source refresh --html F   same, from a saved page (offline)

Selection: for each (creator, release) the variant with the highest Intelligence Index is kept (that is how the hand
seed chose Max / Xhigh / High), then releases with index >= caps["aa"]["min_index"] are tracked, plus every model
already in the hand seed. Numbers are copied as published; nothing is estimated.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://artificialanalysis.ai/leaderboards/models"
SOURCE_NAME = "Artificial Analysis (leaderboard data)"
UA = "Mozilla/5.0 (compatible; patelpb-model-tracker; +https://patelpb.com/projects/models/)"
MAX_BYTES = 8_000_000
ROOT = Path(__file__).resolve().parent.parent

EFFORT = re.compile(r"\s*\((minimal|low|medium|high|xhigh|max|non-reasoning|reasoning|default|adaptive)[^)]*\)\s*$", re.I)
# AA creator name -> (id prefix, org name used on the page). Keeps ids stable with the hand seed.
CREATORS = {"Kimi": ("moonshot", "Moonshot AI"), "Moonshot AI": ("moonshot", "Moonshot AI"), "Z AI": ("zai", "Z AI"),
            "Google": ("google", "Google"), "Anthropic": ("anthropic", "Anthropic"), "OpenAI": ("openai", "OpenAI"),
            "Meta": ("meta", "Meta"), "Alibaba": ("alibaba", "Alibaba"), "DeepSeek": ("deepseek", "DeepSeek"),
            "Mistral": ("mistral", "Mistral"), "SpaceXAI": ("spacexai", "SpaceXAI")}

# AA score key -> (benchmark_id, multiplier). Fractions become percentages; Elo and net scores stay as published.
SCORES = {
    "terminalbench-4-0": ("aa_terminalbench_4", 100), "frontiercode-2-0": ("aa_frontiercode_2", 100),
    "hle-diamond": ("aa_hle_diamond", 100), "critpt-v2-hard": ("aa_critpt_v2_hard", 100),
    "gdp-pdf": ("aa_gdp_pdf", 100), "automationbench-aa": ("aa_automationbench", 100),
    "aa-briefcase": ("aa_briefcase_elo", 1), "omniscience-non-hallucination": ("aa_non_hallucination", 100),
    "terminal-bench-science": ("aa_terminalbench_science", 100), "mmmu-pro": ("aa_mmmu_pro", 100),
    "humanitys-last-exam": ("aa_hle", 100), "scicode": ("aa_scicode", 100),
    "artificial-analysis-long-context-reasoning": ("aa_lcr", 100),
}


class SourceError(Exception):
    pass


def fetch_html(url: str = URL, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise SourceError(f"HTTP {r.status}")
        body = r.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise SourceError("page larger than expected; refusing to parse")
    return body.decode("utf-8", errors="replace")


def flight_payload(html: str) -> str:
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', html)
    if not chunks:
        raise SourceError("no Next.js flight data in the page (layout changed?)")
    return "".join(json.loads('"' + c + '"') for c in chunks)


def _balanced(text: str, start: int) -> str | None:
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def records(html: str) -> list[dict]:
    """Every leaderboard row record: a JSON object starting with "slug" that has scores and an Intelligence Index."""
    p = flight_payload(html)
    out, seen = [], set()
    for m in re.finditer(r'\{"slug":"', p):
        raw = _balanced(p, m.start())
        if not raw:
            continue
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        if isinstance(o.get("scores"), dict) and "intelligenceIndex" in o and o["slug"] not in seen:
            seen.add(o["slug"])
            out.append(o)
    if len(out) < 20:
        raise SourceError(f"only {len(out)} model records found (layout changed?)")
    return out


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def base_name(name: str) -> tuple[str, str]:
    """'Grok 4.7 (Xhigh)' -> ('Grok 4.7', 'Xhigh'); 'Qwen3.8 Max (0902)' keeps its version suffix."""
    m = EFFORT.search(name)
    if not m:
        return name.strip(), ""
    return name[:m.start()].strip(), m.group(0).strip()[1:-1].split(",")[0].strip()   # "Max, Default Fallback" -> "Max"


def creator(rec: dict) -> tuple[str, str]:
    name = rec.get("modelCreatorName") or "Unknown"
    return CREATORS.get(name, (slugify(name), name))


def select(recs: list[dict], min_index: float, always: set[str]) -> list[dict]:
    """Best variant per (creator, release); keep releases at or above min_index, or already tracked."""
    best = {}
    for r in recs:
        if r.get("deprecated") or not isinstance(r.get("intelligenceIndex"), (int, float)):
            continue
        prefix, org = creator(r)
        base, effort = base_name(r["name"])
        mid = f"{prefix}/{slugify(base)}"
        cur = best.get(mid)
        if cur is None or r["intelligenceIndex"] > cur["rec"]["intelligenceIndex"]:
            best[mid] = {"model_id": mid, "org": org, "display_name": base, "effort": effort, "rec": r}
    return sorted((b for b in best.values() if b["rec"]["intelligenceIndex"] >= min_index or b["model_id"] in always),
                  key=lambda b: -b["rec"]["intelligenceIndex"])


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def observations(chosen: list[dict], day: str) -> dict[str, list[dict]]:
    """Rows for seed/aa/*.csv. obs ids are deterministic per (day, model, metric), so a same-day rerun is a no-op."""
    common = {"reported_date": day, "observed_at": day, "provenance": "third_party", "source_name": SOURCE_NAME,
              "source_url": URL, "origin": "scraped"}
    models, scores, prices, speeds = [], [], [], []
    for b in chosen:
        r, mid = b["rec"], b["model_id"]
        models.append({"model_id": mid, "org": b["org"], "family": b["org"], "version_label": b["display_name"],
                       "display_name": b["display_name"], "class": "open_weights" if r.get("isOpenWeights") else "proprietary",
                       "open_weights": "true" if r.get("isOpenWeights") else "false", "release_date": "", "origin": "scraped"})

        def score(bid, value, digits=2):
            if value is None:
                return
            scores.append({"obs_id": f"aa-{day}-{mid}-{bid}", "model_id": mid, "benchmark_id": bid,
                           "value": f"{round(value, digits)}", "status": "observed", "effort": b["effort"],
                           "shots": "", "tools": "", **common})
        score("aa_intelligence_index", _num(r.get("intelligenceIndex")), 1)
        score("aa_cost_per_task", _num(r.get("intelligenceIndexCostPerTask")))
        t = _num(r.get("intelligenceIndexTimePerTask"))
        score("aa_time_per_task", t / 60 if t is not None else None, 1)
        score("aa_first_token_latency", _num(r.get("timeToFirstAnswerToken")), 1)
        ctx = _num(r.get("contextWindowTokens"))
        score("aa_context_window", ctx / 1000 if ctx else None, 0)
        score("aa_omniscience", _num(r.get("omniscience")), 1)
        for key, (bid, mult) in SCORES.items():
            v = _num((r.get("scores") or {}).get(key))
            score(bid, v * mult if v is not None else None, 1)
        pin, pout = _num(r.get("price1mInputTokens")), _num(r.get("price1mOutputTokens"))
        if pin is not None or pout is not None:
            blend = (3 * pin + pout) / 4 if pin is not None and pout is not None else None
            prices.append({"obs_id": f"aa-{day}-{mid}-price", "model_id": mid, "provider": "AA reference (first party)",
                           "input_per_1m": _fmt(pin), "output_per_1m": _fmt(pout), "blended_3to1_per_1m": _fmt(blend), **common})
        sp = _num(r.get("outputSpeed"))
        if sp:
            speeds.append({"obs_id": f"aa-{day}-{mid}-speed", "model_id": mid, "provider": "AA reference (first party)",
                           "tok_per_s": f"{round(sp, 1)}", **common})
    return {"models": models, "score_obs": scores, "price_obs": prices, "speed_obs": speeds}


def _fmt(v):
    return "" if v is None else f"{round(v, 4)}"


def write(seed: Path, obs: dict[str, list[dict]], columns: dict[str, list[str]]) -> dict[str, int]:
    """Append to seed/aa/<table>.csv. Models are upserted (latest attributes win); observations with an existing obs_id
    are skipped, so history accumulates one row per model, metric and day."""
    out_dir = Path(seed) / "aa"
    out_dir.mkdir(parents=True, exist_ok=True)
    added = {}
    for table, rows in obs.items():
        path = out_dir / f"{table}.csv"
        old = list(csv.DictReader(open(path, newline="", encoding="utf-8"))) if path.exists() else []
        if table == "models":
            merged = {r["model_id"]: r for r in old}
            merged.update({r["model_id"]: r for r in rows})
            final, added[table] = sorted(merged.values(), key=lambda r: r["model_id"]), len(set(merged) - {r["model_id"] for r in old})
        else:
            have = {r["obs_id"] for r in old}
            new = [r for r in rows if r["obs_id"] not in have]
            final, added[table] = old + new, len(new)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=columns[table], lineterminator="\n")
            w.writeheader()
            w.writerows({k: r.get(k, "") for k in columns[table]} for r in final)
    return added


def main(argv=None) -> int:
    sys.path.insert(0, str(ROOT))
    import build_snapshot as bs

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("refresh")
    r.add_argument("--html", type=Path, help="parse a saved page instead of fetching")
    r.add_argument("--day", help="observation date (default: today, UTC)")
    args = ap.parse_args(argv)
    caps = json.loads((ROOT / "search_params" / "caps.json").read_text(encoding="utf-8"))
    html = args.html.read_text(encoding="utf-8", errors="replace") if args.html else fetch_html()
    recs = records(html)
    hand = {row["model_id"] for row in csv.DictReader(open(bs.DEFAULT_SEED / "models.csv", newline="", encoding="utf-8"))}
    chosen = select(recs, caps["aa"]["min_index"], hand)
    day = args.day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    added = write(bs.DEFAULT_SEED, observations(chosen, day), bs.TABLES)
    print(json.dumps({"records": len(recs), "tracked": len(chosen), "added": added,
                      "orgs": sorted({c["org"] for c in chosen})}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
