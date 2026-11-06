"""The Argon gate (non-negotiable): no unreviewed foreign-script text reaches a search API.

A phrase that is not plain ASCII may only be sent if its sha256 is in search_params/phrases.csv with an
English gloss, an Argon verdict of 'approved' and status 'approved', and the stored hash still matches the
phrase (so an edit after approval invalidates it). `check_request` applies the same rule to EVERY string in
a request body, not only the query, so a non-ASCII domain or filter can't slip through either.

An override request does not get around the gate. It prints the banana line and still refuses.
"""
from __future__ import annotations

import csv
import hashlib
from pathlib import Path

BANANA = ("BANANA CONDITION: USER SHOULD NOT BE SO LAZY AS TO USE FOREIGN SCRIPT IN AI PROMPTS "
          "THAT DIRECTLY IMPACT THE SAFETY OF HIS MACHINE")

PHRASE_COLUMNS = ["param_id", "lang", "concept_id", "phrase", "phrase_sha256", "gloss_en", "argon_verdict", "status"]


class GateRefused(Exception):
    pass


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_phrases(path: Path) -> list[dict]:
    with Path(path).open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames != PHRASE_COLUMNS:
            raise GateRefused(f"phrases.csv header is {reader.fieldnames}, expected {PHRASE_COLUMNS}")
        return [{k: (v or "").strip() for k, v in row.items()} for row in reader]


def _problems(row: dict) -> list[str]:
    out = []
    if sha(row["phrase"]) != row["phrase_sha256"]:
        out.append("stored hash does not match the phrase (edited after approval?)")
    if row["status"] != "approved":
        out.append(f"status is {row['status']!r}, not 'approved'")
    if not row["phrase"].isascii():
        if not row["gloss_en"]:
            out.append("non-ASCII phrase has no English gloss")
        if row["argon_verdict"] != "approved":
            out.append(f"non-ASCII phrase has Argon verdict {row['argon_verdict']!r}, not 'approved'")
    return out


def check_phrase(row: dict, override_requested: bool = False) -> None:
    problems = _problems(row)
    if problems:
        msg = f"{row['param_id']}: refused: " + "; ".join(problems)
        if override_requested:
            msg = f"{BANANA}\n{msg}\n(override requested: refused anyway)"
        raise GateRefused(msg)


def approved_non_ascii_hashes(rows: list[dict]) -> set[str]:
    return {r["phrase_sha256"] for r in rows if not _problems(r)}


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _strings(k)
            yield from _strings(v)
    elif isinstance(node, (list, tuple)):
        for v in node:
            yield from _strings(v)


def check_request(body: dict, rows: list[dict], override_requested: bool = False) -> None:
    ok = approved_non_ascii_hashes(rows)
    for s in _strings(body):
        if not s.isascii() and sha(s) not in ok:
            msg = f"request contains non-ASCII text with no approved ledger entry (sha256 {sha(s)[:12]}…)"
            if override_requested:
                msg = f"{BANANA}\n{msg}\n(override requested: refused anyway)"
            raise GateRefused(msg)
