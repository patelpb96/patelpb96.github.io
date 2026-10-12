#!/usr/bin/env python3
"""Attach/detach the live API to the existing patelpb.com CloudFront distribution.

The distribution is NOT managed by CDK, so this edits it in place via the AWS CLI,
preserving every other setting (aliases, cert, default behavior + viewer-request
function, custom error responses, the S3 origin + OAC). Idempotent.

    python infra/cloudfront_api.py attach   # add/refresh origins + /api/gateway/* and /api/* behaviors
    python infra/cloudfront_api.py detach   # remove them (run BEFORE `npx cdk destroy`)
    python infra/cloudfront_api.py status   # print what is attached

attach reads the Function URL domains and the Lambda OAC id from the CloudFormation
stack outputs (stack PatelpbLiveApi). Both behaviors have: all methods allowed, managed
CachingDisabled cache policy, managed AllViewerExceptHostHeader origin request policy.
/api/* (RS refresh) has no function associations; /api/gateway/* (ordered first) has the
viewer-request CloudFront Function patelpb-gateway-auth, which rejects requests whose
x-gateway-key doesn't hash to the SSM value /patelpb/gateway/writer-key-sha256 (so
unauthenticated floods never reach Lambda). attach (re)publishes that function from SSM,
so after rotating the writer key just run attach again. attach also seeds
live/gateway/{state,beat}.json with {"live":false} when they don't exist yet.
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
AUTH_FUNCTION = "patelpb-gateway-auth"
KEY_HASH_PARAM = "/patelpb/gateway/writer-key-sha256"

# Most specific first: CloudFront matches behaviors in list order.
ATTACHMENTS = [
    {"origin_id": "lambda-gateway", "path": "/api/gateway/*", "domain_output": "GatewayOriginDomain",
     "auth": True},
    {"origin_id": "lambda-rs-refresh-trigger", "path": "/api/*", "domain_output": "TriggerOriginDomain",
     "auth": False},
]

AUTH_CODE = """// Managed by infra/cloudfront_api.py (attach). Edge check for /api/gateway/*.
var crypto = require('crypto');
var WANT = '%s';
function handler(event) {
  var h = event.request.headers['x-gateway-key'];
  if (h && h.value && crypto.createHash('sha256').update(h.value).digest('hex') === WANT) {
    return event.request;
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


def publish_auth_function() -> str:
    """Create/update + publish patelpb-gateway-auth from the SSM hash; return its LIVE ARN."""
    p = aws("ssm", "get-parameter", "--name", KEY_HASH_PARAM, check=False)
    if "__error__" in p:
        sys.exit(f"SSM parameter {KEY_HASH_PARAM} not found; run `npm run gateway` once and the "
                 "`aws ssm put-parameter` command it prints, then attach again.")
    want = p["Parameter"]["Value"].strip().lower()
    if len(want) != 64 or any(c not in "0123456789abcdef" for c in want):
        sys.exit(f"{KEY_HASH_PARAM} is not a hex SHA-256")
    code = AUTH_CODE % want
    cfg = json.dumps({"Comment": "patelpb.com /api/gateway/* writer-key check", "Runtime": "cloudfront-js-2.0"})
    path = write_temp(code, ".js")
    try:
        cur = aws("cloudfront", "describe-function", "--name", AUTH_FUNCTION, "--stage", "DEVELOPMENT",
                  check=False)
        if "__error__" in cur:
            r = aws("cloudfront", "create-function", "--name", AUTH_FUNCTION, "--function-config", cfg,
                    "--function-code", "fileb://" + path)
            etag = r["ETag"]
        else:
            if function_code("LIVE") == code:
                print(f"{AUTH_FUNCTION}: up to date")
                return describe_live_arn()
            etag = cur["ETag"]
            if function_code("DEVELOPMENT") != code:
                etag = aws("cloudfront", "update-function", "--name", AUTH_FUNCTION, "--if-match", etag,
                           "--function-config", cfg, "--function-code", "fileb://" + path)["ETag"]
        aws("cloudfront", "publish-function", "--name", AUTH_FUNCTION, "--if-match", etag)
        print(f"{AUTH_FUNCTION}: published")
        return describe_live_arn()
    finally:
        os.remove(path)


def function_code(stage: str) -> str | None:
    """The auth function's code at a stage (get-function writes it to an outfile); None if absent."""
    out = write_temp("", ".js")
    try:
        r = subprocess.run([aws_exe(), "cloudfront", "get-function", "--name", AUTH_FUNCTION, "--stage", stage,
                            "--region", REGION, out], capture_output=True)
        if r.returncode != 0:
            return None
        with open(out, encoding="utf-8") as f:
            return f.read()
    finally:
        os.remove(out)


def describe_live_arn() -> str:
    return aws("cloudfront", "describe-function", "--name", AUTH_FUNCTION, "--stage", "LIVE")[
        "FunctionSummary"]["FunctionMetadata"]["FunctionARN"]


def seed_live_files() -> None:
    for name, doc in (("state.json", {"v": 1, "live": False, "seq": 1}),
                      ("beat.json", {"v": 1, "live": False, "seq": 1, "beat": 0, "updated": None})):
        key = f"live/gateway/{name}"
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


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    d = aws("cloudfront", "get-distribution-config", "--id", DIST_ID)
    cfg, etag = d["DistributionConfig"], d["ETag"]
    ids = {a["origin_id"] for a in ATTACHMENTS}
    paths = {a["path"] for a in ATTACHMENTS}
    all_o = cfg["Origins"].get("Items", [])
    all_b = cfg["CacheBehaviors"].get("Items", [])
    origins = [o for o in all_o if o["Id"] not in ids]
    behaviors = [b for b in all_b if b["PathPattern"] not in paths]
    cur_o = {o["Id"]: o for o in all_o if o["Id"] in ids}
    cur_b = {b["PathPattern"]: b for b in all_b if b["PathPattern"] in paths}

    if cmd == "status":
        print(json.dumps({"origins": list(cur_o.values()), "behaviors": list(cur_b.values())}, indent=1))
        return
    if cmd == "attach":
        out = stack_outputs()
        fn_arn = publish_auth_function()
        seed_live_files()
        want_o = [origin(a["origin_id"], out[a["domain_output"]], out["OriginAccessControlId"])
                  for a in ATTACHMENTS]
        want_b = [behavior(a["path"], a["origin_id"], fn_arn if a["auth"] else None) for a in ATTACHMENTS]
        order_ok = [b["PathPattern"] for b in all_b if b["PathPattern"] in paths] == [a["path"] for a in ATTACHMENTS]
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
