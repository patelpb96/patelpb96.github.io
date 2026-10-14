"""POST https://patelpb.com/api/newsroom/put -> live/newsroom/<name>.

Writer API for the private "newsroom" (see projects/newsroom/PROTOCOL.md). Both clients, the
home daemon (newsdesk) and the phone page, write through this one endpoint; bodies are already
end-to-end encrypted (AES-GCM envelopes), so this function never sees the password or any
plaintext. Only beat.json (a few plain counters) is stored unencrypted.

Reached only through CloudFront (Function URL, AuthType AWS_IAM, Lambda OAC). The
/api/newsroom/* behavior's viewer-request function (patelpb-newsroom-auth) already rejects a
missing or wrong x-newsroom-key at the edge; the key is checked again here against the SHA-256
in SSM (cached for 60 s, so a rotation takes effect within a minute). A second, optional "day"
key (TEMP_HASH_PARAM, value "<sha256>:<expires epoch s>", written by `newsdesk temp`) is accepted
too until it expires; "none" or a missing parameter means no day key.

Open mode (`newsdesk open`, OPEN_HASH_PARAM "<sha256>:<expires epoch s>:<limit>"): the open token is
public (config.json), so it may only add new requests, open/inbox/<rid>.json, at most <limit> per open
period (the period is named by its expiry). Everything else stays master/day only.

    put {name, doc}   name must match NAME (allowlist; no other key is ever writable)
                      beat.json  -> small plain object {v, beat, busy, version}
                      otherwise  -> envelope {v, name, seq, iv, ct} with name == target name
                      inbox/<rid>.json also appends rid to inbox/index.json {v, seq, ids}

                      open/inbox/<rid>.json appends to open/inbox/index.json {v, seq, ids, period}

Responses (JSON, Cache-Control: no-store): 200 {"status":"ok"}, 400 bad request, 401 bad key,
405 non-POST, 409 rid already used (open), 413 body too large, 429 open limit used up, 500. Never 403/404: the distribution rewrites those to
/404.html.
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

import boto3

BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("LIVE_PREFIX", "live/newsroom/")
PARAM = os.environ["KEY_HASH_PARAM"]
TEMP_PARAM = os.environ.get("TEMP_HASH_PARAM", "")
OPEN_PARAM = os.environ.get("OPEN_HASH_PARAM", "")
ROUTE = "/api/newsroom/put"
MAX_BODY = 900 * 1024
MAX_BEAT = 1024
MAX_IDS = 50
MAX_OPEN_BODY = 8 * 1024   # an open request is a short encrypted sentence or two
CACHE_CONTROL = "public, max-age=1"
CONTENT_TYPE = "application/json; charset=utf-8"
HASH_TTL = 60.0

s3 = boto3.client("s3")
ssm = boto3.client("ssm")

_hash: tuple[float, str] | None = None  # (fetched_at, hex sha256 of the newsroom token)
_temp: tuple[float, str, float] | None = None  # (fetched_at, hex sha256 of the day token, expires epoch s)
_open: tuple[float, str, float, int] | None = None  # (fetched_at, sha256 of the open token, expires, limit)
NAME = re.compile(r"^(beat\.json|(open/)?inbox/r-[a-z0-9]{8,32}\.json|(open/)?out/index\.json"
                  r"|(open/)?out/r-[a-z0-9]{8,32}/(status|plane|edition)\.json)$")
INBOX = re.compile(r"^(open/)?inbox/(r-[a-z0-9]{8,32})\.json$")
B64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")
IV = re.compile(r"^[A-Za-z0-9+/]{16}$")  # 12 bytes -> 16 base64 chars, no padding
ENVELOPE_KEYS = {"v", "name", "seq", "iv", "ct"}
BEAT_KEYS = {"v", "beat", "busy", "version"}


def respond(code: int, body: dict, extra_headers: dict | None = None) -> dict:
    headers = {"Content-Type": CONTENT_TYPE, "Cache-Control": "no-store"}
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


def temp_hash(now_s: float | None = None) -> str | None:
    """sha256 of the day token while it is unexpired, else None."""
    global _temp
    if not TEMP_PARAM:
        return None
    now = time.monotonic()
    if _temp is None or now - _temp[0] > HASH_TTL:
        try:
            value = ssm.get_parameter(Name=TEMP_PARAM)["Parameter"]["Value"].strip().lower()
        except Exception:  # ParameterNotFound (no day key yet) or SSM trouble: no day key
            value = "none"
        digest, _, exp = value.partition(":")
        try:
            _temp = (now, digest, float(exp))
        except ValueError:
            _temp = (now, "", 0.0)
    _, digest, exp = _temp
    return digest if len(digest) == 64 and (now_s if now_s is not None else time.time()) < exp else None


def open_key(now_s: float | None = None) -> tuple[str, int, int] | None:
    """(sha256 of the open token, expires, limit) while open mode is on, else None."""
    global _open
    if not OPEN_PARAM:
        return None
    now = time.monotonic()
    if _open is None or now - _open[0] > HASH_TTL:
        try:
            value = ssm.get_parameter(Name=OPEN_PARAM)["Parameter"]["Value"].strip().lower()
        except Exception:  # ParameterNotFound (never opened) or SSM trouble: closed
            value = "none"
        parts = value.split(":")
        try:
            _open = (now, parts[0], float(parts[1]), int(parts[2]))
        except (IndexError, ValueError):
            _open = (now, "", 0.0, 0)
    _, digest, exp, limit = _open
    ok = len(digest) == 64 and limit > 0 and (now_s if now_s is not None else time.time()) < exp
    return (digest, int(exp), limit) if ok else None


def authorized(headers: dict) -> str | None:
    """"full" for the master or day key, "open" for the public open key, else None."""
    key = headers.get("x-newsroom-key") or ""
    if not key:
        return None
    got = hashlib.sha256(key.encode()).hexdigest()
    if hmac.compare_digest(got, key_hash()):
        return "full"
    day = temp_hash()
    if day and hmac.compare_digest(got, day):
        return "full"
    op = open_key()
    if op and hmac.compare_digest(got, op[0]):
        return "open"
    return None


def put(name: str, doc: dict) -> None:
    s3.put_object(Bucket=BUCKET, Key=PREFIX + name, Body=json.dumps(doc, separators=(",", ":")).encode(),
                  ContentType=CONTENT_TYPE, CacheControl=CACHE_CONTROL)


def is_int(value, low: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value < 2**53


def valid_envelope(doc, name: str) -> bool:
    if not isinstance(doc, dict) or set(doc) != ENVELOPE_KEYS:
        return False
    if doc["v"] != 1 or doc["name"] != name or not is_int(doc["seq"]):
        return False
    if not isinstance(doc["iv"], str) or not IV.fullmatch(doc["iv"]):
        return False
    ct = doc["ct"]
    # at least the 16-byte GCM tag (24 base64 chars); never more than the body limit
    return isinstance(ct, str) and 24 <= len(ct) <= MAX_BODY and len(ct) % 4 == 0 and bool(B64.fullmatch(ct))


def valid_beat(doc) -> bool:
    if not isinstance(doc, dict) or not set(doc) <= BEAT_KEYS:
        return False
    if doc.get("v") != 1 or not is_int(doc.get("beat")):
        return False
    if "busy" in doc and not isinstance(doc["busy"], bool):
        return False
    if "version" in doc and not (doc["version"] is None
                                 or (isinstance(doc["version"], str) and len(doc["version"]) <= 64)):
        return False
    return len(json.dumps(doc, separators=(",", ":"))) <= MAX_BEAT


def read_index(name: str = "inbox/index.json") -> dict:
    """Current inbox index; a missing (or not-ours) file counts as empty."""
    try:
        raw = s3.get_object(Bucket=BUCKET, Key=PREFIX + name)["Body"].read()
    except Exception as e:  # botocore ClientError: NoSuchKey (ListBucket is granted, so not 403)
        code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            return {"v": 1, "seq": 0, "ids": []}
        raise
    try:
        cur = json.loads(raw)
    except ValueError:
        cur = None
    if not isinstance(cur, dict) or not isinstance(cur.get("ids"), list) or not is_int(cur.get("seq")):
        return {"v": 1, "seq": 0, "ids": []}
    out = {"v": 1, "seq": cur["seq"], "ids": [i for i in cur["ids"] if isinstance(i, str)]}
    if is_int(cur.get("period")):
        out["period"] = cur["period"]
    return out


def append_inbox(rid: str) -> None:
    idx = read_index()
    if rid not in idx["ids"]:
        idx["ids"].append(rid)
    idx["ids"] = idx["ids"][-MAX_IDS:]
    idx["seq"] += 1
    put("inbox/index.json", idx)


def open_index(period: int) -> dict:
    """open/inbox/index.json for this open period (a new period starts empty)."""
    idx = read_index("open/inbox/index.json")
    if idx.get("period") != period:
        idx = {"v": 1, "seq": idx["seq"], "ids": [], "period": period}
    return idx


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "").upper()
    path = (event.get("rawPath") or "").rstrip("/")
    if path != ROUTE:
        return err(400, "unknown endpoint")
    if method != "POST":
        return respond(405, {"status": "error", "error": "method not allowed"}, {"Allow": "POST"})
    try:
        headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        tier = authorized(headers)
        if not tier:
            return err(401, "unauthorized")
        raw = event.get("body") or ""
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        if len(raw.encode()) > (MAX_OPEN_BODY if tier == "open" else MAX_BODY):
            return err(413, "body too large")
        try:
            body = json.loads(raw)
        except ValueError:
            return err(400, "body must be JSON")
        if not isinstance(body, dict):
            return err(400, "body must be an object")
        name, doc = body.get("name"), body.get("doc")
        if not isinstance(name, str) or not NAME.fullmatch(name):
            return err(400, "bad name")
        if name == "beat.json":
            if not valid_beat(doc):
                return err(400, "bad beat")
        elif not valid_envelope(doc, name):
            return err(400, "bad envelope")

        m = INBOX.fullmatch(name)
        if tier == "open" and not (m and m.group(1)):
            return err(401, "the open key can only send requests")
        if m and m.group(1):  # open/inbox: new rids only, at most `limit` per open period
            op = open_key()
            if not op:
                return err(401, "open mode is off")
            idx = open_index(op[1])
            if m.group(2) in idx["ids"]:
                return err(409, "request id already used")
            if len(idx["ids"]) >= min(op[2], MAX_IDS):
                return err(429, "the open request limit is used up")
            put(name, doc)  # object first, then the index that advertises it
            idx["ids"].append(m.group(2))
            idx["seq"] += 1
            put("open/inbox/index.json", idx)
        else:
            put(name, doc)
            if m:
                append_inbox(m.group(2))
        if name != "beat.json":  # beats arrive every 20 s; keep the log readable
            print(json.dumps({"event": "put", "name": name, "bytes": len(raw)}))
        return respond(200, {"status": "ok"})
    except Exception:
        traceback.print_exc()
        return respond(500, {"status": "error"})
