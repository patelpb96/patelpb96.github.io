# patelpb.com live API (RS alchemy "Refresh live prices")

```
POST https://patelpb.com/api/rs/refresh
  -> CloudFront EPJNH9PK97GV8, behavior /api/* (CachingDisabled, AllViewerExceptHostHeader, no functions)
  -> Lambda OAC (sigv4, always) -> Function URL (AWS_IAM) of patelpb-rs-refresh-trigger
  -> cooldown check + S3 lock (PutObject If-None-Match: *) -> async invoke
  -> patelpb-rs-refresh-worker -> s3://patelpb-com-site/live/rs-alchemy/{latest,meta}.json
```

Code: `lambdas/rs_refresh/` (`trigger.py`, `worker.py`, shared `state.py`; stdlib + boto3).
Infra: this CDK app (stack `PatelpbLiveApi`, us-east-1): both Lambdas + IAM, the
CloudFront OAC, an EventBridge Scheduler schedule (worker daily 13:00 UTC,
`{"trigger":"schedule"}`), and the `patelpb-live-api` budget ($5/month; email at 80%
actual and 100% forecasted). The CloudFront distribution and the S3 bucket are not
managed here; `cloudfront_api.py` attaches/detaches the `/api/*` behavior.

## API contract

`POST /api/rs/refresh` (empty body; send
`x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
All responses JSON with `Cache-Control: no-store`:

| status | body |
|---|---|
| 202 | `{"status":"started","started_utc":...}` |
| 200 | `{"status":"running","started_utc":...}` (lock held, < 5 min old) |
| 200 | `{"status":"fresh","updated_utc":...,"next_allowed_utc":...}` (15 min cooldown from last successful run's start) |
| 405 | `{"status":"error","error":"method not allowed"}` (non-POST) |
| 400 | `{"status":"error","error":"unknown endpoint"}` (other `/api/*` paths) |
| 500 | `{"status":"error"}` |
| 429 | from Lambda when the account concurrency limit (10) is hit: retry later |

The API never returns 403/404 on purpose: the distribution's custom error responses
turn those into `/404.html` (so a broken OAC shows up as a 404 HTML page).

`live/rs-alchemy/latest.json` (same schema/sort as `rs-alchemy/data/latest.json`) and
`live/rs-alchemy/meta.json` are written with `Cache-Control: public, max-age=5`; no
invalidations needed. `scripts/deploy-aws.sh` excludes `live/*` from `--delete`.

## Deploy

```sh
export PATH="$PATH:/c/Program Files/Amazon/AWSCLIV2"   # Windows Git Bash
aws login --region us-east-1
cd infra && npm ci
npx cdk deploy                       # (first time per account/region: npx cdk bootstrap)
cd .. && python infra/cloudfront_api.py attach   # idempotent; waits for CloudFront
```

Run the worker by hand: `aws lambda invoke --region us-east-1 --function-name
patelpb-rs-refresh-worker --cli-binary-format raw-in-base64-out --payload
'{"trigger":"manual"}' out.json` (manual/schedule runs ignore the cooldown but respect the lock).

## Teardown

```sh
python infra/cloudfront_api.py detach   # FIRST: the OAC can't be deleted while in use
cd infra && npx cdk destroy
aws s3 rm --recursive s3://patelpb-com-site/live/rs-alchemy/   # optional: live data
```

# Scratch "gateway" (live, password-gated markdown)

```
local editor (npm run gateway, http://127.0.0.1:8737/)
  -- browser encrypts: PBKDF2-SHA256 310k -> AES-GCM-256, AAD "v|kid|seq" (src/gateway-crypto.js)
  -> scripts/gateway/server.mjs (adds x-gateway-key from ~/.patelpb-gateway-key; owns heartbeat + end)
  -> POST https://patelpb.com/api/gateway/{publish,beat,end}
  -> CloudFront behavior /api/gateway/* (ordered before /api/*): viewer-request CloudFront
     Function patelpb-gateway-auth (401 unless sha256(x-gateway-key) matches) -> Lambda OAC
  -> patelpb-gateway (re-checks the key against SSM /patelpb/gateway/writer-key-sha256, 60 s cache)
  -> s3://patelpb-com-site/live/gateway/{state,beat}.json (Cache-Control: public, max-age=1)
viewers: #/projects/scratch/gateway (src/Gateway.jsx) poll beat.json every 1 s via the default
  S3 behavior, fetch state.json when beat.seq moves, decrypt in the browser.
```

Neither AWS nor viewers without the password ever see the plaintext; `end` overwrites
`state.json` with `{"live":false}`. Liveness: the relay writes `beat.json` every 10 s while an
editor tab is connected and Live is on, and sends `end` on Stop, Ctrl+C, or 5 s after the last
editor tab closes; viewers also show "Not live" if `beat` hasn't changed for 30 s.

## API contract

`POST /api/gateway/publish` `{v:1, seq, kid, salt, iv, ct}`, `POST /api/gateway/beat` `{seq}`,
`POST /api/gateway/end` `{seq}`; header `x-gateway-key` and `x-amz-content-sha256` (hex SHA-256
of the body; required by the Lambda OAC). Responses JSON, `Cache-Control: no-store`: 200 ok,
400 bad request, 401 bad/missing key (from the edge or the Lambda), 405 non-POST, 409
`{"status":"stale","last_seq":...}`, 413 too large, 500. Never 403/404.

## Setup / deploy

```sh
npm run gateway -- --no-open     # first run creates ~/.patelpb-gateway-key and prints:
MSYS_NO_PATHCONV=1 aws ssm put-parameter --region us-east-1 --type String --overwrite \
  --name /patelpb/gateway/writer-key-sha256 --value "$(npm run -s gateway -- --print-hash)"
cd infra && npx cdk deploy && cd ..
python infra/cloudfront_api.py attach   # publishes patelpb-gateway-auth, seeds live/gateway/*, adds the behavior
npm run deploy:aws                      # the viewer page
```

Rotate the writer key: delete `~/.patelpb-gateway-key`, run `npm run gateway` once, re-run the
`put-parameter` command, then `python infra/cloudfront_api.py attach` (the edge function embeds
the hash; the Lambda picks up the new value within 60 s).

The account's Lambda concurrency limit is 10 (shared with `/api/rs/refresh`); the edge check
keeps unauthenticated traffic off it, but a quota increase (Service Quotas -> AWS Lambda ->
Concurrent executions) is free and worth requesting.

## Teardown

`detach` removes both `/api/*` behaviors and origins; the CloudFront Function is left in place
(`aws cloudfront delete-function --name patelpb-gateway-auth --if-match <etag>` after detach).
`aws s3 rm --recursive s3://patelpb-com-site/live/gateway/` removes the live files.

# Newsroom relay (private, password-gated news desk)

```
phone page (projects/newsroom/, src/NewsroomPage.jsx)   home daemon (agent-dashboard: python -m newsdesk)
  -- PBKDF2-SHA256 310k -> AES-GCM-256 envelopes --        -- same password-derived key, never stored --
  -> POST https://patelpb.com/api/newsroom/put  (header x-newsroom-key = token, {name, doc})
  -> CloudFront behavior /api/newsroom/* (ordered before /api/*): viewer-request CloudFront
     Function patelpb-newsroom-auth (401 unless sha256(x-newsroom-key) matches) -> Lambda OAC
  -> patelpb-newsroom (re-checks the key against SSM /patelpb/newsroom/key-sha256, 60 s cache;
     name allowlist + envelope validation; inbox puts also update inbox/index.json)
  -> s3://patelpb-com-site/live/newsroom/** (Cache-Control: public, max-age=1)
both sides read the same objects with plain GETs via the default S3 behavior (/live/newsroom/...).
```

AWS only ever stores ciphertext plus a few plain counters (`beat.json`, `inbox/index.json`);
the password never leaves the phone and the home machine's setup prompt.

Open mode (`python -m newsdesk open` / `close`, SSM /patelpb/newsroom/open-sha256) publishes a separate,
public key for a while: anyone can then send up to `limit` requests under `open/` (the Lambda lets that
key write nothing else) and read the editions they make. The master key is not involved.

## API contract

`POST /api/newsroom/put` `{name, doc}` with headers `x-newsroom-key` and `x-amz-content-sha256`
(hex SHA-256 of the body; required by the Lambda OAC). Allowed names, envelope format, the
beat/inbox-index rules and every object's plaintext shape are in
[`projects/newsroom/PROTOCOL.md`](../projects/newsroom/PROTOCOL.md). Responses JSON,
`Cache-Control: no-store`: 200 `{"status":"ok"}`, 400 bad request, 401 bad/missing key (from the
edge or the Lambda), 405 non-POST, 409 open rid reused, 413 body over 900 KB (8 KB for the open
key), 429 open limit used up, 500. Never 403/404.

## Setup / deploy

Order matters: the SSM parameter must exist before `attach` publishes the edge function.

```sh
# 1. Home side (agent-dashboard repo): prompts for the password (refuses weak ones), writes the
#    SSM hash /patelpb/newsroom/key-sha256 and live/newsroom/config.json {v, salt, iter}.
python -m newsdesk setup
# 2. Lambda + Function URL + IAM (the gateway stack, now with patelpb-newsroom).
cd infra && npx cdk deploy && cd ..
# 3. Publishes patelpb-newsroom-auth, seeds live/newsroom/{beat,inbox/index}.json, adds the behavior.
python infra/cloudfront_api.py attach
# 4. The phone page.
npm run deploy:aws
```

If the newsroom SSM parameter or stack output is missing, `attach` still handles the gateway and
`/api/*`, prints why the newsroom was skipped, and leaves any existing newsroom behavior alone.

Offline checks: `python -m unittest discover lambdas/newsroom` (handler, boto3 stubbed) and
`python -m unittest discover infra -p "test_*.py"` (CloudFront config building).

## Rotate the password / key

Run `python -m newsdesk setup` again (new salt, new token, new SSM hash), then
`python infra/cloudfront_api.py attach` (the edge function embeds the hash; the Lambda picks up the
new value within 60 s). Old ciphertext no longer decrypts, so the phone and daemon must both use
the new password; previously stored editions are unreadable.

## Teardown

`python infra/cloudfront_api.py detach` first (removes all attached origins and behaviors, the
gateway's and RS refresh's too), then `cd infra && npx cdk destroy`. The CloudFront Function is
left in place (`aws cloudfront delete-function --name patelpb-newsroom-auth --if-match <etag>`);
`aws ssm delete-parameter --name /patelpb/newsroom/key-sha256` and
`aws s3 rm --recursive s3://patelpb-com-site/live/newsroom/` remove the key hash and the data.

# Search (password-gated Exa search at /search/)

```
page (search/index.html, src/SearchPage.jsx)
  -- x-search-key = hex(PBKDF2-SHA256(password, salt, 310k)) from live/search/config.json {v, salt, iter},
     or the device key enrolled once on Preet's PC (localStorage, via /search/#device=<token>) --
  -> POST https://patelpb.com/api/search/{whoami,search,agent,run}
  -> CloudFront behavior /api/search/* (ordered before /api/*, 60 s origin read timeout): viewer-request
     CloudFront Function patelpb-search-auth (401 unless sha256(key) is the password's or the device's)
  -> Lambda OAC -> patelpb-search (re-checks against SSM, 60 s cache) -> api.exa.ai /search, /agent/runs
```

The Exa API key is an SSM SecureString (`/patelpb/search/exa-api-key`) read only by the Lambda; the browser
never sees it. Password callers are capped (25 results, agent effort `auto` with a $2 budget, $3/day shared,
counted in `/patelpb/search/spend` from Exa's `costDollars`); the device key is uncapped. Also set a
spending limit in the Exa dashboard: that is the only hard cap.

## API contract

`POST /api/search/whoami` `{}`, `.../search` `{request: <Exa SearchRequest>}`, `.../agent`
`{request: <Exa CreateAgentRunRequest>}`, `.../run` `{id}`; headers `x-search-key` and
`x-amz-content-sha256`. 200 `{status:"ok", role, exa:<Exa response>}`; 400 (ours, or Exa's message),
401, 405, 413, 429 (daily cap or Exa rate limit), 502 (other Exa errors), 503 (Exa key not set), 500.
Never 403/404.

## Setup / deploy

```sh
python infra/search_setup.py exa-key      # prompts for the Exa API key (SecureString)
python infra/search_setup.py password     # prompts for the shared password; writes the hash + config.json
python infra/search_setup.py device       # this PC: key in ~/.patelpb-search-device-key, opens the enrol link
cd infra && npx cdk deploy && cd ..       # patelpb-search
python infra/cloudfront_api.py attach     # publishes patelpb-search-auth, adds /api/search/*
npm run deploy:aws                        # the page
```

After changing the password or device key run `python infra/cloudfront_api.py auth`. Enrol another browser on
the PC by running `device` again (it reuses the key). `python infra/search_setup.py status` shows what is set.
Offline checks: `python -m unittest discover lambdas/search`.

## Teardown

`python infra/cloudfront_api.py detach` (removes every attached behavior), `cd infra && npx cdk destroy`,
then `aws ssm delete-parameters --names /patelpb/search/key-sha256 /patelpb/search/device-sha256
/patelpb/search/exa-api-key /patelpb/search/spend` and `aws s3 rm s3://patelpb-com-site/live/search/config.json`.
