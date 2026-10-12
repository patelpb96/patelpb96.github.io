#!/usr/bin/env bash
# Build the site and deploy it to S3 + CloudFront (https://patelpb.com).
#
# Env vars (defaults are the live values):
#   AWS_S3_BUCKET            target bucket            (patelpb-com-site)
#   AWS_CF_DISTRIBUTION_ID   CloudFront distribution  (see default below)
#   AWS_REGION               bucket region            (us-east-1)
#   SKIP_BUILD=1             deploy the existing dist/ without rebuilding
#   SKIP_INVALIDATION=1      skip the CloudFront invalidation
#   DRYRUN=1                 pass --dryrun to every s3 sync (implies SKIP_INVALIDATION)
#
# Requires the AWS CLI v2 and credentials (e.g. `aws login --region us-east-1`).
set -euo pipefail

BUCKET="${AWS_S3_BUCKET:-patelpb-com-site}"
DIST_ID="${AWS_CF_DISTRIBUTION_ID:-EPJNH9PK97GV8}"
REGION="${AWS_REGION:-us-east-1}"
DIST_DIR="dist"

# Windows: the AWS CLI installer does not always put aws on PATH for Git Bash.
if ! command -v aws >/dev/null 2>&1; then
  export PATH="$PATH:/c/Program Files/Amazon/AWSCLIV2"
fi

cd "$(dirname "$0")/.."

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build
fi
[ -f "$DIST_DIR/index.html" ] || { echo "error: $DIST_DIR/index.html missing" >&2; exit 1; }

DRY=(--only-show-errors)
if [ "${DRYRUN:-0}" = "1" ]; then
  DRY=(--dryrun)
  SKIP_INVALIDATION=1
fi

LONG="public, max-age=31536000, immutable"
SHORT="public, max-age=300"
# Vite's content-hashed build output, e.g. assets/index-VYs1IqtC.js. Unhashed
# files copied from public/assets (e.g. Resume_public.pdf) don't match this.
HASHED="assets/*-????????.*"

# Explicit content types so uploads don't depend on the OS mime database
# (Windows' registry otherwise decides, and .parquet/.md have no good default).
TYPES=(
  "html:text/html; charset=utf-8"
  "js:text/javascript; charset=utf-8"
  "mjs:text/javascript; charset=utf-8"
  "css:text/css; charset=utf-8"
  "json:application/json; charset=utf-8"
  "md:text/markdown; charset=utf-8"
  "csv:text/csv; charset=utf-8"
  "txt:text/plain; charset=utf-8"
  "svg:image/svg+xml"
  "png:image/png"
  "jpg:image/jpeg"
  "jpeg:image/jpeg"
  "gif:image/gif"
  "webp:image/webp"
  "ico:image/x-icon"
  "mp4:video/mp4"
  "webm:video/webm"
  "pdf:application/pdf"
  "parquet:application/octet-stream"
  "woff2:font/woff2"
)

# live/ is written at runtime by the refresh Lambda (infra/), not by the build. The trailing
# exclude wins over every include above it, so --delete never removes the live data.
sync() { aws s3 sync "$DIST_DIR" "s3://$BUCKET" --region "$REGION" --delete "${DRY[@]}" "$@" --exclude "live/*"; }

# Filters excluding every listed extension, for the catch-all syncs.
HASHED_KNOWN=(); OTHER_KNOWN=()
for entry in "${TYPES[@]}"; do
  HASHED_KNOWN+=(--exclude "assets/*-????????.${entry%%:*}")
  OTHER_KNOWN+=(--exclude "*.${entry%%:*}")
done

# Each sync only considers (and --delete only removes) keys matching its
# filters, so together the passes cover the whole bucket exactly once.
echo "==> pass 1: hashed assets (immutable)"
for entry in "${TYPES[@]}"; do
  ext="${entry%%:*}"; ctype="${entry#*:}"
  sync --exclude "*" --include "assets/*-????????.$ext" \
       --cache-control "$LONG" --content-type "$ctype"
done
sync --exclude "*" --include "$HASHED" "${HASHED_KNOWN[@]}" --cache-control "$LONG"

echo "==> pass 2: everything else (5 min cache)"
for entry in "${TYPES[@]}"; do
  ext="${entry%%:*}"; ctype="${entry#*:}"
  sync --exclude "*" --include "*.$ext" --exclude "$HASHED" \
       --cache-control "$SHORT" --content-type "$ctype"
done
# Catch-all for any extension not listed above (content type guessed by the CLI).
sync --exclude "$HASHED" "${OTHER_KNOWN[@]}" --cache-control "$SHORT"

if [ "${SKIP_INVALIDATION:-0}" != "1" ]; then
  echo "==> invalidating CloudFront $DIST_ID"
  aws cloudfront create-invalidation --region "$REGION" --distribution-id "$DIST_ID" --paths "/*" \
    --query 'Invalidation.[Id,Status]' --output text
fi

echo "==> done: https://patelpb.com"
