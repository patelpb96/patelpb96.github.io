#!/usr/bin/env python3
"""Attach/detach the live API to the existing patelpb.com CloudFront distribution.

The distribution is NOT managed by CDK, so this edits it in place via the AWS CLI,
preserving every other setting (aliases, cert, default behavior + viewer-request
function, custom error responses, the S3 origin + OAC). Idempotent.

    python infra/cloudfront_api.py attach   # add/refresh origins + /api/gateway/*, /api/newsroom/*, /api/* behaviors
    python infra/cloudfront_api.py detach   # remove them (run BEFORE `npx cdk destroy`)
    python infra/cloudfront_api.py status   # print what is attached
    python infra/cloudfront_api.py auth     # only republish the edge key checks (after a key or day-key change)

attach reads the Function URL domains and the Lambda OAC id from the CloudFormation
stack outputs (stack PatelpbLiveApi). All behaviors have: all methods allowed, managed
CachingDisabled cache policy, managed AllViewerExceptHostHeader origin request policy.
/api/* (RS refresh) has no function associations; the two authed behaviors (ordered first)
each have a viewer-request CloudFront Function that rejects requests whose key header doesn't
hash to an SSM value (so unauthenticated floods never reach Lambda):

    /api/gateway/*   patelpb-gateway-auth   x-gateway-key   /patelpb/gateway/writer-key-sha256
    /api/newsroom/*  patelpb-newsroom-auth  x-newsroom-key  /patelpb/newsroom/key-sha256

attach (re)publishes those functions from SSM, so after rotating a key just run attach (or auth) again.
The newsroom check also accepts an optional 24 h day key from /patelpb/newsroom/temp-sha256
("<sha256>:<expires epoch s>", written by `python -m newsdesk temp`, which then runs `auth`); the
expiry is baked into the function and checked against the clock at the edge.
The gateway is required (attach exits if its SSM value is missing); the newsroom is optional:
if its SSM value or stack output is missing it is skipped with a message, and any existing
newsroom behavior is left untouched. attach also seeds, when absent, live/gateway/{state,beat}.json
({"live":false}) and live/newsroom/{beat.json,inbox/index.json}.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

DIST_ID = os.environ.get("AWS_CF_DISTRIBUTION_ID", "EPJNH9PK97GV8")
STACK = os.environ.get("LIVE_API_STACK", "PatelpbLiveApi")
REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ.get("AWS_S3_BUCKET", "patelpb-com-site")
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

# Authed behaviors: edge function, key header, SSM param holding sha256(key).
AUTHS = {
    "gateway": {"function": "patelpb-gateway-auth", "header": "x-gateway-key", "path": "/api/gateway/*",
                "param": "/patelpb/gateway/writer-key-sha256", "required": True,
                "comment": "patelpb.com /api/gateway/* writer-key check",
                "setup": "run `npm run gateway` once and the `aws ssm put-parameter` command it prints"},
    "newsroom": {"function": "patelpb-newsroom-auth", "header": "x-newsroom-key", "path": "/api/newsroom/*",
                 "param": "/patelpb/newsroom/key-sha256", "required": False,
                 "temp_param": "/patelpb/newsroom/temp-sha256",
                 "comment": "patelpb.com /api/newsroom/* key check",
                 "setup": "run `python -m newsdesk setup` (agent-dashboard repo)"},
}

# Most specific first: CloudFront matches behaviors in list order.
ATTACHMENTS = [
    {"origin_id": "lambda-gateway", "path": "/api/gateway/*", "domain_output": "GatewayOriginDomain",
     "auth": "gateway"},
    {"origin_id": "lambda-newsroom", "path": "/api/newsroom/*", "domain_output": "NewsroomOriginDomain",
     "auth": "newsroom"},
    {"origin_id": "lambda-rs-refresh-trigger", "path": "/api/*", "domain_output": "TriggerOriginDomain",
     "auth": None},
]

# Seeded when absent, per auth name: bucket key -> document.
SEEDS = {
    "gateway": {"live/gateway/state.json": {"v": 1, "live": False, "seq": 1},
                "live/gateway/beat.json": {"v": 1, "live": False, "seq": 1, "beat": 0, "updated": None}},
    "newsroom": {"live/newsroom/beat.json": {"v": 1, "beat": 0, "busy": False, "version": None},
                 "live/newsroom/inbox/index.json": {"v": 1, "seq": 0, "ids": []}},
}

AUTH_CODE = """// Managed by infra/cloudfront_api.py (attach). Edge check for @PATH@.
var crypto = require('crypto');
var WANT = '@WANT@';
var DAY = '@DAY@';
var DAY_UNTIL = @UNTIL@;
function handler(event) {
  var h = event.request.headers['@HEADER@'];
  if (h && h.value) {
    var got = crypto.createHash('sha256').update(h.value).digest('hex');
    if (got === WANT || (DAY && got === DAY && Date.now() < DAY_UNTIL)) {
      return event.request;
    }
  }
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: {
      'content-type': { value: 'application/json; charset=utf-8' },
      'cache-control': { value: 'no-store' }
    },
    body: { encoding: 'text', data: '{"status":"error","error":"unauthorized"}' }
  };
}
"""


def auth_code(spec: dict, want: str, day: tuple[str, int] | None = None) -> str:
    """day = (sha256 of the day token, expires epoch seconds) or None."""
    digest, until = day if day else ("", 0)
    return (AUTH_CODE.replace("@PATH@", spec["path"]).replace("@HEADER@", spec["header"])
            .replace("@WANT@", want).replace("@DAY@", digest).replace("@UNTIL@", str(int(until) * 1000)))


def parse_day(value: str | None) -> tuple[str, int] | None:
    """'<sha256>:<expires epoch s>' -> (sha256, expires); None for 'none', garbage or missing."""
    digest, _, exp = (value or "").strip().lower().partition(":")
    if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest) or not exp.isdigit():
        return None
    return digest, int(exp)


def aws_exe() -> str:
    exe = shutil.which("aws")
    if exe:
        return exe
    for cand in (r"C:\Program Files\Amazon\AWSCLIV2\aws.exe", "/usr/local/bin/aws"):
        if os.path.exists(cand):
            return cand
    sys.exit("aws CLI not found")


def aws(*args: str, check: bool = True) -> dict:
    env = dict(os.environ, MSYS_NO_PATHCONV="1")  # keep "/api/*" intact under Git Bash
    r = subprocess.run([aws_exe(), *args, "--region", REGION, "--output", "json"],
                       check=check, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        return {"__error__": r.stderr}
    return json.loads(r.stdout) if r.stdout.strip() else {}


def stack_outputs() -> dict:
    s = aws("cloudformation", "describe-stacks", "--stack-name", STACK)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in s.get("Outputs", [])}


def origin(origin_id: str, domain: str, oac_id: str) -> dict:
    return {
        "Id": origin_id,
        "DomainName": domain,
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "https-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 30,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False},
        "OriginAccessControlId": oac_id,
    }


def behavior(path: str, origin_id: str, function_arn: str | None) -> dict:
    fns = {"Quantity": 0}
    if function_arn:
        fns = {"Quantity": 1, "Items": [{"FunctionARN": function_arn, "EventType": "viewer-request"}]}
    return {
        "PathPattern": path,
        "TargetOriginId": origin_id,
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
        },
        "SmoothStreaming": False,
        "Compress": False,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": fns,
        "FieldLevelEncryptionId": "",
        "CachePolicyId": CACHING_DISABLED,
        "OriginRequestPolicyId": ALL_VIEWER_EXCEPT_HOST,
    }


def set_items(container: dict, items: list) -> None:
    container["Quantity"] = len(items)
    if items:
        container["Items"] = items
    else:
        container.pop("Items", None)


def write_temp(text: str, suffix: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False, encoding="utf-8", newline="\n") as f:
        f.write(text)
        return f.name


def read_hash(spec: dict) -> str | None:
    """sha256(key) from SSM for an auth spec; None if the parameter doesn't exist."""
    p = aws("ssm", "get-parameter", "--name", spec["param"], check=False)
    if "__error__" in p:
        return None
    want = p["Parameter"]["Value"].strip().lower()
    if len(want) != 64 or any(c not in "0123456789abcdef" for c in want):
        sys.exit(f"{spec['param']} is not a hex SHA-256")
    return want


