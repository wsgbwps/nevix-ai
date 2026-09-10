#!/usr/bin/env bash
set -euo pipefail

required=(
  NEVIX_OSS_SMOKE_REGION
  NEVIX_OSS_SMOKE_BUCKET
  NEVIX_OSS_SMOKE_ACCESS_KEY_ID
  NEVIX_OSS_SMOKE_SECRET_ACCESS_KEY
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "error: missing $name" >&2
    exit 1
  fi
done

cd "$(dirname "${BASH_SOURCE[0]}")/../server"
adapter_version="$(go list -m -f '{{.Version}}' github.com/aliyun/alibabacloud-oss-go-sdk-v2)"
NEVIX_OSS_SMOKE_REQUESTED=1 \
  NEVIX_OBJECT_STORAGE_ADAPTER_VERSION="$adapter_version" \
  go test -tags=cloudsmoke ./internal/creation/infrastructure/storage -run '^TestOSSRealSmoke$' -count=1 -v
