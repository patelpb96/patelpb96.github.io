"""Prompt-injection screen for fetched text, and a strict check on an extraction agent's reply.

Layer 1 here is deterministic and free: obvious instruction-like phrases, hidden-character tricks and
shell/exfiltration bait. A flagged page is quarantined and skipped, never retried by hand. Layer 2 is the
Jev condition set (`judge`, a callable returning a probability of injection), which the dry run does not
wire. The extraction agent itself gets no tools; `validate_reply` makes its output unable to carry anything
but the expected numbers.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Callable

PATTERNS = [
    ("ignore-instructions", r"\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b"),
    ("role-reset", r"\b(you are now|from now on you|act as (?:an? )?(?:unrestricted|different)|new instructions?:)"),
    ("prompt-reveal", r"\b(reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(system prompt|your instructions|hidden prompt|api[_ -]?key|secret|credentials?)\b"),
    ("chat-template", r"(<\|im_start\|>|<\|system\|>|\[INST\]|^\s*(system|assistant)\s*:)"),
    ("tool-bait", r"\b(run|execute|call|invoke)\b[^.\n]{0,30}\b(command|shell|script|tool|function|curl|powershell|bash)\b"),
    ("shell-payload", r"(rm\s+-rf|curl\s+[^|\n]*\|\s*(ba)?sh|Invoke-WebRequest|powershell\s+-enc)"),
    ("exfiltration", r"\b(send|post|upload|forward|email)\b[^.\n]{0,40}\b(to|at)\b[^.\n]{0,20}(https?://|\S+@\S+)"),
    ("secrecy", r"\bdo not (tell|inform|mention|show)[^.\n]{0,20}\b(user|human|anyone)\b"),
]
COMPILED = [(name, re.compile(rx, re.I | re.M | re.A)) for name, rx in PATTERNS]   # re.A: \b works next to Chinese text
MAX_FORMAT_CHARS = 3       # zero-width and other format characters allowed before it counts as hiding text


def prescreen(text: str, extra=None) -> list[str]:
    """`extra` is a list of (name, regex), e.g. the approved Chinese phrases from lexicon.injection_patterns."""
    found = [name for name, rx in COMPILED + list(extra or []) if rx.search(text or "")]
    hidden = sum(1 for c in (text or "") if unicodedata.category(c) == "Cf")
    if hidden > MAX_FORMAT_CHARS:
        found.append("hidden-format-characters")
    return found


def screen(text: str, judge: Callable[[str], float] | None = None, threshold: float = 0.5, extra=None) -> dict:
    """flagged is True if the pattern pre-screen fires, or the judge's probability reaches the threshold."""
    reasons = prescreen(text, extra)
    prob = None
    if not reasons and judge is not None:
        prob = judge(text)
        if prob >= threshold:
            reasons.append(f"judge:{prob:.2f}")
    return {"flagged": bool(reasons), "reasons": reasons, "judge_prob": prob}


REPLY_KEYS = {"benchmark_id": str, "value": (int, float), "model_id": (str, type(None)), "effort": (str, type(None))}


def validate_reply(items) -> list[dict]:
    """Accept only a list of {benchmark_id, value, model_id, effort} with short strings and sane numbers."""
    if not isinstance(items, list) or len(items) > 50:
        raise ValueError("reply must be a list of at most 50 items")
    clean = []
    for it in items:
        if not isinstance(it, dict) or set(it) - set(REPLY_KEYS) or not {"benchmark_id", "value"} <= set(it):
            raise ValueError(f"unexpected item shape: {sorted(it) if isinstance(it, dict) else type(it).__name__}")
        for k, t in REPLY_KEYS.items():
            v = it.get(k)
            if k in it and (not isinstance(v, t) or isinstance(v, bool)):
                raise ValueError(f"{k} has the wrong type")
            if isinstance(v, str) and (len(v) > 80 or not re.fullmatch(r"[A-Za-z0-9_./ +-]*", v)):
                raise ValueError(f"{k} is not a short plain identifier")
        if not 0 <= it["value"] <= 10000:
            raise ValueError("value out of range")
        clean.append({k: it.get(k) for k in REPLY_KEYS})
    return clean