def read_day(spec: dict) -> tuple[str, int] | None:
    if not spec.get("temp_param"):
        return None
    p = aws("ssm", "get-parameter", "--name", spec["temp_param"], check=False)
    return None if "__error__" in p else parse_day(p["Parameter"]["Value"])


def publish_auth_function(spec: dict, want: str) -> str:
    """Create/update + publish the spec's edge function from the SSM hash(es); return its LIVE ARN."""
    name = spec["function"]
    code = auth_code(spec, want, read_day(spec))
    cfg = json.dumps({"Comment": spec["comment"], "Runtime": "cloudfront-js-2.0"})
    path = write_temp(code, ".js")
    try:
        cur = aws("cloudfront", "describe-function", "--name", name, "--stage", "DEVELOPMENT", check=False)
        if "__error__" in cur:
            r = aws("cloudfront", "create-function", "--name", name, "--function-config", cfg,
                    "--function-code", "fileb://" + path)
            etag = r["ETag"]
        else:
            if function_code(name, "LIVE") == code:
                print(f"{name}: up to date")
                return describe_live_arn(name)
            etag = cur["ETag"]
            if function_code(name, "DEVELOPMENT") != code:
                etag = aws("cloudfront", "update-function", "--name", name, "--if-match", etag,
                           "--function-config", cfg, "--function-code", "fileb://" + path)["ETag"]
        aws("cloudfront", "publish-function", "--name", name, "--if-match", etag)
        print(f"{name}: published")
        return describe_live_arn(name)
    finally:
        os.remove(path)


