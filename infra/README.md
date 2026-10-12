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
