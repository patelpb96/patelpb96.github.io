"""Shared S3 state for the RS alchemy live refresh (trigger + worker Lambdas).

Objects (bucket BUCKET, served by CloudFront at https://patelpb.com/live/rs-alchemy/...):
    live/rs-alchemy/latest.json  live rows, same schema/sort as rs-alchemy/data/latest.json
    live/rs-alchemy/meta.json    {status, updated_utc, started_utc, next_allowed_utc,
                                  n_items, n_failed, error, trigger}
    live/rs-alchemy/lock         single-flight lock; created with If-None-Match: *
                                 body {"token", "started_utc", "trigger"}
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

BUCKET = os.environ.get("BUCKET", "patelpb-com-site")
PREFIX = os.environ.get("LIVE_PREFIX", "live/rs-alchemy/")
LATEST_KEY = PREFIX + "latest.json"
META_KEY = PREFIX + "meta.json"
LOCK_KEY = PREFIX + "lock"
COOLDOWN = timedelta(minutes=int(os.environ.get("COOLDOWN_MINUTES", "15")))
STALE_LOCK = timedelta(minutes=int(os.environ.get("STALE_LOCK_MINUTES", "5")))
PUBLIC_CACHE = "public, max-age=5"
JSON_TYPE = "application/json; charset=utf-8"

s3 = boto3.client("s3")


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _code(e: ClientError) -> str:
    return str(e.response.get("Error", {}).get("Code", ""))


def _status(e: ClientError) -> int:
    return int(e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))


def get_json(key: str):
    """(obj, etag) or (None, None) if the key does not exist."""
    try:
        r = s3.get_object(Bucket=BUCKET, Key=key)
    except ClientError as e:
        if _code(e) in ("NoSuchKey", "404", "NotFound"):
            return None, None
        raise
    return json.loads(r["Body"].read().decode("utf-8")), r["ETag"]


def put_public_json(key: str, body: bytes) -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=JSON_TYPE, CacheControl=PUBLIC_CACHE)


# ------------------------------------------------------------------------- meta

EMPTY_META = {
    "status": "idle",
    "updated_utc": None,
    "started_utc": None,
    "next_allowed_utc": None,
    "n_items": 0,
    "n_failed": 0,
    "error": None,
    "trigger": None,
}


def read_meta() -> dict:
    meta, _ = get_json(META_KEY)
    out = dict(EMPTY_META)
    if isinstance(meta, dict):
        out.update({k: meta.get(k, v) for k, v in EMPTY_META.items()})
    return out


def write_meta(meta: dict) -> None:
    body = json.dumps({k: meta.get(k) for k in EMPTY_META})  # fixed key order
    put_public_json(META_KEY, body.encode("ascii"))


def in_cooldown(meta: dict, now: datetime) -> bool:
    nxt = parse_iso(meta.get("next_allowed_utc"))
    return bool(meta.get("updated_utc")) and nxt is not None and now < nxt


# ------------------------------------------------------------------------- lock

def acquire_lock(trigger: str):
    """Single-flight lock via S3 conditional writes.

    Returns (True, lock) on success, or (False, existing_lock) if another run holds a
    non-stale lock. A lock older than STALE_LOCK (crashed worker) is taken over with an
    If-Match conditional overwrite, so two concurrent takeovers cannot both win.
    """
    now = now_utc()
    lock = {"token": uuid.uuid4().hex, "started_utc": iso(now), "trigger": trigger}
    body = json.dumps(lock).encode("ascii")
    for _ in range(3):
        try:
            s3.put_object(Bucket=BUCKET, Key=LOCK_KEY, Body=body, IfNoneMatch="*",
                          ContentType=JSON_TYPE, CacheControl="no-store")
            return True, lock
        except ClientError as e:
            # 412 PreconditionFailed: exists; 409 ConditionalRequestConflict: racing write
            if _status(e) not in (409, 412) and _code(e) not in ("PreconditionFailed", "ConditionalRequestConflict"):
                raise
        held, etag = get_json(LOCK_KEY)
        if held is None:
            continue  # released between our put and get; retry the create
        started = parse_iso(held.get("started_utc")) if isinstance(held, dict) else None
        if started is not None and now - started < STALE_LOCK:
            return False, held
        try:  # stale: take it over atomically
            s3.put_object(Bucket=BUCKET, Key=LOCK_KEY, Body=body, IfMatch=etag,
                          ContentType=JSON_TYPE, CacheControl="no-store")
            return True, lock
        except ClientError as e:
            if _status(e) not in (404, 409, 412) and _code(e) not in ("PreconditionFailed", "ConditionalRequestConflict", "NoSuchKey"):
                raise
    held, _ = get_json(LOCK_KEY)
    return False, held or {}


def release_lock(token: str) -> None:
    """Delete the lock if we still own it (best effort)."""
    try:
        held, _ = get_json(LOCK_KEY)
    except ClientError:
        held = None
    if isinstance(held, dict) and held.get("token") == token:
        s3.delete_object(Bucket=BUCKET, Key=LOCK_KEY)
