#!/usr/bin/env bash
set -euo pipefail

required=(
  NEVIX_COS_SMOKE_REGION
  NEVIX_COS_SMOKE_BUCKET
  NEVIX_COS_SMOKE_SECRET_ID
  NEVIX_COS_SMOKE_SECRET_KEY
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "error: missing $name" >&2
    exit 1
  fi
done

cd "$(dirname "${BASH_SOURCE[0]}")/../server"
NEVIX_COS_SMOKE_REQUESTED=1 go test -tags=cloudsmoke ./internal/creation/infrastructure/storage -run '^TestCOSRealSmoke$' -count=1 -v