def function_code(name: str, stage: str) -> str | None:
    """An edge function's code at a stage (get-function writes it to an outfile); None if absent."""
    out = write_temp("", ".js")
    try:
        r = subprocess.run([aws_exe(), "cloudfront", "get-function", "--name", name, "--stage", stage,
                            "--region", REGION, out], capture_output=True)
        if r.returncode != 0:
            return None
        with open(out, encoding="utf-8") as f:
            return f.read()
    finally:
        os.remove(out)


def describe_live_arn(name: str) -> str:
    return aws("cloudfront", "describe-function", "--name", name, "--stage", "LIVE")[
        "FunctionSummary"]["FunctionMetadata"]["FunctionARN"]


def seed_live_files(auth: str) -> None:
    for key, doc in SEEDS[auth].items():
        if "__error__" not in aws("s3api", "head-object", "--bucket", BUCKET, "--key", key, check=False):
            continue
        path = write_temp(json.dumps(doc), ".json")
        try:
            aws("s3api", "put-object", "--bucket", BUCKET, "--key", key, "--body", path,
                "--content-type", "application/json; charset=utf-8", "--cache-control", "public, max-age=1")
        finally:
            os.remove(path)
        print(f"seeded s3://{BUCKET}/{key}")


def update(cfg: dict, etag: str) -> None:
    path = write_temp(json.dumps(cfg), ".json")
    try:
        aws("cloudfront", "update-distribution", "--id", DIST_ID, "--if-match", etag,
            "--distribution-config", "file://" + path)
    finally:
        os.remove(path)
    print("distribution updated; waiting for deployment ...", flush=True)
    subprocess.run([aws_exe(), "cloudfront", "wait", "distribution-deployed", "--id", DIST_ID],
                   check=True)
    print("deployed")


def matches(cur: dict | None, want: dict) -> bool:
    return cur is not None and all(cur.get(k) == v for k, v in want.items())


