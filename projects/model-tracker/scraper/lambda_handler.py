"""AWS Lambda entry point: one scheduled run (EventBridge Scheduler every 6 hours, retries 0).

The run itself is scraper.run.run, unchanged. This module only moves state between a private S3 bucket and /tmp:

  s3://<STATE_BUCKET>/state/hits.csv, runs.csv, candidates.csv   the ledgers (downloaded, appended, uploaded)
  s3://<STATE_BUCKET>/state/locks/<slot>.lock                    one per slot, created with If-None-Match: *
  s3://<STATE_BUCKET>/state/spend/<day>.json                     uploaded after EVERY reservation, so a crash over-counts
  s3://<STATE_BUCKET>/state/raw/YYYY/MM/DD/<run_id>.jsonl         raw Exa requests and responses (private, never published)
  s3://<STATE_BUCKET>/state/KILL                                 kill switch: if this object exists, nothing runs
  s3://<STATE_BUCKET>/state/aa/YYYY/MM/DD/<slot>.json            Artificial Analysis reference snapshot (one free GET per run)

Secrets come from SSM at call time and are never logged: the Exa key (EXA_KEY_PARAM, required) and the TypeSafe key
for the Jev judges (TYPESAFE_KEY_PARAM, optional: missing means the judges are off). Nothing here writes to the
public site bucket; candidates still need `python -m scraper.review` before they reach the page.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import aa_source
from . import budget as budget_mod
from . import exa_client, fetch, jev
from . import run as run_mod

PREFIX = "state/"
LEDGERS = ["hits.csv", "runs.csv", "candidates.csv"]


class S3State:
    """Mirror of a few keys under state/ in a local folder. `s3` is a boto3 S3 client (or a fake in tests)."""

    def __init__(self, s3, bucket: str, local: Path):
        self.s3, self.bucket, self.local = s3, bucket, Path(local)

    def _missing(self, e) -> bool:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
        return code in {"NoSuchKey", "404", "NotFound"}

    def get(self, rel: str) -> bool:
        dest = self.local / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            body = self.s3.get_object(Bucket=self.bucket, Key=PREFIX + rel)["Body"].read()
        except Exception as e:                                   # botocore ClientError; only "not there" is expected
            if self._missing(e):
                return False
            raise
        dest.write_bytes(body)
        return True

    def put(self, rel: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=PREFIX + rel, Body=(self.local / rel).read_bytes())

    def put_if_absent(self, rel: str) -> bool:
        try:
            self.s3.put_object(Bucket=self.bucket, Key=PREFIX + rel, Body=b"", IfNoneMatch="*")
            return True
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
            if code in {"PreconditionFailed", "ConditionalRequestConflict", "412"}:
                return False
            raise

    def keys(self, rel_prefix: str) -> list[str]:
        out, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": PREFIX + rel_prefix}
            if token:
                kw["ContinuationToken"] = token
            page = self.s3.list_objects_v2(**kw)
            out += [o["Key"][len(PREFIX):] for o in page.get("Contents", [])]
            if not page.get("IsTruncated"):
                return out
            token = page.get("NextContinuationToken")


def budget_class(state: S3State):
    class S3Budget(budget_mod.Budget):
        def start_run(self, slot: str) -> None:
            super().start_run(slot)                              # kill switch, day check, runs-per-day, local lock
            if not state.put_if_absent(f"locks/{slot}.lock"):    # the real lock: atomic in S3, so two invocations can't both run
                raise budget_mod.RunRefused(f"slot {slot} already ran (S3 lock); runs are never retried")

        def _write_spend(self, usd: float) -> None:
            super()._write_spend(usd)
            state.put(f"spend/{self.day}.json")
    return S3Budget


def pull(state: S3State, day: str) -> None:
    for rel in LEDGERS + ["KILL", f"spend/{day}.json"]:
        state.get(rel)
    for rel in state.keys(f"locks/{day}"):                       # so the runs-per-day count sees earlier runs today
        state.get(rel)


def push(state: S3State) -> list[str]:
    sent = []
    for rel in LEDGERS:
        if (state.local / rel).exists():
            state.put(rel)
            sent.append(rel)
    for p in sorted((state.local / "raw").rglob("*.jsonl")):    # nothing under raw/ is downloaded, so all of it is new
        rel = p.relative_to(state.local).as_posix()
        state.put(rel)
        sent.append(rel)
    return sent


def _param(ssm, name: str | None, required: bool) -> str | None:
    if not name:
        return None
    try:
        return ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except Exception as e:
        if not required and type(e).__name__ == "ParameterNotFound":
            return None
        raise RuntimeError(f"could not read SSM parameter {name}: {type(e).__name__}") from None   # never the value


def aa_snapshot(state: S3State, now: datetime, slot: str, caps: dict, tracked: set[str], html: str | None = None) -> dict:
    """Rescan the reference source and keep its observations privately. Never fatal: the news run stands alone."""
    try:
        recs = aa_source.records(html if html is not None else aa_source.fetch_html(caps["aa"]["url"]))
        chosen = aa_source.select(recs, caps["aa"]["min_index"], tracked)
        obs = aa_source.observations(chosen, now.strftime("%Y-%m-%d"))
        rel = f"aa/{now:%Y/%m/%d}/{slot}.json"
        (state.local / rel).parent.mkdir(parents=True, exist_ok=True)
        (state.local / rel).write_text(json.dumps({"slot": slot, "records": len(recs), **obs}), encoding="utf-8")
        state.put(rel)
        return {"status": "ok", "records": len(recs), "tracked": len(chosen), "key": rel}
    except Exception as e:                                          # layout change, timeout: report, don't fail the run
        return {"status": "error", "error": f"{type(e).__name__}: {str(e)[:200]}"}


def run_once(now: datetime, s3, ssm, env: dict, params: dict | None = None, exa=None, pages=None, aa_html=None) -> dict:
    day, slot = now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%dT%H")
    work = Path(tempfile.mkdtemp(prefix=f"mt-{slot}-"))
    try:
        state = S3State(s3, env["STATE_BUCKET"], work)
        pull(state, day)
        params = params or run_mod.load_params()
        site = s3.get_object(Bucket=env["SITE_BUCKET"], Key=env["MODELS_KEY"])["Body"].read()
        models = json.loads(site)["models"]
        if exa is None:
            exa = exa_client.LiveExa(key=_param(ssm, env["EXA_KEY_PARAM"], required=True))
        tkey = _param(ssm, env.get("TYPESAFE_KEY_PARAM"), required=False)
        judges = jev.make_judges({jev.KEY_ENV: tkey} if tkey else {}, params["caps"])
        try:
            res = run_mod.run(slot, now, work, params, models, exa, pages or fetch.LivePages(),
                              triage_judge=judges.triage if judges else None,
                              injection_judge=judges.injection if judges else None, budget_cls=budget_class(state))
        except budget_mod.RunRefused as e:
            return {"status": "refused", "slot": slot, "reason": str(e)}
        uploaded = push(state)
        aa = aa_snapshot(state, now, slot, params["caps"], {m["model_id"] for m in models}, aa_html)
        summary = {k: v for k, v in res.items() if k not in {"hits", "candidate_rows"}}
        return {"status": "ok", **summary, "jev": judges.summary() if judges else "off", "aa": aa, "uploaded": uploaded}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def handler(event, context):
    import boto3                                                  # in the Lambda runtime; not needed for tests

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    out = run_once(now, boto3.client("s3"), boto3.client("ssm"), dict(os.environ))
    print(json.dumps(out, default=str))                          # CloudWatch: counts and statuses, no keys, no page text
    return out
