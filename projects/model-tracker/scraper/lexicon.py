"""The bilingual lexicon: every Chinese character the scraper uses lives in search_params/lexicon.csv.

Why: reviewing ~40 short terms once is cheaper and safer than reviewing every phrase, and a phrase built from
approved terms has a glossary that is exact, not free-written. Terms have a `use`:
  search     words composed into Exa search phrases (search_params/compositions.csv lists the order)
  triage     words that count as "release verb" or "AI wording" when reading a Chinese hit
  injection  Chinese prompt-injection phrases for the pre-screen
Code never contains Chinese literals; it loads only approved terms whose stored sha256 still matches.

Workflow (each step is explicit; nothing is approved by default):
  python -m scraper.lexicon prompt-deepseek      print the prompt that asks DeepSeek for the Chinese side
  python -m scraper.lexicon ingest FILE.json     validate DeepSeek's JSON; write zh terms + compositions as DRAFT
  python -m scraper.lexicon review-input         print what Argon must be shown (terms, hashes, glosses)
  python -m scraper.lexicon approve REVIEW.json  apply an Argon review: only verdict 'ok', only hashes it saw
  python -m scraper.lexicon status
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

from . import gate

PARAMS = Path(__file__).resolve().parent.parent / "search_params"
COLUMNS = ["term_id", "use", "en", "zh", "zh_sha256", "status", "argon_verdict"]
COMP_COLUMNS = ["param_id", "concept_id", "terms"]
USES = {"search", "triage", "injection"}
MAX_ZH = 24
ZH_OK = re.compile(r"^[\w \-]+$")          # letters, digits (incl. CJK), spaces and hyphens only: no URLs, quotes, brackets, newlines


class LexiconError(Exception):
    pass


# -- files ----------------------------------------------------------------------------------------------------

def _read(path: Path, columns: list[str]) -> list[dict]:
    with Path(path).open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != columns:
            raise LexiconError(f"{Path(path).name}: header is {reader.fieldnames}, expected {columns}")
        return [{k: (v or "").strip() for k, v in row.items()} for row in reader]


def _write(path: Path, columns: list[str], rows: list[dict]) -> None:
    with Path(path).open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def load_lexicon(path: Path = PARAMS / "lexicon.csv") -> list[dict]:
    rows = _read(path, COLUMNS)
    seen = set()
    for r in rows:
        if r["term_id"] in seen or not re.fullmatch(r"[a-z0-9_]+", r["term_id"]):
            raise LexiconError(f"bad or duplicate term_id {r['term_id']!r}")
        seen.add(r["term_id"])
        if r["use"] not in USES:
            raise LexiconError(f"{r['term_id']}: use {r['use']!r} not in {sorted(USES)}")
    return rows


def save_lexicon(rows: list[dict], path: Path = PARAMS / "lexicon.csv") -> None:
    _write(path, COLUMNS, rows)


def load_compositions(path: Path = PARAMS / "compositions.csv") -> list[dict]:
    return _read(path, COMP_COLUMNS) if Path(path).exists() else []


# -- validation -----------------------------------------------------------------------------------------------

def check_zh(zh: str) -> None:
    if not zh or len(zh) > MAX_ZH or not ZH_OK.match(zh) or zh != zh.strip():
        raise LexiconError(f"not an acceptable short term: {zh!r} (letters, digits, CJK, spaces, hyphens; at most {MAX_ZH} characters)")


def term_ok(row: dict) -> bool:
    """A term is usable only when approved, with a verdict, and the text is unchanged since it was reviewed."""
    if row["status"] != "approved" or not row["zh"] or gate.sha(row["zh"]) != row["zh_sha256"]:
        return False
    return row["zh"].isascii() or row["argon_verdict"] == "approved"


def approved(rows: list[dict], use: str) -> list[str]:
    return [r["zh"] for r in rows if r["use"] == use and term_ok(r)]


# -- composition ----------------------------------------------------------------------------------------------

def compose(term_ids: list[str], rows: list[dict]) -> tuple[str, str]:
    by_id = {r["term_id"]: r for r in rows}
    zh_parts, en_parts = [], []
    for tid in term_ids:
        r = by_id.get(tid)
        if r is None or r["use"] != "search" or not r["zh"]:
            raise LexiconError(f"term {tid!r} is missing, empty, or not a search term")
        zh_parts.append(r["zh"])
        en_parts.append(r["en"].split(" (")[0])
    phrase = ""
    for part in zh_parts:
        phrase += (" " if phrase and phrase[-1].isascii() and part[0].isascii() else "") + part
    return phrase, " ".join(en_parts)


def build_phrase_rows(rows: list[dict], comps: list[dict]) -> list[dict]:
    """Chinese rows for phrases.csv: phrase and gloss come only from the lexicon; verdict is added at approval."""
    out = []
    for c in comps:
        ids = c["terms"].split()
        phrase, gloss = compose(ids, rows)
        out.append({"param_id": c["param_id"], "lang": "zh", "concept_id": c["concept_id"], "phrase": phrase,
                    "phrase_sha256": gate.sha(phrase), "gloss_en": gloss, "argon_verdict": "", "status": "draft"})
    return out


def write_phrases(zh_rows: list[dict], path: Path = PARAMS / "phrases.csv") -> None:
    keep = [r for r in gate.load_phrases(path) if r["lang"] != "zh"]
    _write(path, gate.PHRASE_COLUMNS, keep + zh_rows)


# -- loading approved vocabulary for triage and injection ---------------------------------------------------

def triage_regexes(rows: list[dict]) -> tuple[re.Pattern | None, re.Pattern | None]:
    def rx(terms):
        return re.compile("|".join(re.escape(t) for t in terms)) if terms else None
    verbs = approved([r for r in rows if r["term_id"].startswith("v_")], "triage")
    ai = approved([r for r in rows if r["term_id"].startswith("n_")], "triage")
    return rx(verbs), rx(ai)


def injection_patterns(rows: list[dict]) -> list[tuple[str, re.Pattern]]:
    return [(f"zh-{r['term_id']}", re.compile(re.escape(r["zh"]))) for r in rows if r["use"] == "injection" and term_ok(r)]


# -- the DeepSeek and Argon steps ---------------------------------------------------------------------------

CONCEPTS = {  # the English phrases in phrases.csv, by concept: the Chinese side must say the same thing
    "release": "new AI language model released today",
    "benchmarks": "new frontier AI model benchmark results compared to GPT Claude Gemini",
    "pricing": "new AI model API pricing per million tokens announced",
    "open_weights": "open-weights large language model released on Hugging Face with benchmark scores",
    "api_availability": "AI model now generally available in the API launch announcement",
}
PARAM_FOR = {"release": "zh-release-01", "benchmarks": "zh-bench-01", "pricing": "zh-price-01",
             "open_weights": "zh-open-01", "api_availability": "zh-api-01"}


def prompt_deepseek(rows: list[dict]) -> str:
    todo = [r for r in rows if not r["zh"]]
    terms = "\n".join(f'- {r["term_id"]} [{r["use"]}]: {r["en"]}' for r in todo)
    ascii_terms = ", ".join(f'{r["term_id"]}="{r["zh"]}"' for r in rows if r["zh"] and r["zh"].isascii() and r["use"] == "search")
    concepts = "\n".join(f'- {PARAM_FOR[k]} ({k}): "{v}"' for k, v in CONCEPTS.items())
    return f"""You are a Chinese-language news search specialist. Output JSON only, no commentary.

