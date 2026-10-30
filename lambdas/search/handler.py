"""POST https://patelpb.com/api/search/{whoami,search,agent,run} -> Exa (api.exa.ai).

Password-gated Exa search for the /search/ page. The Exa API key never leaves AWS: it lives
in SSM as a SecureString and is added here. Two kinds of caller key, both sent as
x-search-key and both checked at the edge first (CloudFront Function patelpb-search-auth):

    password  hex(PBKDF2-SHA256(password, config salt, iter)) from the page; capped (see LIMITS)
    device    random token enrolled once on Preet's PC (infra/search_setup.py device); uncapped

Each is re-checked here against its SHA-256 in SSM (60 s cache, so rotations land within a minute).

    whoami {}                    -> {status, role, limits, spent_today}
    search {request}             -> Exa POST /search            (request = Exa SearchRequest)
    agent  {request}             -> Exa POST /agent/runs        (request = Exa CreateAgentRunRequest)
    run    {id}                  -> Exa GET  /agent/runs/{id}

Password callers share a daily dollar budget (SSM /patelpb/search/spend, soft: checked before
each call, charged from Exa's costDollars after). Responses JSON, Cache-Control: no-store:
200 {"status":"ok","exa":...}, 400 bad request (or Exa's own 400, message passed through),
401 bad key, 405 non-POST, 413 body too large, 429 limit reached / Exa rate limit, 502 Exa
error, 503 Exa key not configured, 500. Never 403/404: the distribution rewrites those.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

import boto3

KEY_PARAM = os.environ["KEY_HASH_PARAM"]
DEVICE_PARAM = os.environ["DEVICE_HASH_PARAM"]
EXA_KEY_PARAM = os.environ["EXA_KEY_PARAM"]
SPEND_PARAM = os.environ["SPEND_PARAM"]
DAILY_CAP = float(os.environ.get("DAILY_CAP_USD", "3"))
EXA_BASE = os.environ.get("EXA_BASE", "https://api.exa.ai")
ROUTE = "/api/search/"
MAX_BODY = 200 * 1024
HASH_TTL = 60.0
EXA_TIMEOUT = 55  # the CloudFront origin read timeout for /api/search/* is 60 s
HIGHLIGHTS_BETA = "dynamic-highlights-2026-08-28"

# Per-role request limits. None = Exa's own limits only.
LIMITS = {
    "device": {"maxResults": 100, "agentEfforts": None, "agentMaxCost": None, "dailyCapUsd": None},
    "password": {"maxResults": 25, "agentEfforts": ["auto"], "agentMaxCost": 2.0, "dailyCapUsd": DAILY_CAP},
}

SEARCH_KEYS = {
    "query", "type", "numResults", "category", "includeDomains", "excludeDomains", "startPublishedDate",
    "endPublishedDate", "userLocation", "moderation", "contents", "additionalQueries", "objective",
    "systemPrompt", "outputSchema", "includeText", "excludeText",
}
AGENT_KEYS = {"query", "systemPrompt", "effort", "input", "outputSchema", "previousRunId", "dataSources", "budget"}
RUN_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")

ssm = boto3.client("ssm")
_cache: dict[str, tuple[float, str | None]] = {}


def respond(code: int, body: dict, extra_headers: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
    headers.update(extra_headers or {})
    return {"statusCode": code, "headers": headers, "body": json.dumps(body)}


def err(code: int, msg: str, **extra) -> dict:
    return respond(code, {"status": "error", "error": msg, **extra})


def param(name: str, decrypt: bool = False) -> str | None:
    """SSM value (cached HASH_TTL s); None if the parameter doesn't exist."""
    now = time.monotonic()
    hit = _cache.get(name)
    if hit is None or now - hit[0] > HASH_TTL:
        try:
            value = ssm.get_parameter(Name=name, WithDecryption=decrypt)["Parameter"]["Value"].strip()
        except Exception as e:  # ParameterNotFound (or a transient error: fail closed)
            if "ParameterNotFound" not in repr(e) and "ParameterNotFound" not in type(e).__name__:
                raise
            value = None
        hit = (now, value)
        _cache[name] = hit
    return hit[1]


def role_of(headers: dict) -> str | None:
    key = headers.get("x-search-key") or ""
    if not key:
        return None
    got = hashlib.sha256(key.encode()).hexdigest()
    for role, name in (("device", DEVICE_PARAM), ("password", KEY_PARAM)):
        want = (param(name) or "").lower()
        if want and hmac.compare_digest(got, want):
            return role
    return None


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def spent_today() -> float:
    try:
        doc = json.loads(ssm.get_parameter(Name=SPEND_PARAM)["Parameter"]["Value"])
    except Exception:
        return 0.0
    return float(doc.get("usd", 0)) if doc.get("day") == today() else 0.0


def charge(usd: float) -> None:
    if usd <= 0:
        return
    doc = {"day": today(), "usd": round(spent_today() + usd, 6)}
    ssm.put_parameter(Name=SPEND_PARAM, Value=json.dumps(doc), Type="String", Overwrite=True)


