"""Cheap first look: does the first `chars` characters of a hit announce a model release?

Deterministic pass first (regex). A verdict of 'unsure' is kept for review and is NOT extracted; a Jev yes/no
can be passed as `judge` to settle it later (the dry run wires none). verdicts: release | not_release | unsure.
"""
from __future__ import annotations

import re
from typing import Callable

# re.A: only ASCII letters and digits are "word" characters, so \b still works where an English name is glued to
# Chinese text (Orbit-9 directly followed by a Chinese verb has no boundary under the default Unicode rules).
VERBS = re.compile(r"\b(releas(?:e[sd]?|ing)|launch(?:es|ed|ing)?|unveil(?:s|ed|ing)?|announc(?:e[sd]?|ing)|"
                   r"introduc(?:e[sd]?|ing)|debut(?:s|ed)?|rolls? out|now available|open[- ]sourc(?:e[sd]?|ing))\b", re.I | re.A)
AI_WORDS = re.compile(r"\b(AI|LLM|language models?|foundation models?|reasoning models?|open[- ]weights?|chatbot|model)\b", re.I | re.A)
# A version-like model name: "Orbit-9", "Qwen3.8", "GPT 6.1", "Llama 4"
MODEL_NAME = re.compile(r"\b[A-Z][A-Za-z]{1,}[- ]?\d+(?:\.\d+)*[A-Za-z]*\b", re.A)
BENCH = re.compile(r"\b(benchmark|SWE-?bench|GPQA|AIME|MMLU|HLE|LiveCodeBench|ARC-AGI|Terminal-?Bench|Intelligence Index)\b", re.I | re.A)
# A challenger claim: a report that a (smaller, cheaper or open) model beats or matches bigger ones. It stands in for
# the release verb only when a benchmark is also mentioned, so "beats expectations" or "tops the charts" alone do not count.
CLAIM = re.compile(r"\b(outperform(?:s|ed|ing)?|surpass(?:es|ed|ing)?|beats?|beating|exceed(?:s|ed|ing)?|rivals?|matches|"
                   r"state[- ]of[- ]the[- ]art|SOTA|tops?|topping|ahead of|leads?|overtakes?|overtook)\b", re.I | re.A)


# Capitalised words that sit in front of a number without being a model: dates ("November 6"), counts and glue words.
_NOT_NAMES = {"january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
              "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
              "day", "week", "month", "year", "q", "version", "part", "step", "page", "issue", "vol", "chapter", "episode",
              "only", "than", "with", "from", "over", "under", "about", "nearly", "just", "hits", "scores", "top", "best",
              "model", "models", "number", "no"}


def story_key(text: str, chars: int) -> str:
    """The first version-like model name in the opening text, normalised ('Inkling 2' -> 'inkling2'); '' if none.
    Dates, years and glue words ('November 6', 'Agents 2026', 'Only 28') are skipped: they matched in the first live
    run and glued unrelated pages into one story. Pages about the same model share a key, so a run fetches one of
    them, not all. Merging two different models that share a first-mentioned name is the safe error: it costs a
    fetch, never a wrong score."""
    for m in MODEL_NAME.finditer((text or "")[:chars]):
        name = m.group(0)
        word = re.match(r"[A-Za-z]+", name).group(0).lower()
        number = re.search(r"\d+(?:\.\d+)*", name).group(0)
        if word in _NOT_NAMES or re.fullmatch(r"(?:19|20)\d\d", number):
            continue
        return re.sub(r"[\s-]+", "", name).lower()
    return ""


def triage(text: str, chars: int, judge: Callable[[str], str] | None = None, zh=None) -> dict:
    """`zh` is an optional (verb_regex, ai_regex) built from the APPROVED lexicon (lexicon.triage_regexes); this
    module holds no Chinese literals. Model names are still matched as ASCII (Qwen3, DeepSeek-V4, GPT 6.1)."""
    head = (text or "")[:chars]
    verb, ai, name, bench = (bool(r.search(head)) for r in (VERBS, AI_WORDS, MODEL_NAME, BENCH))
    if zh:
        verb = verb or bool(zh[0] and zh[0].search(head))
        ai = ai or bool(zh[1] and zh[1].search(head))
    claim = bool(CLAIM.search(head)) and bench
    reasons = [label for label, hit in (("release verb", verb), ("challenger claim", claim and not verb), ("AI wording", ai),
                                        ("model-like name", name), ("benchmark mention", bench)) if hit]
    if (verb or claim) and ai and name:
        verdict = "release"
    elif not ai:
        verdict = "not_release"
    else:
        verdict = "unsure"
        if judge is not None:
            answer = judge(head)
            if answer in {"release", "not_release"}:
                verdict, reasons = answer, reasons + ["settled by judge"]
    return {"verdict": verdict, "reasons": reasons, "mentions_benchmark": bench}
