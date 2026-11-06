"""Deterministic in-text score extraction. Anything it cannot settle is marked 'needs_agent' for the toolless
extraction agent (not wired in the dry run); nothing here guesses.

A candidate is {benchmark_id, value, model_id, status, snippet}. status 'resolved' means a known model is named
within MODEL_WINDOW characters before the number; otherwise the text must name exactly one known model, or the
candidate is 'needs_agent'. Candidates are review rows, never written straight into the observation tables.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

MODEL_WINDOW = 300
SNIPPET = 160
NUM = r"(\d{1,3}(?:\.\d+)?)"
# Only connectors may sit between a benchmark name and its number ("score of", ":", "(", "reaches"). Anything else,
# such as "and 83.2% on GPQA", means the number belongs to something else.
GAP = r"(?:\s*(?:[:=(–—-]|scor\w*|of|at|is|was|reach\w*)\s*){1,3}"


def load_aliases(path: Path) -> dict[str, list[str]]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _model_mentions(text: str, models: list[dict]) -> list[tuple[int, str]]:
    out = []
    for m in models:
        for m_ in re.finditer(re.escape(m["display_name"]), text, re.I):
            out.append((m_.start(), m["model_id"]))
    return sorted(out)


def extract_in_text(text: str, aliases: dict[str, list[str]], models: list[dict]) -> list[dict]:
    mentions = _model_mentions(text, models)
    distinct = {mid for _, mid in mentions}
    found, seen = [], set()
    for bench_id, names in aliases.items():
        for alias in sorted(names, key=len, reverse=True):          # longest alias first: 'SWE-bench Verified' before 'SWE-bench'
            a = re.escape(alias)
            for rx in (rf"{a}{GAP}{NUM}\s?%?", rf"{NUM}\s?%\s+(?:on|in|at)\s+{a}"):
                for hit in re.finditer(rx, text, re.I):
                    value = float(hit.group(1))
                    if any(b == bench_id and abs(p - hit.start()) < 20 and v == value for b, p, v in seen):
                        continue                              # the same number already found via a shorter alias
                    seen.add((bench_id, hit.start(), value))
                    before = [mid for pos, mid in mentions if hit.start() - MODEL_WINDOW <= pos <= hit.start()]
                    model_id = before[-1] if before else (next(iter(distinct)) if len(distinct) == 1 else None)
                    lo, hi = max(0, hit.start() - 40), min(len(text), hit.end() + 40)
                    found.append({
                        "benchmark_id": bench_id, "value": value, "model_id": model_id,
                        "status": "resolved" if model_id else "needs_agent",
                        "snippet": re.sub(r"\s+", " ", text[lo:hi])[:SNIPPET],
                    })
    return sorted(found, key=lambda c: (c["benchmark_id"], c["value"]))
