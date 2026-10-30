#!/usr/bin/env python3
"""One-time setup for the password-gated Exa search page (patelpb.com/search/).

    python infra/search_setup.py password   # prompt for the shared password -> SSM hash + live/search/config.json
    python infra/search_setup.py device     # enrol THIS PC: device key -> SSM hash, opens the enrolment link
    python infra/search_setup.py exa-key    # prompt for the Exa API key -> SSM SecureString
    python infra/search_setup.py status     # which pieces exist (never prints secrets)

After `password` or `device`, run `python infra/cloudfront_api.py auth` (or `attach` the first
time) so the edge check picks up the new hash; the Lambda re-reads SSM within 60 s.

Keys (all us-east-1 SSM):
    /patelpb/search/key-sha256     sha256(hex(PBKDF2-SHA256(password, salt, 310000, 32 bytes)))
    /patelpb/search/device-sha256  sha256(device token); the token stays in ~/.patelpb-search-device-key
    /patelpb/search/exa-api-key    SecureString (aws/ssm key)
Public: s3://patelpb-com-site/live/search/config.json {v, salt, iter}, which the page needs to
derive the same token from the password. Nothing secret is printed or passed on a command line.
"""
from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import re
import secrets
import sys
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cloudfront_api import BUCKET, aws, write_temp  # noqa: E402

KEY_PARAM = "/patelpb/search/key-sha256"
DEVICE_PARAM = "/patelpb/search/device-sha256"
EXA_PARAM = "/patelpb/search/exa-api-key"
CONFIG_KEY = "live/search/config.json"
ITER = 310_000
DEVICE_FILE = os.path.join(os.path.expanduser("~"), ".patelpb-search-device-key")
PAGE = "https://patelpb.com/search/"


def put_param(name: str, value: str, secure: bool = False) -> None:
    """Value goes through a temp JSON file (deleted after), not argv."""
    doc = {"Name": name, "Value": value, "Type": "SecureString" if secure else "String", "Overwrite": True}
    path = write_temp(json.dumps(doc), ".json")
    try:
        r = aws("ssm", "put-parameter", "--cli-input-json", "file://" + path, check=False)
    finally:
        os.remove(path)
    if "__error__" in r:
        sys.exit(f"put-parameter {name} failed: {r['__error__'].strip()}")


def token_for(password: str, salt_b64: str, iterations: int = ITER) -> str:
    """Same derivation as the page (src/search-crypto.js): hex of 32 PBKDF2-SHA256 bytes."""
    return hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), iterations, 32).hex()


def cmd_password() -> None:
    pw = getpass.getpass("Shared search password (12+ characters): ")
    if len(pw) < 12:
        sys.exit("too short: use at least 12 characters (it's the only thing between strangers and your Exa credits)")
    if getpass.getpass("Again: ") != pw:
        sys.exit("passwords don't match")
    salt = base64.b64encode(os.urandom(16)).decode()
    digest = hashlib.sha256(token_for(pw, salt).encode()).hexdigest()
    put_param(KEY_PARAM, digest)
    path = write_temp(json.dumps({"v": 1, "salt": salt, "iter": ITER}), ".json")
    try:
        r = aws("s3api", "put-object", "--bucket", BUCKET, "--key", CONFIG_KEY, "--body", path,
                "--content-type", "application/json; charset=utf-8", "--cache-control", "public, max-age=60",
                check=False)
    finally:
        os.remove(path)
    if "__error__" in r:
        sys.exit(f"writing {CONFIG_KEY} failed: {r['__error__'].strip()}")
    print(f"password set ({KEY_PARAM}, s3://{BUCKET}/{CONFIG_KEY}).")
    print("now run: python infra/cloudfront_api.py auth")


def cmd_device() -> None:
    if os.path.exists(DEVICE_FILE):
        with open(DEVICE_FILE, encoding="utf-8") as f:
            token = f.read().strip()
        print(f"using the existing device key in {DEVICE_FILE}")
    else:
        token = secrets.token_hex(32)
        with open(DEVICE_FILE, "w", encoding="utf-8") as f:
            f.write(token + "\n")
        print(f"created {DEVICE_FILE}")
    put_param(DEVICE_PARAM, hashlib.sha256(token.encode()).hexdigest())
    print(f"device hash stored in {DEVICE_PARAM}")
    if "--no-open" not in sys.argv:
        # The page saves the key in this browser's localStorage and strips it from the address bar.
        webbrowser.open(f"{PAGE}#device={token}")
        print("opened the enrolment link in your default browser (repeat with `device` for another browser)")
    print("if the edge check doesn't know this key yet, run: python infra/cloudfront_api.py auth")


def cmd_exa_key() -> None:
    key = getpass.getpass("Exa API key (from dashboard.exa.ai -> API keys): ").strip()
    if len(key) < 16:
        sys.exit("that doesn't look like an Exa API key")
    # The prompt hides what was pasted, so describe it (never echo it) before storing.
    if not re.fullmatch(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", key):
        print(f"That's {len(key)} characters and doesn't look like an Exa key "
              "(they're 36-character IDs: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).")
        if input("Store it anyway? [y/N] ").strip().lower() != "y":
            sys.exit("nothing stored; copy the key again from dashboard.exa.ai and retry")
    put_param(EXA_PARAM, key, secure=True)
    print(f"stored {len(key)} characters ending in ...{key[-4:]} as a SecureString in {EXA_PARAM}; "
          "the Lambda picks it up within 60 s")


def cmd_status() -> None:
    for name in (KEY_PARAM, DEVICE_PARAM, EXA_PARAM):
        r = aws("ssm", "describe-parameters", "--parameter-filters", f"Key=Name,Values={name}")
        found = r.get("Parameters") or []
        print(f"{name:34} {'set (' + found[0]['LastModifiedDate'][:10] + ')' if found else 'missing'}")
    r = aws("s3api", "head-object", "--bucket", BUCKET, "--key", CONFIG_KEY, check=False)
    print(f"{CONFIG_KEY:34} {'missing' if '__error__' in r else 'present'}")
    print(f"{'device key file':34} {'present' if os.path.exists(DEVICE_FILE) else 'missing'} ({DEVICE_FILE})")


def main() -> None:
    cmds = {"password": cmd_password, "device": cmd_device, "exa-key": cmd_exa_key, "status": cmd_status}
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in cmds and len(cmd) >= 16:
        # Looks like a pasted secret: never echo it, and say how to pass it safely.
        sys.exit("That looks like a key, not a command. Nothing was stored.\n"
                 "Run `python infra/search_setup.py exa-key` and paste the key when it asks.\n"
                 "The key is now in your shell history; rotate it in the Exa dashboard if that matters.")
    if cmd not in cmds:
        sys.exit(__doc__)
    cmds[cmd]()


if __name__ == "__main__":
    main()
