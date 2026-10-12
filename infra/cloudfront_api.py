#!/usr/bin/env python3
"""Attach/detach the live API to the existing patelpb.com CloudFront distribution.

The distribution is NOT managed by CDK, so this edits it in place via the AWS CLI,
preserving every other setting (aliases, cert, default behavior + viewer-request
function, custom error responses, the S3 origin + OAC). Idempotent.

    python infra/cloudfront_api.py attach   # add/refresh origin + /api/* behavior
    python infra/cloudfront_api.py detach   # remove them (run BEFORE `npx cdk destroy`)
    python infra/cloudfront_api.py status   # print what is attached

attach reads the trigger Function URL domain and the Lambda OAC id from the
CloudFormation stack outputs (stack PatelpbLiveApi). The /api/* behavior has:
all methods allowed, managed CachingDisabled cache policy, managed
AllViewerExceptHostHeader origin request policy, and NO function associations (the
site's viewer-request function stays on the default behavior only).
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
ORIGIN_ID = "lambda-rs-refresh-trigger"
PATH_PATTERN = "/api/*"
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"


def aws_exe() -> str:
    exe = shutil.which("aws")
    if exe:
        return exe
    for cand in (r"C:\Program Files\Amazon\AWSCLIV2\aws.exe", "/usr/local/bin/aws"):
        if os.path.exists(cand):
            return cand
    sys.exit("aws CLI not found")


def aws(*args: str) -> dict:
    env = dict(os.environ, MSYS_NO_PATHCONV="1")  # keep "/api/*" intact under Git Bash
    out = subprocess.run([aws_exe(), *args, "--region", REGION, "--output", "json"],
                         check=True, capture_output=True, text=True, env=env).stdout
    return json.loads(out) if out.strip() else {}


def stack_outputs() -> dict:
    s = aws("cloudformation", "describe-stacks", "--stack-name", STACK)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in s.get("Outputs", [])}


def origin(domain: str, oac_id: str) -> dict:
    return {
        "Id": ORIGIN_ID,
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


def behavior() -> dict:
    return {
        "PathPattern": PATH_PATTERN,
        "TargetOriginId": ORIGIN_ID,
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
        "FunctionAssociations": {"Quantity": 0},
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


def update(cfg: dict, etag: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(cfg, f)
        path = f.name
    try:
        aws("cloudfront", "update-distribution", "--id", DIST_ID, "--if-match", etag,
            "--distribution-config", "file://" + path)
    finally:
        os.remove(path)
    print("distribution updated; waiting for deployment ...", flush=True)
    subprocess.run([aws_exe(), "cloudfront", "wait", "distribution-deployed", "--id", DIST_ID],
                   check=True)
    print("deployed")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    d = aws("cloudfront", "get-distribution-config", "--id", DIST_ID)
    cfg, etag = d["DistributionConfig"], d["ETag"]
    origins = [o for o in cfg["Origins"].get("Items", []) if o["Id"] != ORIGIN_ID]
    behaviors = [b for b in cfg["CacheBehaviors"].get("Items", []) if b["PathPattern"] != PATH_PATTERN]
    cur_o = [o for o in cfg["Origins"].get("Items", []) if o["Id"] == ORIGIN_ID]
    cur_b = [b for b in cfg["CacheBehaviors"].get("Items", []) if b["PathPattern"] == PATH_PATTERN]

    if cmd == "status":
        print(json.dumps({"origin": cur_o, "behavior": cur_b}, indent=1))
        return
    if cmd == "attach":
        out = stack_outputs()
        want_o = origin(out["TriggerOriginDomain"], out["OriginAccessControlId"])
        want_b = behavior()
        if cur_o and cur_b and all(cur_o[0].get(k) == v for k, v in want_o.items()) \
                and all(cur_b[0].get(k) == v for k, v in want_b.items()):
            print("already attached; nothing to do")
            return
        set_items(cfg["Origins"], origins + [want_o])
        set_items(cfg["CacheBehaviors"], [want_b] + behaviors)  # most specific first
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
