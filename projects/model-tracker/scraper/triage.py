"""Cheap first look: does the first `chars` characters of a hit announce a model release?

Deterministic pass first (regex). A verdict of 'unsure' is kept for review and is NOT extracted; a Jev yes/no
can be passed as `judge` to settle it later (the dry run wires none). verdicts: release | not_release | unsure.
"""
from __future__ import annotations

import re
from typing import Callable

VERBS = re.compile(r"\b(releas(?:e[sd]?|ing)|launch(?:es|ed|ing)?|unveil(?:s|ed|ing)?|announc(?:e[sd]?|ing)|"
                   r"introduc(?:e[sd]?|ing)|debut(?:s|ed)?|rolls? out|now available|open[- ]sourc(?:e[sd]?|ing))\b", re.I)
AI_WORDS = re.compile(r"\b(AI|LLM|language models?|foundation models?|reasoning models?|open[- ]weights?|chatbot|model)\b", re.I)
# A version-like model name: "Orbit-9", "Qwen3.8", "GPT 6.1", "Llama 4"
MODEL_NAME = re.compile(r"\b[A-Z][A-Za-z]{1,}[- ]?\d+(?:\.\d+)*[A-Za-z]*\b")
BENCH = re.compile(r"\b(benchmark|SWE-?bench|GPQA|AIME|MMLU|HLE|LiveCodeBench|ARC-AGI|Terminal-?Bench|Intelligence Index)\b", re.I)


def triage(text: str, chars: int, judge: Callable[[str], str] | None = None) -> dict:
    head = (text or "")[:chars]
    verb, ai, name, bench = (bool(r.search(head)) for r in (VERBS, AI_WORDS, MODEL_NAME, BENCH))
    reasons = [label for label, hit in (("release verb", verb), ("AI wording", ai), ("model-like name", name), ("benchmark mention", bench)) if hit]
    if verb and ai and name:
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