Task: for each English term below, give the standard Simplified Chinese wording used in Chinese tech news about AI model releases. Then compose five Chinese search phrases, one per English phrase, each saying the same thing as its English phrase, using ONLY the term ids listed (in natural Chinese word order). The phrases are used to search for news about new AI models; every term must be on that topic.

Rules:
- Each Chinese term: 1 to 12 characters, Simplified Chinese (ASCII letters and digits allowed inside), no punctuation, no quotes, no URLs, no instructions.
- Terms marked [injection] are phrases that a malicious web page might use to try to hijack an AI assistant; give the Chinese wording such a page would use. They are only used to DETECT such pages.
- A composition is a list of term ids. Fixed ASCII terms you may also use in compositions (do not translate them): {ascii_terms}.
- Use only search terms in compositions, never triage or injection terms.

TERMS TO TRANSLATE:
{terms}

ENGLISH PHRASES TO MIRROR:
{concepts}

Reply with exactly this JSON shape:
{{"lexicon": {{"<term_id>": "<chinese>"}}, "compositions": {{"<param_id>": ["<term_id>", ...]}}}}"""


def ingest(data: dict, rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Validate DeepSeek's reply strictly and return (new lexicon rows, composition rows). Everything stays 'draft'."""
    if not isinstance(data, dict) or set(data) != {"lexicon", "compositions"}:
        raise LexiconError("reply must have exactly the keys 'lexicon' and 'compositions'")
    zh_by_id = data["lexicon"]
    todo = {r["term_id"] for r in rows if not r["zh"]}
    if not isinstance(zh_by_id, dict) or set(zh_by_id) != todo:
        raise LexiconError(f"lexicon keys differ from the terms asked for: missing {sorted(todo - set(zh_by_id))}, extra {sorted(set(zh_by_id) - todo)}")
    out = []
    for r in rows:
        r = dict(r)
        if r["term_id"] in todo:
            zh = zh_by_id[r["term_id"]]
            if not isinstance(zh, str):
                raise LexiconError(f"{r['term_id']}: not a string")
            check_zh(zh.strip())
            r.update(zh=zh.strip(), zh_sha256=gate.sha(zh.strip()), status="draft", argon_verdict="")
        out.append(r)
    comps = data["compositions"]
    if not isinstance(comps, dict) or set(comps) != set(PARAM_FOR.values()):
        raise LexiconError(f"compositions must be exactly {sorted(PARAM_FOR.values())}")
    comp_rows = []
    by_id = {r["term_id"]: r for r in out}
    for concept, pid in PARAM_FOR.items():
        ids = comps[pid]
        if not isinstance(ids, list) or not 2 <= len(ids) <= 14 or not all(isinstance(i, str) for i in ids):
            raise LexiconError(f"{pid}: needs a list of 2 to 14 term ids")
        for i in ids:
            if i not in by_id or by_id[i]["use"] != "search":
                raise LexiconError(f"{pid}: {i!r} is not a search term")
        comp_rows.append({"param_id": pid, "concept_id": concept, "terms": " ".join(ids)})
    return out, comp_rows