def select_attachments(out: dict, hashes: dict) -> tuple[list[dict], list[str]]:
    """Attachments attach can manage now, plus a printable reason per skipped one.

    An authed attachment needs its SSM hash; the optional ones (newsroom) are skipped, with
    their existing CloudFront config left alone, when that hash or the stack output is missing.
    """
    active, skipped = [], []
    for a in ATTACHMENTS:
        spec = AUTHS.get(a["auth"]) if a["auth"] else None
        if spec and not spec["required"]:
            if hashes.get(a["auth"]) is None:
                skipped.append(f"skipping {a['path']}: SSM {spec['param']} not found; {spec['setup']}, "
                               "then run attach again")
                continue
            if a["domain_output"] not in out:
                skipped.append(f"skipping {a['path']}: stack output {a['domain_output']} missing; "
                               "run `cd infra && npx cdk deploy`, then attach again")
                continue
        active.append(a)
    return active, skipped


def desired(active: list[dict], out: dict, fn_arns: dict) -> tuple[list[dict], list[dict]]:
    """(origins, behaviors) to install for the active attachments, behaviors in order."""
    origins = [origin(a["origin_id"], out[a["domain_output"]], out["OriginAccessControlId"]) for a in active]
    behaviors = [behavior(a["path"], a["origin_id"], fn_arns.get(a["auth"]) if a["auth"] else None)
                 for a in active]
    return origins, behaviors


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "auth":  # republish the key checks only; the behaviors keep pointing at LIVE
        for spec in AUTHS.values():
            want = read_hash(spec)
            if want is None:
                print(f"{spec['function']}: no {spec['param']}; skipped")
                continue
            publish_auth_function(spec, want)
        return
    d = aws("cloudfront", "get-distribution-config", "--id", DIST_ID)
    cfg, etag = d["DistributionConfig"], d["ETag"]
    all_o = cfg["Origins"].get("Items", [])
    all_b = cfg["CacheBehaviors"].get("Items", [])
    managed = ATTACHMENTS
    skipped: list[str] = []
    fn_arns: dict = {}
    want_o: list[dict] = []
    want_b: list[dict] = []

    if cmd == "attach":
        out = stack_outputs()
        hashes = {n: read_hash(s) for n, s in AUTHS.items()}
        if hashes["gateway"] is None:
            s = AUTHS["gateway"]
            sys.exit(f"SSM parameter {s['param']} not found; {s['setup']}, then attach again.")
        managed, skipped = select_attachments(out, hashes)
        for msg in skipped:
            print(msg)
        for a in managed:
            if a["auth"]:
                fn_arns[a["auth"]] = publish_auth_function(AUTHS[a["auth"]], hashes[a["auth"]])
                seed_live_files(a["auth"])
        want_o, want_b = desired(managed, out, fn_arns)

    ids = {a["origin_id"] for a in managed}
    paths = {a["path"] for a in managed}
    origins = [o for o in all_o if o["Id"] not in ids]
    behaviors = [b for b in all_b if b["PathPattern"] not in paths]
    cur_o = {o["Id"]: o for o in all_o if o["Id"] in ids}
    cur_b = {b["PathPattern"]: b for b in all_b if b["PathPattern"] in paths}

    if cmd == "status":
        print(json.dumps({"origins": list(cur_o.values()), "behaviors": list(cur_b.values())}, indent=1))
        return
    if cmd == "attach":
        order_ok = [b["PathPattern"] for b in all_b if b["PathPattern"] in paths] == [a["path"] for a in managed]
        if order_ok and all(matches(cur_o.get(o["Id"]), o) for o in want_o) \
                and all(matches(cur_b.get(b["PathPattern"]), b) for b in want_b):
            print("already attached; nothing to do")
            return
        set_items(cfg["Origins"], origins + want_o)
        set_items(cfg["CacheBehaviors"], want_b + behaviors)  # most specific first
    elif cmd == "detach":
        if not cur_o and not cur_b:
            print("not attached; nothing to do")
            return
        set_items(cfg["Origins"], origins)
        set_items(cfg["CacheBehaviors"], behaviors)
    else:
        sys.exit(__doc__)
    update(cfg, etag)


if __name__ == "__main__":
    main()
