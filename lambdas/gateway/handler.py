"""POST https://patelpb.com/api/gateway/{publish,beat,end} -> live/gateway/{state,beat}.json.

Writer-only API for the Scratch "gateway" page. The only client is the local editor relay
(scripts/gateway/server.mjs). Bodies are already end-to-end encrypted in the browser; this
function never sees the viewer password or the plaintext.

Reached only through CloudFront (Function URL, AuthType AWS_IAM, Lambda OAC). The
/api/gateway/* behavior's viewer-request function (patelpb-gateway-auth) already rejects a
missing or wrong x-gateway-key at the edge; the key is checked again here against the
SHA-256 in SSM (cached for 60 s, so a rotation takes effect within a minute).

    publish {v, seq, kid, salt, iv, ct}  -> state.json (live) then beat.json
    beat    {seq}                        -> beat.json
    end     {seq}                        -> state.json {live:false} then beat.json {live:false}

Responses (JSON, Cache-Control: no-store): 200 {"status":"ok","seq":...}, 400 bad request,
401 bad key, 405 non-POST, 409 {"status":"stale","last_seq":...} (seq older than one this
warm instance already wrote), 413 body too large, 500. Never 403/404: the distribution
rewrites those to /404.html.
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
from datetime import datetime, timezone

import boto3

BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("LIVE_PREFIX", "live/gateway/")
PARAM = os.environ["KEY_HASH_PARAM"]
ROUTE = "/api/gateway/"
MAX_BODY = 256 * 1024
CACHE_CONTROL = "public, max-age=1"
HASH_TTL = 60.0

s3 = boto3.client("s3")
ssm = boto3.client("ssm")

_hash: tuple[float, str] | None = None  # (fetched_at, hex sha256 of the writer key)
_last_seq = 0
B64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")
KID = re.compile(r"^[0-9a-f]{8,64}$")


def respond(code: int, body: dict, extra_headers: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
    headers.update(extra_headers or {})
    return {"statusCode": code, "headers": headers, "body": json.dumps(body)}


def err(code: int, msg: str) -> dict:
    return respond(code, {"status": "error", "error": msg})


def key_hash() -> str:
    global _hash
    now = time.monotonic()
    if _hash is None or now - _hash[0] > HASH_TTL:
        value = ssm.get_parameter(Name=PARAM)["Parameter"]["Value"].strip().lower()
        _hash = (now, value)
    return _hash[1]


def authorized(headers: dict) -> bool:
    key = headers.get("x-gateway-key") or ""
    got = hashlib.sha256(key.encode()).hexdigest()
    return bool(key) and hmac.compare_digest(got, key_hash())


def put(name: str, doc: dict) -> None:
    s3.put_object(Bucket=BUCKET, Key=PREFIX + name, Body=json.dumps(doc, separators=(",", ":")).encode(),
                  ContentType="application/json; charset=utf-8", CacheControl=CACHE_CONTROL)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def beat(seq: int, live: bool) -> dict:
    return {"v": 1, "live": live, "seq": seq, "beat": time.time_ns() // 1_000_000, "updated": utc_now()}


def as_seq(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**53 else None


def valid_publish(body: dict) -> bool:
    if body.get("v") != 1 or as_seq(body.get("seq")) is None:
        return False
    if not isinstance(body.get("kid"), str) or not KID.match(body["kid"]):
        return False
    for f, limit in (("salt", 64), ("iv", 32), ("ct", MAX_BODY)):
        v = body.get(f)
        if not isinstance(v, str) or not v or len(v) > limit or not B64.match(v):
            return False
    return True


def handler(event, context):
    global _last_seq
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "").upper()
    path = (event.get("rawPath") or "").rstrip("/")
    action = path[len(ROUTE):] if path.startswith(ROUTE) else ""
    if action not in ("publish", "beat", "end"):
        return err(400, "unknown endpoint")
    if method != "POST":
        return respond(405, {"status": "error", "error": "method not allowed"}, {"Allow": "POST"})
    try:
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        if not authorized(headers):
            return err(401, "unauthorized")
        raw = event.get("body") or ""
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        if len(raw) > MAX_BODY + 1024:
            return err(413, "body too large")
        try:
            body = json.loads(raw)
        except ValueError:
            return err(400, "body must be JSON")
        if not isinstance(body, dict):
            return err(400, "body must be an object")
        seq = as_seq(body.get("seq"))
        if seq is None:
            return err(400, "bad seq")
        if action != "beat" and seq < _last_seq:
            return respond(409, {"status": "stale", "last_seq": _last_seq})

        if action == "publish":
            if not valid_publish(body):
                return err(400, "bad publish body")
            put("state.json", {"v": 1, "live": True, "seq": seq, "kid": body["kid"],
                               "salt": body["salt"], "iv": body["iv"], "ct": body["ct"]})
            put("beat.json", beat(seq, True))
        elif action == "beat":
            put("beat.json", beat(max(seq, _last_seq), True))
        else:  # end: drop the ciphertext first, then tell viewers
            put("state.json", {"v": 1, "live": False, "seq": seq})
            put("beat.json", beat(seq, False))
        if action != "beat":
            _last_seq = seq
        print(json.dumps({"event": action, "seq": seq, "bytes": len(raw)}))
        return respond(200, {"status": "ok", "seq": seq})
    except Exception:
        traceback.print_exc()
        return respond(500, {"status": "error"})
