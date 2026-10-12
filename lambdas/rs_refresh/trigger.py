"""POST https://patelpb.com/api/rs/refresh -> start a live price refresh (single flight).

Reached only through CloudFront (Function URL, AuthType AWS_IAM, Lambda OAC).
Responses (JSON, Cache-Control: no-store):
    202 {"status": "started", "started_utc": ...}
    200 {"status": "running", "started_utc": ...}
    200 {"status": "fresh", "updated_utc": ..., "next_allowed_utc": ...}
    405 {"status": "error", "error": "method not allowed"}   (non-POST)
    400 {"status": "error", "error": "unknown endpoint"}     (other /api/* paths)
    500 {"status": "error"}
CloudFront/Lambda may also answer 429 (account concurrency limit of 10 hit) or 502/503.
Never 403/404: the distribution rewrites those to /404.html.
"""
from __future__ import annotations

import json
import os
import traceback

import boto3

import state

WORKER = os.environ["WORKER_FUNCTION"]
ROUTE = os.environ.get("ROUTE", "/api/rs/refresh")
lam = boto3.client("lambda")


def respond(code: int, body: dict, extra_headers: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
    headers.update(extra_headers or {})
    return {"statusCode": code, "headers": headers, "body": json.dumps(body)}


def fresh(meta: dict) -> dict:
    return respond(200, {"status": "fresh", "updated_utc": meta.get("updated_utc"),
                         "next_allowed_utc": meta.get("next_allowed_utc")})


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "").upper()
    path = (event.get("rawPath") or "").rstrip("/")
    if path != ROUTE:  # CloudFront forwards every /api/* path here
        return respond(400, {"status": "error", "error": "unknown endpoint"})
    if method != "POST":
        return respond(405, {"status": "error", "error": "method not allowed"}, {"Allow": "POST"})
    try:
        now = state.now_utc()
        meta = state.read_meta()
        if state.in_cooldown(meta, now):
            return fresh(meta)

        ok, lock = state.acquire_lock("button")
        if not ok:
            return respond(200, {"status": "running", "started_utc": lock.get("started_utc")})

        try:
            # Re-check after winning the lock: a run may have finished between our first
            # meta read and the lock create (it releases the lock after writing meta).
            meta = state.read_meta()
            if state.in_cooldown(meta, now):
                state.release_lock(lock["token"])
                return fresh(meta)

            prev_next = meta.get("next_allowed_utc")
            started = lock["started_utc"]
            state.write_meta({**meta, "status": "running", "started_utc": started, "error": None,
                              "trigger": "button"})
            lam.invoke(FunctionName=WORKER, InvocationType="Event",
                       Payload=json.dumps({"trigger": "button", "token": lock["token"],
                                           "started_utc": started,
                                           "prev_next_allowed_utc": prev_next}).encode())
        except Exception:
            traceback.print_exc()
            try:
                state.write_meta({**meta, "status": "error", "error": "failed to start refresh"})
            finally:
                state.release_lock(lock["token"])
            return respond(500, {"status": "error"})
        print(json.dumps({"event": "started", "started_utc": started}))
        return respond(202, {"status": "started", "started_utc": started})
    except Exception:
        traceback.print_exc()
        return respond(500, {"status": "error"})
