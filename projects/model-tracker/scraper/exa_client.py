"""Build Exa requests, keep the newest results, and (live only) call api.exa.ai.

Exa ranks by relevance, not date, so we ask for `num_results` inside the time window, de-duplicate by
canonical URL, sort by publishedDate and keep the newest `keep_newest`. The key is read from the
EXA_API_KEY environment variable only when a live client is built; it is never logged or echoed.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

EXA_URL = "https://api.exa.ai/search"
DROP_PARAMS = {"ref", "fbclid", "gclid", "mc_cid", "mc_eid"}


def canonical_url(url: str) -> str:
    p = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.startswith("utm_") and k not in DROP_PARAMS]
    path = p.path.rstrip("/") or "/"
    return urlunsplit((p.scheme.lower() or "https", p.netloc.lower(), path, urlencode(query), ""))


def url_hash(url: str) -> str:
    return hashlib.sha256(canonical_url(url).encode("utf-8")).hexdigest()


def build_request(phrase: str, caps: dict, exa_params: dict, now: datetime) -> dict:
    start = max(now - timedelta(hours=caps["window_hours"]), datetime.fromisoformat(caps["history_start"]))
    body = {k: v for k, v in exa_params.items() if v not in ([], None)}
    body.update({
        "query": phrase,
        "numResults": caps["num_results"],
        "startPublishedDate": start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    })
    return body


def cutoff_for(now: datetime) -> str:
    """The latest publishedDate we accept: the run time itself. Later-dated pages are clock errors or scheduled posts."""
    return now.strftime("%Y-%m-%dT%H:%M:%S.999Z")


def is_future(result: dict, cutoff: str) -> bool:
    return (result.get("publishedDate") or "") > cutoff       # ISO-8601 strings compare chronologically; undated is not "future"


def newest(results: list[dict], keep: int, not_after: str | None = None) -> list[dict]:
    """De-duplicate, drop anything dated after `not_after` (before ranking, so it cannot take a slot), sort newest first."""
    seen, unique = set(), []
    for r in results:
        h = url_hash(r["url"])
        if h not in seen and not (not_after and is_future(r, not_after)):
            seen.add(h)
            unique.append(r)
    # ISO-8601 strings sort chronologically; a missing date sorts last.
    return sorted(unique, key=lambda r: r.get("publishedDate") or "", reverse=True)[:keep]


def cost_of(doc: dict) -> float | None:
    try:
        return float((doc.get("costDollars") or {})["total"])
    except (KeyError, TypeError, ValueError):
        return None


class ExaError(Exception):
    pass


class LiveExa:
    def __init__(self, key: str | None = None, timeout: int = 55):
        self._key = key or os.environ.get("EXA_API_KEY")
        if not self._key:
            raise ExaError("EXA_API_KEY is not set (the dry run uses FixtureExa and needs no key)")
        self.timeout = timeout

    def search(self, body: dict) -> dict:
        req = urllib.request.Request(
            EXA_URL, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"x-api-key": self._key, "Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "patelpb-model-tracker/1"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise ExaError(f"Exa returned HTTP {e.code}") from None   # never echo headers or the request
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            raise ExaError(f"Exa call failed: {type(e).__name__}") from None


class FixtureExa:
    """Replays recorded or hand-made responses keyed by query text; makes no network call."""

    def __init__(self, by_query: dict[str, dict]):
        self.by_query = by_query
        self.calls: list[dict] = []

    def search(self, body: dict) -> dict:
        self.calls.append(body)
        return self.by_query.get(body["query"], {"results": [], "costDollars": {"total": 0.0}})