def cost_of(doc) -> float:
    try:
        return float(((doc or {}).get("costDollars") or {}).get("total") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def exa(method: str, path: str, body: dict | None = None, beta: list[str] | None = None) -> tuple[int, dict]:
    key = param(EXA_KEY_PARAM, decrypt=True)
    if not key:
        raise MissingExaKey()
    headers = {"x-api-key": key, "Accept": "application/json", "User-Agent": "patelpb-search/1"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if beta:
        headers["Exa-Beta"] = ",".join(beta)
    req = urllib.request.Request(EXA_BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=EXA_TIMEOUT) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read() or b"{}"
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw.decode(errors="replace")[:500]}


class MissingExaKey(Exception):
    pass


def exa_error(code: int, doc: dict) -> dict:
    """Map an Exa error onto our status codes (never 403/404, which CloudFront rewrites)."""
    e = doc.get("error")
    msg = e.get("message") if isinstance(e, dict) else e
    msg = str(msg or doc.get("tag") or f"Exa returned HTTP {code}")[:1000]
    ours = 400 if code == 400 else 429 if code == 429 else 502
    return err(ours, msg, exa_status=code, exa=doc)


def needs_beta(req: dict) -> bool:
    h = (req.get("contents") or {}).get("highlights")
    return isinstance(h, dict) and ("verbosity" in h or "dynamic" in h)


def clean_search(req, role: str) -> dict:
    if not isinstance(req, dict) or not isinstance(req.get("query"), str) or not req["query"].strip():
        raise BadRequest("request.query is required")
    unknown = set(req) - SEARCH_KEYS
    if unknown:
        raise BadRequest("unsupported search fields: " + ", ".join(sorted(unknown)))
    out = dict(req)
    n = out.get("numResults")
    if n is not None and (not isinstance(n, int) or isinstance(n, bool) or n < 1):
        raise BadRequest("numResults must be a positive integer")
    cap = LIMITS[role]["maxResults"]
    if n is not None and n > cap:
        raise BadRequest(f"numResults is limited to {cap}" + (" with the shared password" if role == "password" else ""))
    out["userIdentifier"] = f"patelpb-{role}"
    return out


def clean_agent(req, role: str) -> dict:
    if not isinstance(req, dict) or not isinstance(req.get("query"), str) or not req["query"].strip():
        raise BadRequest("request.query is required")
    unknown = set(req) - AGENT_KEYS
    if unknown:
        raise BadRequest("unsupported agent fields: " + ", ".join(sorted(unknown)))
    out = dict(req)
    lim = LIMITS[role]
    effort = out.get("effort", "auto")
    if lim["agentEfforts"] is not None and effort not in lim["agentEfforts"]:
        raise BadRequest("with the shared password the agent runs at effort " + " / ".join(lim["agentEfforts"]))
    if lim["agentMaxCost"] is not None:
        budget = dict(out.get("budget") or {})
        want = budget.get("maxCostDollars", lim["agentMaxCost"])
        if not isinstance(want, (int, float)) or isinstance(want, bool) or want > lim["agentMaxCost"]:
            raise BadRequest(f"agent budget is limited to ${lim['agentMaxCost']:g} with the shared password")
        budget["maxCostDollars"] = want
        budget.pop("maxDurationSeconds", None)
        out["budget"] = budget
        out["effort"] = effort
    out["userIdentifier"] = f"patelpb-{role}"
    return out


class BadRequest(Exception):
    pass


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "").upper()
    path = (event.get("rawPath") or "").rstrip("/")
    action = path[len(ROUTE):] if path.startswith(ROUTE) else ""
    if action not in ("whoami", "search", "agent", "run"):
        return err(400, "unknown endpoint")
    if method != "POST":
        return respond(405, {"status": "error", "error": "method not allowed"}, {"Allow": "POST"})
    try:
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        role = role_of(headers)
        if role is None:
            return err(401, "unauthorized")
        raw = event.get("body") or ""
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        if len(raw) > MAX_BODY:
            return err(413, "body too large")
        try:
            body = json.loads(raw) if raw.strip() else {}
        except ValueError:
            return err(400, "body must be JSON")
        if not isinstance(body, dict):
            return err(400, "body must be an object")

        lim = LIMITS[role]
        if action == "whoami":
            return respond(200, {"status": "ok", "role": role, "limits": lim,
                                 "spent_today": round(spent_today(), 4) if lim["dailyCapUsd"] else None,
                                 "exa_ready": bool(param(EXA_KEY_PARAM, decrypt=True))})
        if lim["dailyCapUsd"] is not None and spent_today() >= lim["dailyCapUsd"]:
            return err(429, f"today's shared budget (${lim['dailyCapUsd']:g}) is used up; try again tomorrow (UTC)")

        try:
            if action == "search":
                req = clean_search(body.get("request"), role)
                code, doc = exa("POST", "/search", req, [HIGHLIGHTS_BETA] if needs_beta(req) else None)
            elif action == "agent":
                req = clean_agent(body.get("request"), role)
                code, doc = exa("POST", "/agent/runs", req)
                if code == 200 and lim["dailyCapUsd"] is not None:
                    charge(req["budget"]["maxCostDollars"])  # reserve the whole budget up front
            else:
                run_id = body.get("id")
                if not isinstance(run_id, str) or not RUN_ID.match(run_id):
                    return err(400, "bad run id")
                code, doc = exa("GET", "/agent/runs/" + run_id)
        except BadRequest as e:
            return err(400, str(e))
        except MissingExaKey:
            return err(503, "the Exa API key isn't configured yet (infra/search_setup.py exa-key)")
        except (urllib.error.URLError, TimeoutError) as e:
            return err(502, f"couldn't reach Exa: {e}")

        if code != 200:
            return exa_error(code, doc if isinstance(doc, dict) else {})
        if action == "search" and lim["dailyCapUsd"] is not None:
            charge(cost_of(doc))
        return respond(200, {"status": "ok", "role": role, "exa": doc})
    except Exception:
        traceback.print_exc()
        return err(500, "internal error")