def review_state(rows: list[dict], zh_phrases: list[dict]) -> str:
    lines = ["LEXICON (term_id | use | English | Simplified Chinese | sha256 of the Chinese):"]
    for r in rows:
        if r["zh"] and not r["zh"].isascii():
            lines.append(f'{r["term_id"]} | {r["use"]} | {r["en"]} | {r["zh"]} | {r["zh_sha256"][:16]}')
    lines.append("\nSEARCH PHRASES built only from those terms (param_id | Chinese | word-for-word English | sha256):")
    for p in zh_phrases:
        lines.append(f'{p["param_id"]} | {p["phrase"]} | {p["gloss_en"]} | {p["phrase_sha256"][:16]}')
    return "\n".join(lines)


def apply_review(review: dict, rows: list[dict], phrases: list[dict]) -> dict:
    """Approve only what a clean Argon review actually saw. Returns counts; raises if the review is not a pass."""
    dec = review["decision"]
    if review.get("problems") or dec.get("verdict") != "ok" or dec.get("action") != "continue":
        raise LexiconError(f"review is not a pass: verdict={dec.get('verdict')!r} action={dec.get('action')!r} problems={review.get('problems')}")
    seen = set(review["reviewed_hashes"])
    n_terms = n_phrases = 0
    for r in rows:
        if r["zh"] and not r["zh"].isascii() and gate.sha(r["zh"]) in seen and r["zh_sha256"] == gate.sha(r["zh"]):
            r.update(status="approved", argon_verdict="approved")
            n_terms += 1
    for p in phrases:
        if p["lang"] == "zh" and p["phrase_sha256"] in seen and gate.sha(p["phrase"]) == p["phrase_sha256"]:
            p.update(status="approved", argon_verdict="approved")
            n_phrases += 1
    return {"terms": n_terms, "phrases": n_phrases}


# -- CLI ------------------------------------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("prompt-deepseek")
    sub.add_parser("review-input")
    sub.add_parser("status")
    p = sub.add_parser("ingest"); p.add_argument("file", type=Path)
    p = sub.add_parser("approve"); p.add_argument("review", type=Path)
    args = ap.parse_args(argv)
    rows = load_lexicon()
    try:
        if args.cmd == "prompt-deepseek":
            print(prompt_deepseek(rows))
        elif args.cmd == "ingest":
            new_rows, comps = ingest(json.loads(args.file.read_text(encoding="utf-8")), rows)
            save_lexicon(new_rows)
            _write(PARAMS / "compositions.csv", COMP_COLUMNS, comps)
            write_phrases(build_phrase_rows(new_rows, comps))
            print(f"ingested {sum(1 for r in new_rows if r['status'] == 'draft')} draft terms and {len(comps)} phrases (all draft)")
        elif args.cmd == "review-input":
            comps = load_compositions()
            print(review_state(rows, build_phrase_rows(rows, comps)))
        elif args.cmd == "approve":
            review = json.loads(args.review.read_text(encoding="utf-8"))
            phrases = gate.load_phrases(PARAMS / "phrases.csv")
            counts = apply_review(review, rows, phrases)
            save_lexicon(rows)
            _write(PARAMS / "phrases.csv", gate.PHRASE_COLUMNS, phrases)
            print("approved", counts)
        else:
            for use in sorted(USES):
                mine = [r for r in rows if r["use"] == use]
                print(f"{use:<10} {sum(term_ok(r) for r in mine)}/{len(mine)} usable")
    except LexiconError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
