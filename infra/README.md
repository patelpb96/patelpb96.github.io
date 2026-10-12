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
